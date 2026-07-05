import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"

export class AttachmentBuffer {
  constructor({ settings, uploadDir, flushPrompt, onExpire, onError = (error) => console.error(error) }) {
    this.settings = normalizeAttachmentSettings(settings)
    this.uploadDir = uploadDir
    this.flushPrompt = flushPrompt
    this.onExpire = onExpire
    this.onError = onError
    this.pending = new Map()
  }

  async addFiles(key, context, files, { text = "", mediaGroupID = "" } = {}) {
    if (!this.settings.enabled) return { status: "disabled" }
    if (!files.length) return { status: "empty" }
    const entry = this.entry(key, context)
    entry.context = context
    entry.files.push(...files)
    if (mediaGroupID) entry.mediaGroupID = mediaGroupID
    const cleanText = String(text || "").trim()
    if (cleanText) entry.textParts.push(cleanText)
    this.validateLimits(key, entry)

    if (mediaGroupID) {
      this.scheduleMediaFlush(key, entry)
      return { status: cleanText ? "media_group_pending_flush" : "waiting_for_text", files: entry.files.length }
    }
    if (cleanText) {
      await this.flushKey(key)
      return { status: "sent" }
    }
    this.schedulePromptTimeout(key, entry)
    return { status: "waiting_for_text", files: entry.files.length }
  }

  async addText(key, context, text) {
    const entry = this.pending.get(key)
    if (!entry) return false
    const cleanText = String(text || "").trim()
    if (!cleanText) return false
    entry.context = context
    entry.textParts.push(cleanText)
    await this.flushKey(key)
    return true
  }

  has(key) {
    return this.pending.has(key)
  }

  async flushKey(key) {
    const entry = this.pending.get(key)
    if (!entry) return false
    this.clearTimers(entry)
    this.pending.delete(key)
    const text = entry.textParts.join("\n\n").trim()
    if (!text) {
      await this.expireEntry(entry)
      return false
    }
    await this.flushPrompt(entry.context, text, entry.files)
    return true
  }

  entry(key, context) {
    let entry = this.pending.get(key)
    if (!entry) {
      entry = { context, files: [], textParts: [], mediaGroupID: "", mediaTimer: null, promptTimer: null }
      this.pending.set(key, entry)
    }
    return entry
  }

  validateLimits(key, entry) {
    const totalBytes = entry.files.reduce((total, file) => total + (file.size || 0), 0)
    if (entry.files.length <= this.settings.maxFiles && totalBytes <= this.settings.maxTotalBytes) return
    this.clearTimers(entry)
    this.pending.delete(key)
    cleanupFiles(entry.files).catch(this.onError)
    throw new Error(
      `Attachment batch is too large: ${entry.files.length} files, ${totalBytes} bytes; limits are ${this.settings.maxFiles} files and ${this.settings.maxTotalBytes} bytes`,
    )
  }

  scheduleMediaFlush(key, entry) {
    if (entry.mediaTimer) clearTimeout(entry.mediaTimer)
    entry.mediaTimer = setTimeout(() => {
      entry.mediaTimer = null
      if (entry.textParts.length) this.flushKey(key).catch(this.onError)
      else this.schedulePromptTimeout(key, entry)
    }, this.settings.mediaGroupIdleMs)
    entry.mediaTimer.unref?.()
  }

  schedulePromptTimeout(key, entry) {
    if (entry.promptTimer) clearTimeout(entry.promptTimer)
    entry.promptTimer = setTimeout(() => {
      const current = this.pending.get(key)
      if (!current) return
      this.pending.delete(key)
      this.expireEntry(current).catch(this.onError)
    }, this.settings.promptIdleMs)
    entry.promptTimer.unref?.()
  }

  clearTimers(entry) {
    if (entry.mediaTimer) clearTimeout(entry.mediaTimer)
    if (entry.promptTimer) clearTimeout(entry.promptTimer)
  }

  async expireEntry(entry) {
    await cleanupFiles(entry.files)
    await this.onExpire?.(entry.context, entry.files)
  }
}

export function extractTelegramFiles(message) {
  const files = []
  if (message.document) files.push(fileDescriptor(message.document, "document", message.document.file_name))
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1]
    files.push(fileDescriptor(photo, "photo", `photo-${message.message_id}.jpg`, "image/jpeg"))
  }
  if (message.video) files.push(fileDescriptor(message.video, "video", message.video.file_name, message.video.mime_type))
  if (message.animation) files.push(fileDescriptor(message.animation, "animation", message.animation.file_name, message.animation.mime_type))
  if (message.audio) files.push(fileDescriptor(message.audio, "audio", message.audio.file_name, message.audio.mime_type))
  if (message.voice) files.push(fileDescriptor(message.voice, "voice", `voice-${message.message_id}.ogg`, message.voice.mime_type || "audio/ogg"))
  if (message.video_note) files.push(fileDescriptor(message.video_note, "video_note", `video-note-${message.message_id}.mp4`, "video/mp4"))
  return files.filter((file) => file.fileID)
}

export async function downloadTelegramFiles(telegram, descriptors, uploadDir, settings) {
  const normalized = normalizeAttachmentSettings(settings)
  await fs.mkdir(uploadDir, { recursive: true, mode: 0o700 })
  const downloads = []
  const createdPaths = []
  try {
    for (const descriptor of descriptors) {
      if (descriptor.size && descriptor.size > normalized.maxFileBytes) {
        throw new Error(`${descriptor.filename} is too large (${descriptor.size} bytes; max ${normalized.maxFileBytes})`)
      }
      logAttachment("attachment.download.start", descriptor)
      const localPath = path.join(uploadDir, uploadFileName(descriptor.filename))
      createdPaths.push(localPath)
      let downloaded
      try {
        downloaded = await telegram.downloadFile({ fileId: descriptor.fileID, destination: localPath, maxBytes: normalized.maxFileBytes })
      } catch (error) {
        logAttachment("attachment.download.failed", descriptor, { error })
        throw error
      }
      const stat = await fs.stat(localPath)
      const mime = descriptor.mime || "application/octet-stream"
      const size = stat.size || downloaded.file?.file_size || descriptor.size || 0
      const inline = size <= normalized.maxInlineBytes
      logAttachment("attachment.download.complete", descriptor, { size, inline, sourcePath: downloaded.file?.source_path })
      downloads.push({
        type: inline ? "file" : "saved_file",
        mime,
        filename: descriptor.filename,
        url: inline ? await dataURL(localPath, mime) : undefined,
        path: inline ? undefined : localPath,
        source: { type: "telegram", kind: descriptor.kind, fileUniqueId: descriptor.fileUniqueID },
        localPath,
        size,
      })
    }
    return downloads
  } catch (error) {
    await cleanupFiles(downloads)
    await Promise.all(createdPaths.map((filePath) => fs.rm(filePath, { force: true })))
    throw error
  }
}

function logAttachment(event, descriptor, extra = {}) {
  const details = {
    kind: descriptor.kind,
    filename: descriptor.filename,
    mime: descriptor.mime,
    size: descriptor.size,
    fileUniqueID: descriptor.fileUniqueID,
    fileIDHash: shortHash(descriptor.fileID),
    ...extra,
  }
  if (details.error) details.error = { name: details.error.name, message: details.error.message }
  if (details.sourcePath) details.sourcePath = "local-bot-api-path"
  console.log(`[opencodebot] ${event} ${JSON.stringify(details)}`)
}

function shortHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12)
}

async function dataURL(filePath, mime) {
  const encoded = await fs.readFile(filePath, "base64")
  return `data:${mime};base64,${encoded}`
}

export async function cleanupUploads(uploadDir, maxAgeMs) {
  const cutoff = Date.now() - Number(maxAgeMs || 0)
  if (!Number.isFinite(cutoff)) return
  let entries
  try {
    entries = await fs.readdir(uploadDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return
    throw error
  }
  await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(uploadDir, entry.name)
      const stat = await fs.stat(filePath).catch(() => null)
      if (!stat || stat.mtimeMs >= cutoff) return
      await fs.rm(filePath, { recursive: true, force: true })
    }),
  )
}

export function normalizeAttachmentSettings(settings = {}) {
  return {
    enabled: settings.enabled !== false,
    mediaGroupIdleMs: numberAtLeast(settings.mediaGroupIdleMs, 1500, 100),
    promptIdleMs: numberAtLeast(settings.promptIdleMs, 60_000, 1000),
    maxFiles: numberAtLeast(settings.maxFiles, 10, 1),
    maxFileBytes: numberAtLeast(settings.maxFileBytes, 20_000_000, 1024),
    maxTotalBytes: numberAtLeast(settings.maxTotalBytes, 60_000_000, 1024),
    maxInlineBytes: numberAtLeast(settings.maxInlineBytes, 20_000_000, 1024),
    cleanupAfterMs: numberAtLeast(settings.cleanupAfterMs, 24 * 60 * 60 * 1000, 60_000),
  }
}

export async function cleanupFiles(files) {
  await Promise.all(files.map((file) => (file.localPath ? fs.rm(file.localPath, { force: true }) : Promise.resolve())))
}

function fileDescriptor(file, kind, fallbackName, fallbackMime) {
  return {
    kind,
    fileID: file.file_id,
    fileUniqueID: file.file_unique_id,
    filename: safeFilename(file.file_name || fallbackName || `${kind}-${file.file_unique_id || randomUUID()}`),
    mime: file.mime_type || fallbackMime || "application/octet-stream",
    size: file.file_size || 0,
  }
}

function uploadFileName(filename) {
  return `${Date.now()}-${randomUUID()}-${safeFilename(filename)}`
}

function safeFilename(filename) {
  return String(filename || "file")
    .replace(/[\x00-\x1f\x7f/\\]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160)
}

function numberAtLeast(value, fallback, min) {
  const number = Number(value)
  return Number.isFinite(number) && number >= min ? Math.floor(number) : fallback
}
