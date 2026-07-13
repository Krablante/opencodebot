import { clampTelegram, clampTelegramRichMarkdown, escapeHtml } from "./telegram.mjs"
import { normalizeNestedRichLists } from "./rich-list-normalization.mjs"

export const FINAL_ANSWER_MARKER = "🏁"

export function closeOpenCodeFence(markdown) {
  const value = String(markdown ?? "")
  const fences = value.match(/^```/gm)
  return fences && fences.length % 2 === 1 ? `${value}\n\`\`\`` : value
}

export function prepareRichMarkdown(markdown) {
  return sanitizeRichMarkdownLinks(closeOpenCodeFence(clampTelegramRichMarkdown(normalizeNestedRichLists(markdown))))
}

export function withFinalAnswerMarker(text) {
  const value = String(text || "").trim()
  if (!value || value.startsWith(FINAL_ANSWER_MARKER)) return value
  return `${FINAL_ANSWER_MARKER} ${value}`
}

export function preparePlainAssistantText(text, config) {
  return clampTelegram(escapeHtml(text), config.mirror.maxTelegramChars)
}

export function toolQuoteMarkdownV2(text) {
  const body = String(text || "").trim()
  const lines = body ? body.split("\n") : ["..."]
  return lines.map((line, index) => `>${escapeMarkdownV2(line)}${index === lines.length - 1 ? "||" : ""}`).join("\n")
}

export function isRichMessageError(error) {
  const message = String(error?.message || "")
  return message.includes("RICH_MESSAGE") || message.includes("rich_message")
}

export function isTelegramFormattingError(error) {
  const message = String(error?.message || "")
  return isRichMessageError(error) || message.includes("can't parse entities") || message.includes("Unsupported start tag")
}

export function escapeMarkdownV2(text) {
  return String(text ?? "").replace(/[\\_*[\]()~`>#+\-=|{}.!]/g, "\\$&")
}

function sanitizeRichMarkdownLinks(markdown) {
  let inFence = false
  return String(markdown ?? "")
    .split("\n")
    .map((line) => {
      if (/^```/.test(line)) {
        inFence = !inFence
        return line
      }
      return inFence ? line : sanitizeRichMarkdownLine(line)
    })
    .join("\n")
}

function sanitizeRichMarkdownLine(line) {
  let result = ""
  let index = 0
  let inCode = false
  while (index < line.length) {
    if (line[index] === "`") {
      inCode = !inCode
      result += line[index]
      index += 1
      continue
    }
    if (inCode || line[index] !== "[" || line[index - 1] === "!") {
      result += line[index]
      index += 1
      continue
    }
    const parsed = parseMarkdownLink(line, index)
    if (!parsed) {
      result += line[index]
      index += 1
      continue
    }
    result += isSafeRichUrl(parsed.url) ? line.slice(index, parsed.end) : parsed.label
    index = parsed.end
  }
  return result
}

function parseMarkdownLink(line, start) {
  const labelEnd = findUnescaped(line, "]", start + 1)
  if (labelEnd < 0 || line[labelEnd + 1] !== "(") return null
  const urlEnd = findUnescaped(line, ")", labelEnd + 2)
  if (urlEnd < 0) return null
  const label = line.slice(start + 1, labelEnd)
  const url = line.slice(labelEnd + 2, urlEnd).trim()
  if (!label || !url) return null
  return { label, url, end: urlEnd + 1 }
}

function findUnescaped(text, needle, start) {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1
      continue
    }
    if (text[index] === needle) return index
  }
  return -1
}

function isSafeRichUrl(url) {
  return /^(https?:\/\/|tg:\/\/|mailto:)[^\s<>()]+$/i.test(url)
}
