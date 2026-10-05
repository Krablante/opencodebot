import { openAsBlob } from "node:fs"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { toMarkdown } from "mdast-util-to-markdown"
import { getLanguage, tFor } from "./i18n/index.mjs"
import { isInternalUserMessage, logicalTurnUserReferences } from "./logical-turn.mjs"
import { telegramLocalMaxFileBytes } from "./config/telegram.mjs"

export async function loadSessionExport({ opencode, binding, asOf = Date.now(), pageSize = 100 }) {
  const session = await opencode.getSession(binding.serverID, binding.sessionID, { directory: binding.directory })
  const pages = []
  const cursors = new Set()
  let before
  do {
    const page = await opencode.messagePage(binding.serverID, binding.sessionID, {
      directory: binding.directory, limit: pageSize, before,
    })
    pages.push((page.messages || []).filter((message) => {
      const info = message.info || message
      return !session.revert?.messageID || info.id < session.revert.messageID
    }).map(exportRelevantMessage))
    before = page.before
    if (before && cursors.has(before)) throw new Error("Session export received a repeated history cursor")
    if (before) cursors.add(before)
  } while (before)
  return { title: session.title || "", turns: extractSessionExportTurns(pages.reverse().flat(), { asOf }) }
}

export function extractSessionExportTurns(messages, { asOf = Date.now() } = {}) {
  const snapshot = messages.filter((message) => {
    const created = (message.info || message).time?.created
    return !Number.isFinite(created) || created <= asOf
  })
  const roots = logicalTurnUserReferences(snapshot)
  const turns = []
  const byUserID = new Map()
  let current
  for (const message of snapshot) {
    const info = message.info || message
    if (info.role === "user") {
      const rootID = roots.get(info.id)
      if (info.synthetic === true || isInternalUserMessage(message) || (rootID && rootID !== info.id)) {
        const root = rootID ? byUserID.get(rootID) : current
        if (root && info.id) byUserID.set(info.id, root)
        continue
      }
      current = { userMessageID: info.id, prompt: literalTextParts(message), answer: null, progress: [] }
      turns.push(current)
      if (info.id) byUserID.set(info.id, current)
      continue
    }
    if (info.role !== "assistant" || info.summary === true) continue
    const target = info.parentID ? byUserID.get(info.parentID) : current
    if (!target) continue
    const text = literalTextParts(message)
    if (!text.some((part) => part.trim())) continue
    if (info.finish === "stop" && Number.isFinite(info.time?.completed) && info.time.completed <= asOf && !info.error) {
      target.answer = text
      target.progress = []
    } else if (!target.answer) target.progress.push(text)
  }
  return turns
}

export function* sessionMarkdownChunks(turns, language = getLanguage(), title = "") {
  const heading = title || tFor(language, "export.document.title")
  yield `${toMarkdown({ type: "root", children: [{ type: "heading", depth: 1, children: [{ type: "text", value: heading }] }] })}\n`
  yield `${tFor(language, "export.document.description")}\n\n`
  for (const [index, turn] of turns.entries()) {
    yield `## ${tFor(language, "export.document.user", { index: index + 1 })}\n\n`
    yield* literalBlocks(turn.prompt)
    yield `## ${tFor(language, "export.document.final", { index: index + 1 })}\n\n`
    if (turn.answer) yield* literalBlocks(turn.answer)
    else yield `${tFor(language, "export.document.noFinal")}\n\n`
  }
  const notePrompts = turns.flatMap((turn, index) => !turn.answer && turn.progress.length ? [index + 1] : [])
  if (!notePrompts.length) return
  yield `## ${tFor(language, "export.document.progress")}\n\n`
  yield `${tFor(language, "export.document.progressScope", { prompts: notePrompts.join(", ") })}\n\n`
  for (const [index, turn] of turns.entries()) {
    if (turn.answer) continue
    for (const [note, text] of turn.progress.entries()) {
      yield `### ${tFor(language, "export.document.note", { index: index + 1, note: note + 1 })}\n\n`
      yield* literalBlocks(text)
    }
  }
}

export async function sendSessionExport({ config, opencode, telegram, binding, language = getLanguage() }) {
  const { title, turns } = await loadSessionExport({ opencode, binding })
  if (!turns.length) return { prompts: 0, finals: 0 }
  const root = config.telegram.botApi.spoolDir
  await fs.mkdir(root, { recursive: true, mode: 0o755 })
  // Reuse the existing abandoned-spool cleanup while keeping dialogue files private.
  const directory = path.join(root, `${Date.now()}-${randomUUID()}`)
  await fs.mkdir(directory, { mode: 0o700 })
  try {
    const filename = `session-${String(binding.sessionID).replace(/[^a-zA-Z0-9_.-]/g, "_")}.md`
    const localPath = path.join(directory, filename)
    const maxBytes = telegram.local ? telegramLocalMaxFileBytes : 50 * 1024 * 1024
    let bytes = 0
    const chunks = function* () {
      for (const chunk of sessionMarkdownChunks(turns, language, title)) {
        bytes += Buffer.byteLength(chunk, "utf8")
        if (bytes > maxBytes) {
          const error = new Error("Session export exceeds the Telegram document limit")
          error.code = "EXPORT_TOO_LARGE"
          throw error
        }
        yield chunk
      }
    }
    await fs.writeFile(localPath, chunks(), { flag: "wx", mode: 0o600 })
    const finals = turns.filter((turn) => turn.answer).length
    const blob = await openAsBlob(localPath, { type: "text/markdown; charset=utf-8" })
    await telegram.sendDocument({
      chatId: binding.chatId, topicId: binding.topicId,
      file: { blob, filename, size: bytes },
      caption: tFor(language, "export.caption", { prompts: turns.length, finals }),
    })
    return { prompts: turns.length, finals, bytes }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

function literalTextParts(message) {
  return (message.parts || [])
    .filter((part) => part.type === "text" && part.synthetic !== true && typeof part.text === "string")
    .map((part) => part.text)
}

function exportRelevantMessage(message) {
  const info = message.info || message
  return {
    info: { id: info.id, role: info.role, parentID: info.parentID, time: info.time,
      finish: info.finish, summary: info.summary, synthetic: info.synthetic, error: Boolean(info.error) },
    parts: (message.parts || []).filter((part) => ["text", "file", "compaction"].includes(part.type)).map((part) => {
      if (part.type === "compaction") return { type: part.type, turn_id: part.turn_id, replay_id: part.replay_id }
      if (part.type === "file") return { type: part.type, synthetic: part.synthetic }
      return { type: part.type, text: part.text, synthetic: part.synthetic,
        metadata: { opencodebot_reminder: part.metadata?.opencodebot_reminder } }
    }),
  }
}

function* literalBlocks(parts) {
  for (const text of parts.length ? parts : [""]) {
    let fenceLength = 3
    for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1)
    const fence = "`".repeat(fenceLength)
    yield `${fence}text\n`
    yield text
    yield `\n${fence}\n\n`
  }
}
