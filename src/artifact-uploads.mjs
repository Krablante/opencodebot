import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { downloadTelegramFiles } from "./attachments.mjs"
import { joinServerPath, pathStyle, safeFilename, transferFile } from "./upload-transfer.mjs"

export class ArtifactUploadBuffer {
  constructor({ settings, flushUpload, onError = (error) => console.error(error) }) {
    this.settings = settings || {}
    this.flushUpload = flushUpload
    this.onError = onError
    this.pending = new Map()
  }

  async add({ message, files }) {
    const mediaGroupID = message.media_group_id ? String(message.media_group_id) : ""
    if (!mediaGroupID) {
      await this.flushUpload({ message, files })
      return { status: "flushed" }
    }

    const key = `${message.chat?.id || ""}:${message.message_thread_id || ""}:${mediaGroupID}`
    const entry = this.pending.get(key) || { message, files: [], timer: null }
    entry.files.push(...files)
    if (message.caption && !entry.message.caption) entry.message = message
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => this.flush(key).catch(this.onError), this.settings.mediaGroupIdleMs || 1200)
    this.pending.set(key, entry)
    return { status: "queued" }
  }

  async flush(key) {
    const entry = this.pending.get(key)
    if (!entry) return
    this.pending.delete(key)
    clearTimeout(entry.timer)
    await this.flushUpload({ message: entry.message, files: entry.files })
  }
}

export async function handleArtifactUploadMessage({ telegram, config, opencode, message, files }) {
  const uploadConfig = config.artifactUploads || {}
  if (!uploadConfig.enabled) {
    await replyHTML(telegram, message, "Artifact uploads are disabled.")
    return { status: "disabled" }
  }

  const target = resolveUploadTarget({ caption: message.caption || "", uploadConfig, opencode })
  if (target.error) {
    await replyHTML(telegram, message, formatTargetError(target))
    return { status: "unknown_server" }
  }
  if (!config.attachments?.enabled) {
    await replyHTML(telegram, message, "Telegram file uploads are disabled.")
    return { status: "disabled" }
  }

  let saved
  try {
    saved = await saveArtifactFiles({ telegram, config, server: target.server, files })
  } catch (error) {
    await replyHTML(telegram, message, `Could not save artifact upload: ${escapeHTML(error.message || String(error))}`)
    return { status: "failed", error }
  }

  await replyHTML(telegram, message, formatSavedPaths({ server: target.server, paths: saved.map((file) => file.targetPath) }))
  return { status: "saved", server: target.server.id, files: saved }
}

export function resolveUploadTarget({ caption = "", uploadConfig = {}, opencode }) {
  const requested = firstCaptionToken(caption)
  const serverID = requested || uploadConfig.defaultServerId || opencode?.config?.opencode?.defaultServerId || opencode?.config?.defaultPrompt?.serverID
  if (!serverID) return { error: "no_default_server", requested: "", available: availableServerIds(opencode) }
  let server
  try {
    server = opencode.server(serverID)
  } catch {
    return { error: "unknown_server", requested: serverID, available: availableServerIds(opencode) }
  }
  return { server, requested }
}

export function artifactTargetPath({ config, server, filename, now = new Date() }) {
  const style = pathStyleForUploads(server)
  const root = resolveArtifactUploadRoot({ config, server, style })
  const segments = []
  if (config.artifactUploads?.dateFolders !== false) segments.push(localDateStamp(now))
  segments.push(safeFilename(filename || "file"))
  return joinServerPath(root, segments, style)
}

export function resolveArtifactUploadRoot({ config, server, style = pathStyleForUploads(server) }) {
  const configured = server.artifactUploadRoot || config.artifactUploads?.root || "~/trash"
  return expandHomeForServer(configured, server, style)
}

async function saveArtifactFiles({ telegram, config, server, files }) {
  if (!files?.length) return []
  const scratchDir = path.join(config.paths.uploadsDir || path.join(os.tmpdir(), "opencodebot-uploads"), "artifact-inbox", randomUUID())
  let downloads = []
  try {
    downloads = await downloadTelegramFiles(telegram, uniquedFiles(files), scratchDir, config.attachments)
    const saved = []
    for (const file of downloads) {
      const targetPath = artifactTargetPath({ config, server, filename: file.filename })
      await transferFile({ localPath: file.localPath, targetPath, server })
      saved.push({ ...file, targetPath })
    }
    return saved
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {})
  }
}

function firstCaptionToken(caption) {
  return String(caption || "").trim().split(/\s+/).filter(Boolean)[0] || ""
}

function availableServerIds(opencode) {
  return Array.from(opencode?.servers?.keys?.() || []).sort()
}

function formatTargetError(target) {
  if (target.error === "no_default_server") return "No artifact upload server is configured."
  const available = target.available.length ? ` Available: <code>${escapeHTML(target.available.join(", "))}</code>.` : ""
  return `Unknown artifact upload server: <code>${escapeHTML(target.requested)}</code>.${available}`
}

function formatSavedPaths({ server, paths }) {
  const body = paths.map(escapeHTML).join("\n")
  return `Saved to <code>${escapeHTML(server.id)}</code>:\n<blockquote>${body}</blockquote>`
}

function uniquedFiles(files) {
  const seen = new Map()
  return files.map((file) => {
    const filename = safeFilename(file.filename || "file")
    const unique = uniqueFilename(filename, seen)
    return { ...file, filename: unique }
  })
}

function uniqueFilename(filename, seen) {
  const count = (seen.get(filename) || 0) + 1
  seen.set(filename, count)
  if (count === 1) return filename
  const parsed = path.parse(filename)
  return `${parsed.name}-${count}${parsed.ext}`
}

function expandHomeForServer(value, server, style) {
  const text = String(value || "~/trash")
  if (text === "~" || text.startsWith("~/") || text.startsWith("~\\")) {
    if (!server.home) throw new Error(`artifact upload root uses ~ but server ${server.id} has no home`)
    const relative = text.slice(1).replace(/^[\\/]+/, "")
    if (!relative) return trimTrailingSeparators(server.home, style)
    return joinServerPath(server.home, splitPathSegments(relative), style)
  }
  return trimTrailingSeparators(text, style)
}

function pathStyleForUploads(server) {
  if (server.artifactUploadRoot) {
    if (/^[A-Za-z]:[\\/]/.test(server.artifactUploadRoot) || server.artifactUploadRoot.startsWith("\\\\")) return "windows"
  }
  return pathStyle(server)
}

function splitPathSegments(value) {
  return String(value || "").split(/[\\/]+/).filter(Boolean)
}

function localDateStamp(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function trimTrailingSeparators(value, style) {
  const text = String(value || "")
  if (style === "windows") {
    if (/^[A-Za-z]:[\\/]?$/.test(text)) return text.replace("/", "\\")
    if (text.startsWith("\\\\")) return text.replace(/[\\/]+$/, "") || text
  }
  return text.replace(/[\\/]+$/, "") || text
}

async function replyHTML(telegram, message, text) {
  await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text })
}

function topicId(message) {
  return message.message_thread_id || message.reply_to_message?.message_thread_id || undefined
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char])
}
