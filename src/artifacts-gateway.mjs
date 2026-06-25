import { createServer } from "node:http"
import { timingSafeEqual } from "node:crypto"
import path from "node:path"

import { durationMs, logErrorEvent, logInfo, logWarn } from "./logger.mjs"
import { escapeMarkdownV2, toolQuoteMarkdownV2 } from "./rich-markdown.mjs"
import { escapeHtml, telegramMessageLink } from "./telegram.mjs"

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"])
const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024

export function startArtifactGateway({ config, state, telegram, signal }) {
  if (!config.artifacts?.enabled) return null
  const server = createServer(async (request, response) => {
    const startedAt = Date.now()
    try {
      if (!isAuthorized(request, config.artifacts.token)) {
        sendJson(response, 401, { ok: false, error: "unauthorized" })
        return
      }
      if (request.method === "GET" && request.url === "/artifacts/status") {
        const target = state.artifactsTopic()
        sendJson(response, 200, { ok: true, configured: Boolean(target), target: safeTarget(target) })
        return
      }
      if (request.method !== "POST" || request.url !== "/artifacts/send") {
        sendJson(response, 404, { ok: false, error: "not_found" })
        return
      }
      const target = state.artifactsTopic()
      if (!target) {
        sendJson(response, 409, { ok: false, error: "artifacts_topic_not_configured" })
        return
      }
      const payload = await readJsonBody(request, config.artifacts.maxPayloadBytes)
      const result = await sendArtifact({ config, telegram, target, payload })
      logInfo("artifacts.sent", {
        durationMs: durationMs(startedAt),
        sourceHost: payload?.source?.host,
        sourceProject: payload?.source?.project,
        messages: result.messages.length,
      })
      sendJson(response, 200, { ok: true, target: safeTarget(target), ...result })
    } catch (error) {
      logErrorEvent("artifacts.request.failed", error, { durationMs: durationMs(startedAt) })
      sendJson(response, statusForError(error), { ok: false, error: error.publicCode || "artifact_send_failed", message: error.publicMessage || error.message })
    }
  })

  server.listen(config.artifacts.port, config.artifacts.listenHost, () => {
    logInfo("artifacts.gateway.started", { host: config.artifacts.listenHost, port: config.artifacts.port })
  })
  if (signal) signal.addEventListener("abort", () => server.close(), { once: true })
  return server
}

async function sendArtifact({ config, telegram, target, payload }) {
  const mode = normalizeMode(payload?.mode)
  const caption = clampText(String(payload?.caption || "Agent artifact").trim(), config.artifacts.maxCaptionChars)
  const captionPaths = payload?.captionPaths
  const messages = []
  if (payload?.file) {
    if (mode === "text") throw publicError("invalid_text_file_mode", "Send file content as text instead of file when mode is text.", 400)
    const file = fileFromPayload(payload.file, config.artifacts.maxFileBytes)
    const method = fileSendMethod(mode, file)
    const sent = await sendFileWithAutoFallback({ telegram, target, file, caption: artifactFileCaptionHtml(caption, captionPaths), method, mode })
    messages.push(messageResult(sent.method, target, sent.message))
  }
  const text = String(payload?.text || "").trim()
  if (text) {
    const message = await sendTextArtifact({ telegram, target, caption, captionPaths, text: clampText(text, config.artifacts.maxTextChars) })
    messages.push(messageResult("sendMessage", target, message))
  }
  if (!messages.length) throw publicError("empty_artifact", "Provide file or text.", 400)
  return { messages }
}

async function sendFileWithAutoFallback({ telegram, target, file, caption, method, mode }) {
  try {
    const message = method === "sendPhoto"
      ? await telegram.sendPhoto({ chatId: target.chatId, topicId: target.topicId, file, caption, captionFormat: "html" })
      : await telegram.sendDocument({ chatId: target.chatId, topicId: target.topicId, file, caption, captionFormat: "html" })
    return { method, message }
  } catch (error) {
    if (mode !== "auto" || method !== "sendPhoto") throw error
    logWarn("artifacts.photo_fallback", { filename: file.filename, bytes: file.bytes.length, contentType: file.contentType })
    const message = await telegram.sendDocument({ chatId: target.chatId, topicId: target.topicId, file, caption, captionFormat: "html" })
    return { method: "sendDocument", message }
  }
}

async function sendTextArtifact({ telegram, target, caption, captionPaths, text }) {
  const lines = [`*${escapeMarkdownV2(caption)}*`, "", toolQuoteMarkdownV2(text)]
  const pathLines = artifactPathLines(captionPaths)
  if (pathLines.length) lines.push("", toolQuoteMarkdownV2(pathLines.join("\n")))
  const markdown = lines.join("\n")
  try {
    return await telegram.sendMessage({ chatId: target.chatId, topicId: target.topicId, text: markdown, format: "markdownv2", disablePreview: true })
  } catch (error) {
    if (!/can't parse entities|entity/i.test(error.message)) throw error
    logWarn("artifacts.text_markdown_fallback", { captionChars: caption.length, textChars: text.length })
    const plainPaths = artifactPathLines(captionPaths).join("\n")
    return telegram.sendMessage({ chatId: target.chatId, topicId: target.topicId, text: [caption, text, plainPaths].filter(Boolean).join("\n\n"), format: "plain", disablePreview: true })
  }
}

export function artifactFileCaptionHtml(caption, captionPaths) {
  const lines = [escapeHtml(caption)]
  const pathLines = artifactPathLines(captionPaths)
  if (pathLines.length) lines.push("", `<blockquote>${pathLines.map((line) => escapeHtml(line)).join("\n")}</blockquote>`)
  return clampTelegramCaptionHtml(lines.join("\n"))
}

export function artifactPathLines(captionPaths) {
  const paths = Array.isArray(captionPaths) ? captionPaths.map((value) => String(value || "").trim()).filter(Boolean) : []
  if (!paths.length) return []
  if (paths.length === 1) return [paths[0]]
  const directories = new Set(paths.map((filePath) => path.dirname(filePath)))
  if (directories.size === 1) return [path.dirname(paths[0]), paths.map((filePath) => path.basename(filePath)).join(", ")]
  return paths
}

function clampTelegramCaptionHtml(value, maxChars = 950) {
  const text = String(value || "")
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 34)).trimEnd()}\n...truncated artifact caption...`
}

function fileFromPayload(file, maxFileBytes) {
  const dataBase64 = String(file?.dataBase64 || "")
  if (!dataBase64) throw publicError("missing_file_data", "file.dataBase64 is required.", 400)
  const bytes = Buffer.from(dataBase64, "base64")
  if (!bytes.length) throw publicError("empty_file", "File payload is empty.", 400)
  if (bytes.length > maxFileBytes) throw publicError("file_too_large", `File is too large (${bytes.length} bytes; max ${maxFileBytes}).`, 413)
  return {
    bytes,
    filename: safeFilename(file.filename),
    contentType: safeContentType(file.contentType),
  }
}

function fileSendMethod(mode, file) {
  if (mode === "photo") return "sendPhoto"
  if (mode === "document") return "sendDocument"
  if (PHOTO_TYPES.has(file.contentType) && file.bytes.length <= TELEGRAM_PHOTO_MAX_BYTES) return "sendPhoto"
  return "sendDocument"
}

function normalizeMode(value) {
  const mode = String(value || "auto").toLowerCase()
  if (!["auto", "photo", "document", "text"].includes(mode)) throw publicError("invalid_mode", "mode must be auto, photo, document, or text.", 400)
  return mode
}

function messageResult(method, target, message) {
  return {
    method,
    messageId: message.message_id,
    link: telegramMessageLink(target.chatId, message.message_id),
  }
}

function safeTarget(target) {
  if (!target) return null
  return { chatId: target.chatId, topicId: target.topicId, title: target.title }
}

function isAuthorized(request, token) {
  const header = request.headers.authorization || ""
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : request.headers["x-opencodebot-artifact-token"]
  if (!supplied || !token) return false
  const left = Buffer.from(String(supplied))
  const right = Buffer.from(String(token))
  return left.length === right.length && timingSafeEqual(left, right)
}

async function readJsonBody(request, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > maxBytes) throw publicError("payload_too_large", `Payload is too large; max ${maxBytes} bytes.`, 413)
    chunks.push(chunk)
  }
  if (!chunks.length) throw publicError("empty_payload", "Request body is empty.", 400)
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw publicError("invalid_json", "Request body must be JSON.", 400)
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(payload))
}

function statusForError(error) {
  return error.statusCode || 500
}

function publicError(publicCode, publicMessage, statusCode) {
  const error = new Error(publicMessage)
  error.publicCode = publicCode
  error.publicMessage = publicMessage
  error.statusCode = statusCode
  return error
}

function safeFilename(value) {
  const name = path.basename(String(value || "artifact.bin")).replace(/[\u0000-\u001f]/g, "").trim()
  return name || "artifact.bin"
}

function safeContentType(value) {
  const type = String(value || "application/octet-stream").trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "application/octet-stream"
}

function clampText(text, maxChars) {
  const value = String(text || "")
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 35)).trimEnd()}\n\n[trimmed for Telegram message limit]`
}
