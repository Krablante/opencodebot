import { cleanupFiles, downloadTelegramFiles, extractTelegramFiles } from "../attachments.mjs"
import { logErrorEvent, logInfo } from "../logger.mjs"
import { escapeHtml, topicId } from "../telegram.mjs"
import { GroqSpeechClient } from "./groq-client.mjs"
import { OpenRouterSpeechClient } from "./openrouter-client.mjs"

export class SpeechModule {
  constructor({ config, telegram, state, uploadDir, attachmentSettings, env = process.env, clients = null }) {
    this.config = config
    this.telegram = telegram
    this.state = state
    this.uploadDir = uploadDir
    this.attachmentSettings = { ...attachmentSettings, maxFileBytes: config.maxFileBytes, maxInlineBytes: config.maxFileBytes }
    this.clients = clients || {
      openrouter: new OpenRouterSpeechClient(config.providers.openrouter, env),
      groq: new GroqSpeechClient(config.providers.groq, env),
    }
    this.queue = []
    this.active = 0
  }

  enabled() {
    return Boolean(this.config.enabled)
  }

  configured() {
    return this.enabled() && this.models().length > 0
  }

  isSoundsTopic(message) {
    return this.state.isSoundsTopic(message.chat.id, topicId(message))
  }

  async handleMessage(message) {
    if (!this.configured() || !this.isSoundsTopic(message)) return false

    return this.enqueueAudioMessage(message)
  }

  async handleVoiceMessage(message) {
    if (!this.configured() || !message?.voice) return false

    return this.enqueueAudioMessage(message)
  }

  async enqueueAudioMessage(message) {
    const files = audioDescriptors(message)
    if (!files.length) return false
    const job = { message, descriptors: files }
    this.queue.push(job)
    this.drain()
    return true
  }

  async setCurrentTopic(message) {
    const previous = this.state.soundsTopic()
    const previousMenuMessageId = this.state.soundsMenuMessageId()
    const nextTopicId = topicId(message)
    if (previousMenuMessageId && previous && (String(previous.chatId) !== String(message.chat.id) || Number(previous.topicId) !== Number(nextTopicId))) {
      await this.telegram.deleteMessage({ chatId: previous.chatId, messageId: previousMenuMessageId }).catch((error) => logErrorEvent("speech.menu.cleanup.failed", error, { chatId: previous.chatId, messageId: previousMenuMessageId }))
    }
    return this.state.setSoundsTopic({
      chatId: message.chat.id,
      topicId: nextTopicId,
      title: message.forum_topic_created?.name || message.chat.title || "Sounds topic",
      setBy: message.from?.id,
    })
  }

  async clearCurrentTopic(message) {
    const current = this.state.soundsTopic()
    const menuMessageId = this.state.soundsMenuMessageId()
    const cleared = await this.state.clearSoundsTopic(message.chat.id, topicId(message))
    if (cleared && current && menuMessageId) {
      await this.telegram.deleteMessage({ chatId: current.chatId, messageId: menuMessageId }).catch((error) => logErrorEvent("speech.menu.cleanup.failed", error, { chatId: current.chatId, messageId: menuMessageId }))
    }
    return cleared
  }

  status() {
    const model = this.selectedModel()
    return {
      enabled: this.enabled(),
      configured: this.configured(),
      topic: this.state.soundsTopic(),
      queueDepth: this.queue.length,
      active: this.active,
      model: model?.id || null,
      modelLabel: model?.label || null,
      modelProvider: model?.provider || null,
      models: this.models(),
      language: model?.language ?? "auto",
      apiKeyEnv: model ? this.config.providers[model.apiProvider]?.apiKeyEnv : null,
      providers: Object.values(this.config.providers).map((provider) => ({
        id: provider.id,
        label: provider.label,
        apiKeyEnv: provider.apiKeyEnv,
        configured: this.clientConfigured(provider.id),
      })),
    }
  }

  models() {
    return this.config.models.filter((model) => this.clientConfigured(model.apiProvider))
  }

  clientConfigured(providerId) {
    const client = this.clients[providerId]
    return Boolean(client && client.isConfigured())
  }

  selectedModel() {
    const models = this.models()
    const defaultModelId = models.some((model) => model.id === this.config.defaultModel) ? this.config.defaultModel : models[0]?.id
    const selected = this.state.speechModelId?.(defaultModelId) || defaultModelId
    return models.find((model) => model.id === selected) || models[0] || this.config.models[0] || null
  }

  async createOrRefreshMenu({ chatId, topicId: currentTopicId, messageId = null } = {}) {
    const topic = this.state.soundsTopic()
    const targetChatId = chatId || topic?.chatId
    const targetTopicId = currentTopicId ?? topic?.topicId
    if (!targetChatId) throw new Error("Sounds topic is not configured")
    const text = this.menuText()
    const replyMarkup = this.menuMarkup()
    const existingMessageId = messageId || this.state.soundsMenuMessageId()
    if (existingMessageId) {
      try {
        await this.telegram.editMessageText({ chatId: targetChatId, messageId: existingMessageId, text, replyMarkup })
        await this.state.setSoundsMenuMessageId(existingMessageId)
        return { message_id: existingMessageId }
      } catch (error) {
        if (/message is not modified/i.test(String(error?.message || error))) {
          await this.state.setSoundsMenuMessageId(existingMessageId)
          return { message_id: existingMessageId }
        }
        logErrorEvent("speech.menu.edit.failed", error, { chatId: targetChatId, topicId: targetTopicId, messageId: existingMessageId })
      }
    }
    const sent = await this.telegram.sendMessage({ chatId: targetChatId, topicId: targetTopicId, text, replyMarkup })
    await this.state.setSoundsMenuMessageId(sent?.message_id)
    if (sent?.message_id) await this.telegram.pinChatMessage({ chatId: targetChatId, messageId: sent.message_id, disableNotification: true }).catch((error) => logErrorEvent("speech.menu.pin.failed", error, { chatId: targetChatId, messageId: sent.message_id }))
    return sent
  }

  async handleCallbackQuery(query) {
    const data = String(query?.data || "")
    if (!data.startsWith("sounds:")) return false
    const message = query.message || {}
    const chatId = message.chat?.id
    const currentTopicId = message.message_thread_id || 0
    try {
      if (data === "sounds:refresh") {
        await this.createOrRefreshMenu({ chatId, topicId: currentTopicId, messageId: message.message_id })
        await this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "Sounds menu refreshed" })
        return true
      }
      const modelId = decodeURIComponent(data.slice("sounds:model:".length))
      const model = this.models().find((item) => item.id === modelId)
      if (!model) {
        await this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "Model is no longer configured", showAlert: true })
        await this.createOrRefreshMenu({ chatId, topicId: currentTopicId, messageId: message.message_id })
        return true
      }
      await this.state.setSpeechModelId(model.id)
      await this.createOrRefreshMenu({ chatId, topicId: currentTopicId, messageId: message.message_id })
      await this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: `STT model: ${model.label}` })
      return true
    } catch (error) {
      logErrorEvent("speech.menu.callback.failed", error, { chatId, topicId: currentTopicId, data })
      await this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "Failed to update sounds menu", showAlert: true }).catch(() => {})
      return true
    }
  }

  menuText() {
    const model = this.selectedModel()
    if (!model) return "🎙 <b>Audio transcription model</b>\nNo configured STT models."
    const parts = [
      "🎙 <b>Audio transcription model</b>",
      `Current: <code>${escapeHtml(model.label)}</code>${model.provider ? ` · ${escapeHtml(model.provider)}` : ""}`,
    ]
    if (model.price) parts.push(`Price: <code>${escapeHtml(model.price)}</code>`)
    parts.push("Use buttons below to switch model. Refresh updates this menu after config changes.")
    return parts.join("\n")
  }

  menuMarkup() {
    const selected = this.selectedModel()?.id
    const rows = this.models().map((model) => [{
      text: `${model.id === selected ? "✓ " : ""}${model.label}${model.provider ? ` · ${model.provider}` : ""}`,
      callback_data: `sounds:model:${encodeURIComponent(model.id)}`,
    }])
    rows.push([{ text: "↻ Refresh", callback_data: "sounds:refresh" }])
    return { inline_keyboard: rows }
  }

  drain() {
    while (this.active < this.config.queueConcurrency && this.queue.length) {
      const job = this.queue.shift()
      this.active += 1
      this.runJob(job)
        .catch((error) => logErrorEvent("speech.job.failed", error, { chatId: job.message.chat.id, topicId: topicId(job.message) }))
        .finally(() => {
          this.active -= 1
          this.drain()
        })
    }
  }

  async runJob({ message, descriptors }) {
    const chatId = message.chat.id
    const currentTopicId = topicId(message)
    const model = this.selectedModel()
    const client = model ? this.clients[model.apiProvider] : null
    if (!model || !client?.isConfigured()) {
      await this.telegram.replyMessage({
        chatId,
        topicId: currentTopicId,
        replyToMessageId: message.message_id,
        text: "Speech module is enabled but no configured STT provider is available.",
      })
      return
    }
    const status = await this.telegram.replyMessage({
      chatId,
      topicId: currentTopicId,
      replyToMessageId: message.message_id,
      text: escapeHtml(this.config.statusMessage),
    })
    let downloads = []
    let transcriptionComplete = false
    let transcriptParts = []
    const startedAt = Date.now()
    try {
      downloads = await downloadTelegramFiles(this.telegram, descriptors, this.uploadDir, this.attachmentSettings)
      const file = downloads[0]
      const result = await client.transcribeFile(file, model)
      const elapsedMs = Date.now() - startedAt
      logInfo("speech.transcribed", {
        chatId,
        topicId: currentTopicId,
        model: result.model,
        modelLabel: model.label,
        modelProvider: model.provider,
        format: result.format,
        elapsedMs,
        bytes: file.size,
        chars: result.text.length,
      })
      transcriptionComplete = true
      transcriptParts = transcriptMessages(result.text, result.modelProfile?.label || result.model, elapsedMs)
      await deliverTranscriptMessages({
        telegram: this.telegram,
        chatId,
        topicId: currentTopicId,
        replyToMessageId: message.message_id,
        statusMessageId: status?.message_id,
        messages: transcriptParts,
      })
    } catch (error) {
      if (transcriptionComplete) {
        const delivered = error.deliveredParts || 0
        logErrorEvent("speech.transcript.delivery.failed", error, {
          chatId,
          topicId: currentTopicId,
          deliveredParts: delivered,
          totalParts: transcriptParts.length,
        })
        if (delivered) {
          await this.telegram.replyMessage({
            chatId,
            topicId: currentTopicId,
            replyToMessageId: message.message_id,
            text: `Transcript delivery stopped after ${delivered}/${transcriptParts.length} parts. Retry the voice message to receive the complete text.`,
          }).catch(() => {})
        } else {
          await this.telegram.editMessageText({
            chatId,
            messageId: status?.message_id,
            text: `Speech transcript delivery failed.\n<code>${escapeHtml(error.message)}</code>`,
          }).catch(() => {})
        }
      } else {
        logErrorEvent("speech.transcription.failed", error, { chatId, topicId: currentTopicId })
        await this.telegram.editMessageText({
          chatId,
          messageId: status?.message_id,
          text: `Speech transcription failed.\n<code>${escapeHtml(error.message)}</code>`,
        }).catch(() => {})
      }
    } finally {
      await cleanupFiles(downloads)
    }
  }
}

function audioDescriptors(message) {
  return extractTelegramFiles(message).filter((file) => file.kind === "voice" || file.kind === "audio" || isAudioDocument(file))
}

function isAudioDocument(file) {
  return file.kind === "document" && String(file.mime || "").toLowerCase().startsWith("audio/")
}

export function transcriptMessages(text, model, elapsedMs) {
  const footer = `\n\n${escapeHtml(model)} · ${Math.round(elapsedMs)}ms`
  const bodyBudget = 4096 - "<code></code>".length - footer.length
  if (bodyBudget < 1) throw new Error("Speech transcript footer exceeds the Telegram message limit")
  const chunks = splitTranscriptText(String(text || ""), bodyBudget)
  return chunks.map((chunk, index) => {
    const suffix = index === chunks.length - 1 ? footer : ""
    return `<code>${escapeHtml(chunk)}</code>${suffix}`
  })
}

export async function deliverTranscriptMessages({ telegram, chatId, topicId: currentTopicId, replyToMessageId, statusMessageId, messages }) {
  let deliveredParts = 0
  try {
    await telegram.editMessageText({ chatId, messageId: statusMessageId, text: messages[0] })
    deliveredParts = 1
    for (const text of messages.slice(1)) {
      await telegram.replyMessage({ chatId, topicId: currentTopicId, replyToMessageId, text })
      deliveredParts += 1
    }
    return deliveredParts
  } catch (error) {
    error.deliveredParts = deliveredParts
    throw error
  }
}

function splitTranscriptText(text, maxEscapedChars) {
  if (!text) return [""]
  const chunks = []
  let start = 0
  while (start < text.length) {
    let index = start
    let escapedChars = 0
    let lastLineBreak = -1
    while (index < text.length) {
      const codePoint = text.codePointAt(index)
      const character = String.fromCodePoint(codePoint)
      const width = escapedHtmlChars(character)
      if (escapedChars + width > maxEscapedChars) break
      escapedChars += width
      index += character.length
      if (character === "\n") lastLineBreak = index
    }
    if (index === text.length) {
      chunks.push(text.slice(start))
      break
    }
    const midpoint = start + Math.floor((index - start) / 2)
    const end = lastLineBreak > midpoint ? lastLineBreak : index
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

function escapedHtmlChars(character) {
  if (character === "&") return 5
  if (character === "<" || character === ">") return 4
  return character.length
}
