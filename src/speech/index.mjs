import { cleanupFiles, downloadTelegramFiles, extractTelegramFiles } from "../attachments.mjs"
import { logErrorEvent, logInfo } from "../logger.mjs"
import { clampTelegram, escapeHtml, topicId } from "../telegram.mjs"
import { OpenRouterSpeechClient } from "./openrouter-client.mjs"

export class SpeechModule {
  constructor({ config, telegram, state, uploadDir, attachmentSettings, env = process.env }) {
    this.config = config
    this.telegram = telegram
    this.state = state
    this.uploadDir = uploadDir
    this.attachmentSettings = { ...attachmentSettings, maxFileBytes: config.maxFileBytes, maxInlineBytes: config.maxFileBytes }
    this.client = new OpenRouterSpeechClient(config.openrouter, env)
    this.queue = []
    this.active = 0
  }

  enabled() {
    return Boolean(this.config.enabled)
  }

  configured() {
    return this.enabled() && this.client.isConfigured()
  }

  isSoundsTopic(message) {
    return this.state.isSoundsTopic(message.chat.id, topicId(message))
  }

  async handleMessage(message) {
    if (!this.enabled() || !this.isSoundsTopic(message)) return false
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
      model: model.id,
      modelLabel: model.label,
      modelProvider: model.provider,
      models: this.models(),
      language: this.config.openrouter.language ?? "auto",
      apiKeyEnv: this.config.openrouter.apiKeyEnv,
    }
  }

  models() {
    return this.config.openrouter.models?.length ? this.config.openrouter.models : [{ id: this.config.openrouter.model, label: this.config.openrouter.model, provider: "", price: "" }]
  }

  selectedModel() {
    const models = this.models()
    const defaultModelId = models[0]?.id || this.config.openrouter.model
    const selected = this.state.speechModelId?.(defaultModelId) || defaultModelId
    return models.find((model) => model.id === selected) || models[0]
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
    const parts = [
      "🎙 <b>Audio transcription model</b>",
      `Current: <code>${escapeHtml(model.label)}</code>${model.provider ? ` · ${escapeHtml(model.provider)}` : ""}`,
    ]
    if (model.price) parts.push(`Price: <code>${escapeHtml(model.price)}</code>`)
    parts.push("Use buttons below to switch model. Refresh updates this menu after config changes.")
    return parts.join("\n")
  }

  menuMarkup() {
    const selected = this.selectedModel().id
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
    if (!this.client.isConfigured()) {
      await this.telegram.replyMessage({
        chatId,
        topicId: currentTopicId,
        replyToMessageId: message.message_id,
        text: `Speech module is enabled but <code>${escapeHtml(this.config.openrouter.apiKeyEnv)}</code> is not set.`,
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
    const startedAt = Date.now()
    try {
      downloads = await downloadTelegramFiles(this.telegram, descriptors, this.uploadDir, this.attachmentSettings)
      const file = downloads[0]
      const model = this.selectedModel()
      const result = await this.client.transcribeFile(file, model)
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
      await this.telegram.editMessageText({
        chatId,
        messageId: status?.message_id,
        text: transcriptMessage(result.text, result.modelProfile?.label || result.model, elapsedMs),
      })
    } catch (error) {
      logErrorEvent("speech.transcription.failed", error, { chatId, topicId: currentTopicId })
      await this.telegram.editMessageText({
        chatId,
        messageId: status?.message_id,
        text: `Speech transcription failed.\n<code>${escapeHtml(error.message)}</code>`,
      }).catch(() => {})
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

export function transcriptMessage(text, model, elapsedMs) {
  const body = escapeHtml(fitTranscriptBlock(text))
  return `<code>${body}</code>\n\n${escapeHtml(model)} · ${Math.round(elapsedMs)}ms`
}

function fitTranscriptBlock(text) {
  const raw = String(text || "")
  let limit = 3400
  let body = clampTelegram(raw, limit)
  while (escapeHtml(body).length > 3700 && limit > 200) {
    limit = Math.max(200, Math.floor(limit * 0.8))
    body = clampTelegram(raw, limit)
  }
  return body
}
