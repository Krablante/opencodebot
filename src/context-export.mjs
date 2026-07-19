import { visibleTextFromParts } from "./opencode.mjs"
import { escapeHtml } from "./telegram.mjs"

export const DEFAULT_CONTEXT_TURNS = 3
export const MAX_CONTEXT_TURNS = 10
export const MAX_CONTEXT_TOTAL_CHARS = 240_000
export const MAX_CONTEXT_RICH_CONTENT_BYTES = 30_000

export async function loadRecentContextTurns({ opencode, binding, count, interruptedUserMessageIDs = new Set(), pageSize = 20 }) {
  if (typeof opencode.messagePage !== "function") {
    const messages = await opencode.messages(binding.serverID, binding.sessionID, { directory: binding.directory })
    return extractContextTurns(messages, { interruptedUserMessageIDs }).slice(-count)
  }

  let before
  let messages = []
  const cursors = new Set()
  while (true) {
    const page = await opencode.messagePage(binding.serverID, binding.sessionID, {
      before,
      directory: binding.directory,
      limit: pageSize,
    })
    const items = Array.isArray(page?.messages) ? page.messages : []
    messages = [...items.map(contextRelevantMessage).filter(Boolean), ...messages]
    const turns = extractContextTurns(messages, { interruptedUserMessageIDs })
    if (turns.length >= count) return turns.slice(-count)
    if (!page?.before || cursors.has(page.before)) return turns
    cursors.add(page.before)
    before = page.before
  }
}

export function extractContextTurns(messages, { interruptedUserMessageIDs = new Set() } = {}) {
  const candidates = []
  const turnsByUserMessageID = new Map()
  let current
  for (const message of messages || []) {
    const info = message?.info || message
    if (info?.role === "user") {
      const prompt = userPromptText(message)
      current = prompt && !info.synthetic ? { userMessageID: info.id, prompt, answer: "", progress: [] } : undefined
      if (current) {
        candidates.push(current)
        if (current.userMessageID) turnsByUserMessageID.set(current.userMessageID, current)
      }
      continue
    }
    if (info?.role !== "assistant") continue
    const target = turnsByUserMessageID.get(info.parentID) || current
    if (!target) continue
    const text = visibleTextFromParts(message?.parts || []).trim()
    if (!text) continue
    if (info.finish === "stop") target.answer = text
    else target.progress.push(text)
  }
  return candidates.flatMap((turn, index) => {
    if (turn.answer) return [{ prompt: turn.prompt, answer: turn.answer, progress: [], interrupted: false }]
    const interrupted = index < candidates.length - 1 || interruptedUserMessageIDs.has(turn.userMessageID)
    return interrupted ? [{ prompt: turn.prompt, answer: "", progress: turn.progress, interrupted: true }] : []
  })
}

export function buildCollapsedContextMessages(turns, {
  maxTotalChars = MAX_CONTEXT_TOTAL_CHARS,
  maxRichContentBytes = MAX_CONTEXT_RICH_CONTENT_BYTES,
} = {}) {
  const text = formatContextTurns(turns)
  if (text.length > maxTotalChars) {
    const error = new Error(`Context is too large (${text.length} characters). Request fewer turns.`)
    error.code = "CONTEXT_TOO_LARGE"
    error.characters = text.length
    throw error
  }
  const chunks = splitForEscapedHtml(text, maxRichContentBytes)
  return chunks.map((chunk, index) => {
    const part = chunks.length > 1 ? ` · part ${index + 1}/${chunks.length}` : ""
    const summary = `📋 Context · ${turns.length} turn${turns.length === 1 ? "" : "s"} · ${text.length.toLocaleString("en-US")} chars${part} · expand to copy`
    return {
      html: `<details><summary>${escapeHtml(summary)}</summary><pre><code>${escapeHtml(chunk)}</code></pre></details>`,
      text: chunk,
    }
  })
}

export function parseContextTurnCount(value, { allowEmpty = false } = {}) {
  const input = String(value || "").trim()
  if (!input && allowEmpty) return undefined
  if (!/^\d+$/.test(input)) throw contextCountError()
  const count = Number(input)
  if (!Number.isInteger(count) || count < 1 || count > MAX_CONTEXT_TURNS) throw contextCountError()
  return count
}

function userPromptText(message) {
  const parts = message?.parts || []
  const text = visibleTextFromParts(parts).trim()
  const attachments = parts
    .filter((part) => part?.type === "file" || part?.type === "image")
    .map((part) => {
      const name = part.filename || part.name || "attachment"
      const mime = part.mime || part.mimeType
      return `[Attachment: ${name}${mime ? ` (${mime})` : ""}]`
    })
  return [text, ...attachments].filter(Boolean).join("\n")
}

function contextRelevantMessage(message) {
  const info = message?.info || message
  if (info?.role === "user") return message
  if (info?.role !== "assistant") return undefined
  const text = visibleTextFromParts(message?.parts || []).trim()
  return text ? { info, parts: [{ type: "text", text }] } : undefined
}

function formatContextTurns(turns) {
  return turns.map((turn) => {
    if (turn.interrupted) {
      const progress = (turn.progress || []).flatMap((note, index) => ["", `### Progress ${index + 1}`, note.trim()])
      return ["### User — interrupted", turn.prompt.trim(), ...progress].join("\n")
    }
    return ["### User", turn.prompt.trim(), "", "### Assistant", turn.answer.trim()].join("\n")
  }).join("\n\n---\n\n")
}

function splitForEscapedHtml(text, maxEscapedBytes) {
  if (!text) return []
  if (!Number.isFinite(maxEscapedBytes) || maxEscapedBytes < 8) throw new Error("Rich context chunk budget is too small")
  const chunks = []
  let start = 0
  while (start < text.length) {
    let index = start
    let escapedBytes = 0
    let lastLineBreak = -1
    while (index < text.length) {
      const codePoint = text.codePointAt(index)
      const character = String.fromCodePoint(codePoint)
      const width = escapedHtmlBytes(character)
      if (escapedBytes + width > maxEscapedBytes) break
      escapedBytes += width
      index += character.length
      if (character === "\n") lastLineBreak = index
    }
    if (index === text.length) {
      chunks.push(text.slice(start))
      break
    }
    const midpoint = start + Math.floor((index - start) / 2)
    const end = lastLineBreak > midpoint ? lastLineBreak : index
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

function escapedHtmlBytes(character) {
  if (character === "&") return 5
  if (character === "<" || character === ">") return 4
  return Buffer.byteLength(character, "utf8")
}

function contextCountError() {
  return new Error(`Context turn count must be an integer from 1 to ${MAX_CONTEXT_TURNS}.`)
}
