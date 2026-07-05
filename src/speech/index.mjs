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
    return this.state.setSoundsTopic({
      chatId: message.chat.id,
      topicId: topicId(message),
      title: message.forum_topic_created?.name || message.chat.title || "Sounds topic",
      setBy: message.from?.id,
    })
  }

  async clearCurrentTopic(message) {
    return this.state.clearSoundsTopic(message.chat.id, topicId(message))
  }

  status() {
    return {
      enabled: this.enabled(),
      configured: this.configured(),
      topic: this.state.soundsTopic(),
      queueDepth: this.queue.length,
      active: this.active,
      model: this.config.openrouter.model,
      language: this.config.openrouter.language,
      apiKeyEnv: this.config.openrouter.apiKeyEnv,
    }
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
      const result = await this.client.transcribeFile(file)
      const elapsedMs = Date.now() - startedAt
      logInfo("speech.transcribed", {
        chatId,
        topicId: currentTopicId,
        model: result.model,
        format: result.format,
        elapsedMs,
        bytes: file.size,
        chars: result.text.length,
      })
      await this.telegram.editMessageText({
        chatId,
        messageId: status?.message_id,
        text: transcriptMessage(result.text, result.model, elapsedMs),
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

function transcriptMessage(text, model, elapsedMs) {
  const body = clampTelegram(escapeHtml(text), 3600)
  return `${body}\n\n<code>${escapeHtml(model)}</code> · <code>${Math.round(elapsedMs)}ms</code>`
}
