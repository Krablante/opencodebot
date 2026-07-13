import { timingSafeEqual } from "node:crypto"
import fsp from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"

import { cleanupPayloadSpool, readFileStreamBody, readJsonBody } from "./artifacts/http-body.mjs"
import { publicError, statusForError } from "./artifacts/errors.mjs"
import { artifactFileCaptionHtml, artifactPathLines, clampText, safeContentType, safeFilename } from "./artifacts/formatting.mjs"
import { durationMs, logErrorEvent, logInfo, logWarn } from "./logger.mjs"
import { escapeMarkdownV2, toolQuoteMarkdownV2 } from "./rich-markdown.mjs"
import { telegramMessageLink } from "./telegram.mjs"

export { artifactFileCaptionHtml, artifactPathLines } from "./artifacts/formatting.mjs"

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"])
const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024
const CLOUD_MULTIPART_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024

export function startArtifactGateway({ config, state, telegram, signal }) {
  if (!config.artifacts?.enabled) return null
  const server = createServer(async (request, response) => {
    const startedAt = Date.now()
    const pathname = requestPathname(request)
    try {
      if (!isAuthorized(request, config.artifacts.token)) {
        sendJson(response, 401, { ok: false, error: "unauthorized" })
        return
      }
      if (request.method === "GET" && pathname === "/artifacts/status") {
        const target = state.artifactsTopic()
        sendJson(response, 200, { ok: true, configured: Boolean(target), target: safeTarget(target), botApiMode: config.telegram.botApi.mode })
        return
      }
      if (request.method !== "POST" || !["/artifacts/send", "/artifacts/send-file"].includes(pathname)) {
        sendJson(response, 404, { ok: false, error: "not_found" })
        return
      }
      const target = state.artifactsTopic()
      if (!target) {
        sendJson(response, 409, { ok: false, error: "artifacts_topic_not_configured" })
        return
      }
      const payload = pathname === "/artifacts/send-file"
        ? await readFileStreamBody(request, config)
        : await readJsonBody(request, config.artifacts.maxPayloadBytes)
      let result
      try {
        result = await sendArtifact({ config, telegram, target, payload })
      } finally {
        await cleanupPayloadSpool(payload)
      }
      logInfo("artifacts.sent", {
        durationMs: durationMs(startedAt),
        sourceHost: payload?.source?.host,
        sourceProject: payload?.source?.project,
        messages: result.messages.length,
        stream: pathname === "/artifacts/send-file",
      })
      sendJson(response, 200, { ok: true, target: safeTarget(target), ...result })
    } catch (error) {
      const status = statusForError(error)
      if (status >= 500) logErrorEvent("artifacts.request.failed", error, { durationMs: durationMs(startedAt) })
      else logWarn("artifacts.request.rejected", { durationMs: durationMs(startedAt), status, error: error.publicCode || "artifact_send_failed" })
      sendJson(response, status, { ok: false, error: error.publicCode || "artifact_send_failed", message: error.publicMessage || error.message })
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
    if (payload._stream !== true) throw publicError("stream_required", "Files must be sent to /artifacts/send-file as a stream.", 400)
    if (mode === "text") throw publicError("invalid_text_file_mode", "Send file content as text instead of file when mode is text.", 400)
    const file = fileFromPayload(payload.file, config.artifacts.maxFileBytes)
    if (!telegram.local && file.localPath && !file.bytes) {
      if (file.size > CLOUD_MULTIPART_MEMORY_LIMIT_BYTES) throw publicError("cloud_upload_too_large", `Cloud Bot API uploads from spool are limited to ${CLOUD_MULTIPART_MEMORY_LIMIT_BYTES} bytes; use local Bot API for larger files.`, 413)
      file.bytes = await fsp.readFile(file.localPath)
    }
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
    if (method !== "sendPhoto") throw error
    logWarn("artifacts.photo_fallback", { requestedMode: mode, filename: file.filename, bytes: fileSize(file), contentType: file.contentType })
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

function fileFromPayload(file, maxFileBytes) {
  const size = Number(file?.size || 0)
  if (!file?.localPath) throw publicError("missing_file_path", "Streaming file payload is missing local spool path.", 400)
  if (!Number.isSafeInteger(size) || size <= 0) throw publicError("empty_file", "File payload is empty.", 400)
  if (size > maxFileBytes) throw publicError("file_too_large", `File is too large (${size} bytes; max ${maxFileBytes}).`, 413)
  return {
    localPath: path.resolve(String(file.localPath)),
    size,
    filename: safeFilename(file.filename),
    contentType: safeContentType(file.contentType),
  }
}

function fileSendMethod(mode, file) {
  if (mode === "document") return "sendDocument"
  if (PHOTO_TYPES.has(file.contentType) && fileSize(file) <= TELEGRAM_PHOTO_MAX_BYTES) return "sendPhoto"
  return "sendDocument"
}

function fileSize(file) {
  return file.bytes?.length ?? file.size ?? 0
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

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(payload))
}

function requestPathname(request) {
  try {
    return new URL(request.url || "/", "http://opencodebot.local").pathname
  } catch {
    return request.url || "/"
  }
}
