import path from "node:path"

import { escapeHtml } from "../telegram.mjs"

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

export function safeFilename(value) {
  const name = displayPathInfo(value || "artifact.bin").basename.replace(/[\u0000-\u001f]/g, "").trim()
  return name || "artifact.bin"
}

export function safeContentType(value) {
  const type = String(value || "application/octet-stream").trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "application/octet-stream"
}

export function clampText(text, maxChars) {
  const value = String(text || "")
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 35)).trimEnd()}\n\n[trimmed for Telegram message limit]`
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
