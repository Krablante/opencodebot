import { createServer } from "node:http"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { createWriteStream } from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { once } from "node:events"

import { durationMs, logErrorEvent, logInfo, logWarn } from "./logger.mjs"
import { escapeMarkdownV2, toolQuoteMarkdownV2 } from "./rich-markdown.mjs"
import { escapeHtml, telegramMessageLink } from "./telegram.mjs"

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"])
const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024

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
    if (!telegram.local && file.localPath && !file.bytes) file.bytes = await fsp.readFile(file.localPath)
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
    logWarn("artifacts.photo_fallback", { filename: file.filename, bytes: fileSize(file), contentType: file.contentType })
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
  const values = paths.map((filePath) => displayPathInfo(filePath))
  if (values.length === 1) return [values[0].display]
  const directories = new Set(values.map((filePath) => filePath.directoryKey))
  if (directories.size === 1) return [values[0].directoryDisplay, values.map((filePath) => filePath.basename).join(", ")]
  return values.map((filePath) => filePath.display)
}

function displayPathInfo(value) {
  const display = displayPathString(value)
  const flavor = pathFlavor(display)
  const parser = flavor === "win32" ? path.win32 : path.posix
  const directory = parser.dirname(display)
  return {
    display,
    basename: parser.basename(display),
    directoryDisplay: cleanDirectoryDisplay(directory, flavor),
    directoryKey: directoryKey(directory, flavor),
  }
}

function displayPathString(value) {
  const input = String(value)
  const fileUrlPath = fileUrlPathForDisplay(input)
  return fileUrlPath || input
}

function fileUrlPathForDisplay(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== "file:") return null
    const pathname = decodeURIComponent(url.pathname)
    if (url.hostname && url.hostname !== "localhost") return `//${url.hostname}${pathname}`
    if (/^\/[A-Za-z]:\//.test(pathname)) return pathname.slice(1)
    return pathname
  } catch {
    return null
  }
}

function pathFlavor(value) {
  if (/^[A-Za-z]:[\\/]/.test(value)) return "win32"
  if (/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)) return "win32"
  if (value.includes("\\")) return "win32"
  return "posix"
}

function directoryKey(directory, flavor) {
  if (flavor !== "win32") return directory
  const normalized = directory.replace(/\//g, "\\").replace(/\\+$/, "")
  return (normalized || directory.replace(/\//g, "\\")).toLowerCase()
}

function cleanDirectoryDisplay(directory, flavor) {
  if (flavor !== "win32") return directory
  if (/^[A-Za-z]:[\\/]$/.test(directory)) return directory
  if (/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+[\\/]$/.test(directory)) return directory.slice(0, -1)
  return directory
}

function clampTelegramCaptionHtml(value, maxChars = 950) {
  const text = String(value || "")
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 34)).trimEnd()}\n...truncated artifact caption...`
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
  if (mode === "photo") return "sendPhoto"
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

async function readFileStreamBody(request, config) {
  const metadata = readStreamMetadata(request)
  const contentLength = Number(request.headers["content-length"] || 0)
  if (Number.isFinite(contentLength) && contentLength > config.artifacts.maxFileBytes) {
    throw publicError("file_too_large", `File is too large (${contentLength} bytes; max ${config.artifacts.maxFileBytes}).`, 413)
  }
  const filename = safeFilename(metadata?.file?.filename || metadata?.filename)
  const contentType = safeContentType(metadata?.file?.contentType || metadata?.contentType || request.headers["content-type"])
  const spoolDir = config.telegram.botApi.spoolDir
  await fsp.mkdir(spoolDir, { recursive: true, mode: 0o755 })
  await fsp.chmod(spoolDir, 0o755).catch(() => {})
  const localDir = path.join(spoolDir, `${Date.now()}-${randomUUID()}`)
  await fsp.mkdir(localDir, { recursive: false, mode: 0o755 })
  await fsp.chmod(localDir, 0o755).catch(() => {})
  const localPath = path.join(localDir, filename)
  let size = 0
  try {
    size = await writeLimitedStream({ input: request, localPath, maxBytes: config.artifacts.maxFileBytes })
    if (size) {
      return {
        ...metadata,
        _stream: true,
        file: { localPath, localDir, size, filename, contentType },
      }
    }
  } catch (error) {
    await fsp.rm(localDir, { recursive: true, force: true })
    throw error
  }
  await fsp.rm(localDir, { recursive: true, force: true })
  throw publicError("empty_file", "File payload is empty.", 400)
}

function readStreamMetadata(request) {
  const encoded = String(request.headers["x-opencodebot-artifact-meta"] || "")
  if (!encoded) return {}
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  } catch {
    throw publicError("invalid_artifact_metadata", "x-opencodebot-artifact-meta must be base64url JSON.", 400)
  }
}

async function writeLimitedStream({ input, localPath, maxBytes }) {
  const output = createWriteStream(localPath, { flags: "wx", mode: 0o644 })
  let total = 0
  try {
    for await (const chunk of input) {
      total += chunk.length
      if (total > maxBytes) throw publicError("file_too_large", `File is too large; max ${maxBytes} bytes.`, 413)
      if (!output.write(chunk)) await once(output, "drain")
    }
    output.end()
    await once(output, "finish")
    return total
  } catch (error) {
    output.destroy()
    await fsp.rm(localPath, { force: true })
    throw error
  }
}

async function cleanupPayloadSpool(payload) {
  if (!payload?._stream || !payload.file?.localPath) return
  await fsp.rm(payload.file.localPath, { force: true })
  if (payload.file.localDir) {
    await fsp.rm(payload.file.localDir, { recursive: true, force: true })
  }
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
  const name = displayPathInfo(value || "artifact.bin").basename.replace(/[\u0000-\u001f]/g, "").trim()
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
