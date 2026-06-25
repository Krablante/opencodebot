import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { durationMs, logErrorEvent, logInfo, logWarn, shouldLogSlow } from "./logger.mjs"

export class TelegramClient {
  constructor(token) {
    this.token = token
    this.baseURL = `https://api.telegram.org/bot${token}`
    this.fileBaseURL = `https://api.telegram.org/file/bot${token}`
  }

  async request(method, payload = {}, attempt = 0, options = {}) {
    const startedAt = Date.now()
    let response
    let data = {}
    try {
      response = await fetch(`${this.baseURL}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: options.signal,
      })
      data = await response.json().catch(() => ({}))
    } catch (error) {
      logErrorEvent("telegram.request.error", error, { method, attempt, durationMs: durationMs(startedAt), ...telegramPayloadSummary(payload) })
      throw error
    }
    const elapsedMs = durationMs(startedAt)
    const retryAfter = data?.parameters?.retry_after
    if (response.status === 429 && Number.isFinite(retryAfter) && attempt < 3) {
      logWarn("telegram.request.retry", { method, attempt, status: response.status, retryAfterSec: retryAfter, durationMs: elapsedMs, ...telegramPayloadSummary(payload) })
      await delay((retryAfter + 1) * 1000, options.signal)
      return this.request(method, payload, attempt + 1, options)
    }
    if (!response.ok || data.ok === false) {
      const error = new Error(`Telegram ${method} failed: ${data.description || response.status}`)
      if (!options.suppressFailureLog) logErrorEvent("telegram.request.failed", error, { method, attempt, status: response.status, durationMs: elapsedMs, ...telegramPayloadSummary(payload) })
      throw error
    }
    if (shouldLogTelegramSlow(method, elapsedMs)) logInfo("telegram.request.slow", { method, attempt, durationMs: elapsedMs, ...telegramPayloadSummary(payload) })
    return data.result
  }

  async deleteWebhook() {
    return this.request("deleteWebhook", { drop_pending_updates: false })
  }

  async getMe() {
    return this.request("getMe")
  }

  async setMyCommands(commands, options = {}) {
    return this.request("setMyCommands", { commands, ...options })
  }

  async getFile(fileId) {
    return this.request("getFile", { file_id: fileId })
  }

  async downloadFile({ fileId, destination, maxBytes }) {
    const file = await this.getFile(fileId)
    if (file.file_size && file.file_size > maxBytes) {
      throw new Error(`Telegram file is too large (${file.file_size} bytes; max ${maxBytes})`)
    }
    if (!file.file_path) throw new Error("Telegram getFile did not return file_path")
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    const response = await fetch(`${this.fileBaseURL}/${file.file_path}`)
    if (!response.ok || !response.body) throw new Error(`Telegram file download failed: ${response.status}`)
    const contentLength = Number(response.headers.get("content-length") || 0)
    if (contentLength && contentLength > maxBytes) throw new Error(`Telegram file download is too large (${contentLength} bytes; max ${maxBytes})`)
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { mode: 0o600 }))
    const stat = await fsp.stat(destination)
    if (stat.size > maxBytes) {
      await fsp.rm(destination, { force: true })
      throw new Error(`Telegram file download exceeded limit (${stat.size} bytes; max ${maxBytes})`)
    }
    return { file, destination }
  }

  async getUpdates(offset, timeout = 25, options = {}) {
    return this.request("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message"],
    }, 0, options)
  }

  async sendMessage({ chatId, topicId, text, disablePreview = true, format = "html", replyMarkup }) {
    const payload = {
      chat_id: chatId,
      disable_web_page_preview: disablePreview,
    }
    applyTextFormat(payload, text, format)
    if (topicId) payload.message_thread_id = topicId
    if (replyMarkup) payload.reply_markup = replyMarkup
    return this.request("sendMessage", payload)
  }

  async sendPhoto({ chatId, topicId, file, caption, captionFormat }) {
    return this.sendMultipartFile("sendPhoto", "photo", { chatId, topicId, file, caption, captionFormat })
  }

  async sendDocument({ chatId, topicId, file, caption, captionFormat }) {
    return this.sendMultipartFile("sendDocument", "document", { chatId, topicId, file, caption, captionFormat })
  }

  async sendMultipartFile(method, fileField, { chatId, topicId, file, caption, captionFormat }) {
    return this.requestMultipart(method, () => {
      const form = new FormData()
      form.append("chat_id", String(chatId))
      if (topicId) form.append("message_thread_id", String(topicId))
      if (caption) form.append("caption", String(caption))
      if (captionFormat === "html") form.append("parse_mode", "HTML")
      if (captionFormat === "markdownv2") form.append("parse_mode", "MarkdownV2")
      form.append(fileField, new Blob([file.bytes], { type: file.contentType || "application/octet-stream" }), file.filename || "artifact")
      return form
    }, {
      chatId,
      topicId,
      captionChars: typeof caption === "string" ? caption.length : undefined,
      filename: file.filename,
      bytes: file.bytes?.length,
    })
  }

  async requestMultipart(method, buildForm, summary = {}, attempt = 0) {
    const startedAt = Date.now()
    let response
    let data = {}
    try {
      response = await fetch(`${this.baseURL}/${method}`, { method: "POST", body: buildForm() })
      data = await response.json().catch(() => ({}))
    } catch (error) {
      logErrorEvent("telegram.request.error", error, { method, attempt, durationMs: durationMs(startedAt), ...summary })
      throw error
    }
    const elapsedMs = durationMs(startedAt)
    const retryAfter = data?.parameters?.retry_after
    if (response.status === 429 && Number.isFinite(retryAfter) && attempt < 3) {
      logWarn("telegram.request.retry", { method, attempt, status: response.status, retryAfterSec: retryAfter, durationMs: elapsedMs, ...summary })
      await delay((retryAfter + 1) * 1000)
      return this.requestMultipart(method, buildForm, summary, attempt + 1)
    }
    if (!response.ok || data.ok === false) {
      const error = new Error(`Telegram ${method} failed: ${data.description || response.status}`)
      logErrorEvent("telegram.request.failed", error, { method, attempt, status: response.status, durationMs: elapsedMs, ...summary })
      throw error
    }
    if (shouldLogTelegramSlow(method, elapsedMs)) logInfo("telegram.request.slow", { method, attempt, durationMs: elapsedMs, ...summary })
    return data.result
  }

  async sendRichMessage({ chatId, topicId, markdown, html, skipEntityDetection = false }) {
    const payload = {
      chat_id: chatId,
      rich_message: richMessagePayload({ markdown, html, skipEntityDetection }),
    }
    if (topicId) payload.message_thread_id = topicId
    return this.request("sendRichMessage", payload)
  }

  async editMessageText({ chatId, messageId, text, format = "html" }) {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      disable_web_page_preview: true,
    }
    applyTextFormat(payload, text, format)
    return this.request("editMessageText", payload)
  }

  async editRichMessage({ chatId, messageId, markdown, html, skipEntityDetection = false }) {
    return this.request("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      rich_message: richMessagePayload({ markdown, html, skipEntityDetection }),
    })
  }

  async pinChatMessage({ chatId, messageId, disableNotification = false }) {
    return this.request("pinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: disableNotification,
    })
  }

  async deleteMessage({ chatId, messageId, suppressFailureLog = false }) {
    return this.request("deleteMessage", { chat_id: chatId, message_id: messageId }, 0, { suppressFailureLog })
  }

  async createForumTopic({ chatId, name, iconCustomEmojiId }) {
    const payload = { chat_id: chatId, name: safeTopicName(name) }
    if (iconCustomEmojiId) payload.icon_custom_emoji_id = iconCustomEmojiId
    return this.request("createForumTopic", payload)
  }

  async editForumTopic({ chatId, topicId, name }) {
    return this.request("editForumTopic", { chat_id: chatId, message_thread_id: topicId, name: safeTopicName(name) })
  }

  async getForumTopicIconStickers() {
    return this.request("getForumTopicIconStickers")
  }
}

export function isAllowedMessage(message, config) {
  const fromID = message?.from?.id
  return Number.isSafeInteger(fromID) && config.telegram.allowedUserIds.includes(fromID)
}

export function messageText(message) {
  return message?.text || message?.caption || ""
}

export function topicId(message) {
  return message?.message_thread_id || 0
}

export function telegramMessageLink(chatId, messageId) {
  if (!chatId || !messageId) return ""
  const value = String(chatId)
  if (value.startsWith("-100")) return `https://t.me/c/${value.slice(4)}/${messageId}`
  return ""
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

export function clampTelegram(text, max = 3900) {
  const value = String(text ?? "")
  if (value.length <= max) return value
  return `${value.slice(0, max - 40)}\n\n...truncated in Telegram mirror...`
}

export function clampTelegramRichMarkdown(text, max = 32000) {
  const value = String(text ?? "")
  if (value.length <= max) return value
  return `${value.slice(0, max - 48)}\n\n...truncated in Telegram rich mirror...`
}

function applyTextFormat(payload, text, format) {
  payload.text = text
  if (format === "html") payload.parse_mode = "HTML"
  if (format === "markdownv2") payload.parse_mode = "MarkdownV2"
}

function richMessagePayload({ markdown, html, skipEntityDetection }) {
  const richMessage = html !== undefined ? { html: String(html ?? "") } : { markdown: String(markdown ?? "") }
  if (skipEntityDetection) richMessage.skip_entity_detection = true
  return richMessage
}

function safeTopicName(name) {
  const cleaned = String(name || "OpenCodez")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.slice(0, 128) || "OpenCodez"
}

function telegramPayloadSummary(payload = {}) {
  const rich = payload.rich_message || {}
  return {
    chatId: payload.chat_id,
    topicId: payload.message_thread_id,
    messageId: payload.message_id,
    textChars: typeof payload.text === "string" ? payload.text.length : undefined,
    htmlChars: typeof rich.html === "string" ? rich.html.length : undefined,
    markdownChars: typeof rich.markdown === "string" ? rich.markdown.length : undefined,
  }
}

function shouldLogTelegramSlow(method, elapsedMs) {
  if (method === "getUpdates") return false
  return shouldLogSlow(elapsedMs)
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    function done() {
      signal?.removeEventListener?.("abort", onAbort)
      resolve()
    }
    signal?.addEventListener?.("abort", onAbort, { once: true })
  })
}

function abortError() {
  const error = new Error("aborted")
  error.name = "AbortError"
  return error
}
