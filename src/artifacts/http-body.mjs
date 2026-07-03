import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { once } from "node:events"

import { publicError } from "./errors.mjs"
import { safeContentType, safeFilename } from "./formatting.mjs"

export async function readJsonBody(request, maxBytes) {
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

export async function readFileStreamBody(request, config) {
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

export async function cleanupPayloadSpool(payload) {
  if (!payload?._stream || !payload.file?.localPath) return
  await fsp.rm(payload.file.localPath, { force: true })
  if (payload.file.localDir) {
    await fsp.rm(payload.file.localDir, { recursive: true, force: true })
  }
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
