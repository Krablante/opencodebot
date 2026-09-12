import { clampTelegram, clampTelegramRichMarkdown, escapeHtml } from "./telegram.mjs"
import { normalizeNestedRichLists } from "./rich-list-normalization.mjs"
import { fromMarkdown } from "mdast-util-from-markdown"
import { toMarkdown } from "mdast-util-to-markdown"

export const FINAL_ANSWER_MARKER = "🏁"

export function closeOpenCodeFence(markdown) {
  const value = String(markdown ?? "")
  const fences = value.match(/^```/gm)
  return fences && fences.length % 2 === 1 ? `${value}\n\`\`\`` : value
}

export function prepareRichMarkdown(markdown, { imagesAsLinks = false } = {}) {
  const value = sanitizeRichMarkdownLinks(normalizeNestedRichLists(markdown), imagesAsLinks)
  return closeOpenCodeFence(clampTelegramRichMarkdown(value))
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

function sanitizeRichMarkdownLinks(markdown, imagesAsLinks) {
  const source = String(markdown ?? "")
  if (!/[\[<]/.test(source)) return source
  const tree = fromMarkdown(source)
  const definitions = new Map()
  const replacements = []
  const walk = (node, visit) => {
    if (visit(node)) return
    for (const child of node.children || []) walk(child, visit)
  }
  walk(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node)
  })
  // Replace only parsed links: preserve tables, custom rich syntax, and literal code byte-for-byte.
  walk(tree, (node) => {
    if (node.type === "definition" && !isSafeRichUrl(node.url)) {
      replacements.push({ start: node.position.start.offset, end: node.position.end.offset, value: "" })
      return true
    }
    if (!["link", "image", "linkReference", "imageReference"].includes(node.type)) return false
    const children = sanitizeLink(node, definitions, imagesAsLinks)
    if (children.length === 1 && children[0] === node) return true
    replacements.push({
      start: node.position.start.offset,
      end: node.position.end.offset,
      value: toMarkdown({ type: "root", children: [{ type: "paragraph", children }] }).trimEnd(),
    })
    return true
  })
  let result = source
  for (const { start, end, value } of replacements.reverse()) {
    result = `${result.slice(0, start)}${value}${result.slice(end)}`
  }
  return result
}

function sanitizeLink(node, definitions, imagesAsLinks, inLink = false) {
  const image = node.type === "image" || node.type === "imageReference"
  const target = node.type.endsWith("Reference") ? definitions.get(node.identifier) : node
  if (!target) return [node]
  const children = image
    ? [{ type: "text", value: node.alt || target.url }]
    : (node.children || []).flatMap((child) => sanitizeInlineLinks(child, definitions, imagesAsLinks, true))
  if (!isSafeRichUrl(target.url, image && !imagesAsLinks) || (image && imagesAsLinks && inLink)) {
    if (children.length === 1 && children[0].type === "text" && children[0].value === target.url) return [{ type: "inlineCode", value: target.url }]
    return [...children, { type: "text", value: " — " }, { type: "inlineCode", value: target.url }]
  }
  if (image && imagesAsLinks) return [{ type: "link", url: target.url, title: target.title, children }]
  if (!image && children.some((child, index) => child !== node.children[index])) return [{ ...node, children }]
  return [node]
}

function sanitizeInlineLinks(node, definitions, imagesAsLinks, inLink) {
  if (["link", "image", "linkReference", "imageReference"].includes(node.type)) return sanitizeLink(node, definitions, imagesAsLinks, inLink)
  if (!node.children) return [node]
  const children = node.children.flatMap((child) => sanitizeInlineLinks(child, definitions, imagesAsLinks, inLink))
  return children.some((child, index) => child !== node.children[index]) ? [{ ...node, children }] : [node]
}

function isSafeRichUrl(url, image = false) {
  if (!/^(https?:\/\/|tg:\/\/|mailto:)[^\s<>]+$/i.test(url)) return false
  try {
    const parsed = new URL(url)
    return !image || parsed.protocol === "https:" || parsed.protocol === "http:"
  } catch {
    return false
  }
}
