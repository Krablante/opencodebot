import path from "node:path"

import { escapeHtml } from "../telegram.mjs"
import { t } from "../i18n/index.mjs"
import { safeFilename as boundedFilename } from "../upload-transfer.mjs"

export function artifactFileCaptionHtml(caption, captionPaths) {
  const paths = artifactPathLines(captionPaths).join("\n")
  const render = (label, source) => escapeHtml(label) + (source ? `\n\n<blockquote>${escapeHtml(source)}</blockquote>` : "")
  const full = render(caption, paths)
  if (full.length <= 950) return full
  const captionBudget = paths ? Math.min(escapeHtml(caption).length, 440) : 950
  const label = shortenCaptionText(String(caption), captionBudget)
  const source = paths && shortenCaptionText(paths, 950 - escapeHtml(label).length - "\n\n<blockquote></blockquote>".length)
  return render(label, source)
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
  return boundedFilename(displayPathInfo(value || "artifact.bin").basename)
}

export function safeContentType(value) {
  const type = String(value || "application/octet-stream").trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "application/octet-stream"
}

export function clampText(text, maxChars) {
  const value = String(text || "")
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 35)).trimEnd()}\n\n${t("artifacts.trimmedMessage")}`
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

function shortenCaptionText(text, maxEscapedChars) {
  if (escapeHtml(text).length <= maxEscapedChars) return text
  const suffix = `\n${t("artifacts.trimmedCaption")}`
  const budget = maxEscapedChars - escapeHtml(suffix).length
  let result = "", used = 0
  for (const character of text) {
    const width = escapeHtml(character).length
    if (used + width > budget) break
    result += character
    used += width
  }
  return result.trimEnd() + suffix
}
