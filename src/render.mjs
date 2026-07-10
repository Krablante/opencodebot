import { clampTelegram, escapeHtml } from "./telegram.mjs"
import {
  formatToolLine,
  isHiddenTool,
  isTaskTool,
  shortError,
  shortUsefulResult,
  toolNameSet,
} from "./tool-formatting.mjs"
import {
  isRichMessageError,
  isTelegramFormattingError,
  preparePlainAssistantText,
  prepareRichMarkdown,
  toolQuoteMarkdownV2,
  withFinalAnswerMarker,
} from "./rich-markdown.mjs"
import { durationMs, logErrorEvent, logInfo, shouldLogSlow } from "./logger.mjs"
import { createRenderSideEffects } from "./render-side-effects.mjs"

export { formatToolLine } from "./tool-formatting.mjs"

export class MirrorRenderer {
  constructor({ telegram, state, config, onMirrorMessage, onFinalMessage }) {
    this.telegram = telegram
    this.state = state
    this.config = config
    this.effects = createRenderSideEffects({ telegram, config, onMirrorMessage, onFinalMessage })
    this.sessions = new Map()
    this.hiddenTools = toolNameSet(config.mirror?.hiddenTools || [])
  }

  async userPrompt(binding, text, origin = "web") {
    const messages = webPromptMessages(text, this.config.mirror.maxTelegramChars)
    let firstMessage = null
    let lastMessage = null
    for (const item of messages) {
      const message = await this.telegram.sendMessage({
        chatId: binding.chatId,
        topicId: binding.topicId,
        text: item,
      })
      firstMessage ||= message
      lastMessage = message
      await this.notifyMirrorMessage(binding, message)
    }
    if (firstMessage && this.shouldPinUserPrompts()) await this.pinMessage(binding, firstMessage.message_id, { origin: "web-prompt" })
    return lastMessage
  }

  async assistantMessage(binding, text, { final = true, assistantMessageID } = {}) {
    const value = String(text || "").trim()
    if (!value) return
    this.closeToolBatch(binding)
    const output = final ? withFinalAnswerMarker(value) : value
    const markdown = prepareRichMarkdown(output)
    const sent = await this.sendAssistantMarkdown(binding, markdown, output)
    await this.notifyMirrorMessage(binding, sent)
    if (final) await this.notifyFinalMessage(binding, { assistantMessageID, messageId: sent.message_id })
    return sent
  }

  async compactTools(binding, lines) {
    if (this.mirrorMode() !== "full") return
    for (const line of lines.filter(Boolean)) await this.appendToolLine(binding, line)
  }

  async reasoning(binding, text) {
    // Reasoning parts are hidden in the web UI and are intentionally not mirrored.
    return
  }

  async textDelta(binding, properties) {
    const key = this.key(binding)
    const session = this.ensureSession(key)
    const textKey = properties.textID || properties.assistantMessageID || "assistant"
    let block = session.texts.get(textKey)
    if (!block) {
      this.closeToolBatch(binding)
      block = { text: "", messageId: null, timer: null, assistantMessageID: properties.assistantMessageID }
      session.texts.set(textKey, block)
    }
    block.assistantMessageID ||= properties.assistantMessageID
    block.text += properties.delta || ""
  }

  async textEnded(binding, properties) {
    const key = this.key(binding)
    const session = this.ensureSession(key)
    const textKey = properties.textID || properties.assistantMessageID || "assistant"
    let block = session.texts.get(textKey)
    if (!block) {
      this.closeToolBatch(binding)
      block = { text: "", messageId: null, timer: null, assistantMessageID: properties.assistantMessageID }
      session.texts.set(textKey, block)
    }
    block.assistantMessageID ||= properties.assistantMessageID
    block.text = properties.text || block.text
    await this.flushText(binding, block, true)
    if (session.pendingFinalAssistantIds.has(block.assistantMessageID)) {
      session.pendingFinalAssistantIds.delete(block.assistantMessageID)
      await this.finalAssistantMessageReady(binding, block.assistantMessageID)
    }
  }

  async toolCalled(binding, properties) {
    const session = this.ensureSession(this.key(binding))
    if (session.tools.closed) session.tools = newToolBatch()
    const input = properties.input || {}
    const tool = properties.tool || "tool"
    if (isTaskTool(tool, input)) {
      if (properties.callID && session.announcedTaskCalls.has(properties.callID)) return
      if (hasSubagentSpawnTitle(input)) {
        await this.announceSubagentSpawn(binding, input)
        if (properties.callID) session.announcedTaskCalls.add(properties.callID)
      }
      if (properties.callID) session.hiddenToolCalls.add(properties.callID)
      return
    }
    if (properties.callID && (session.finishedToolCalls.has(properties.callID) || session.tools.calls.has(properties.callID) || session.hiddenToolCalls.has(properties.callID))) return
    if (!this.shouldMirrorTool(tool, input)) {
      if (properties.callID) session.hiddenToolCalls.add(properties.callID)
      return
    }
    session.tools.calls.set(properties.callID, {
      tool,
      input,
      reportedOnStart: false,
    })
  }

  async toolResult(binding, properties, ok) {
    const session = this.ensureSession(this.key(binding))
    if (properties.callID && session.hiddenToolCalls.has(properties.callID)) {
      session.hiddenToolCalls.delete(properties.callID)
      rememberBounded(session.finishedToolCalls, properties.callID, 500)
      return
    }
    if (properties.callID && session.finishedToolCalls.has(properties.callID)) return
    const call = session.tools.calls.get(properties.callID) || { tool: properties.tool || "tool", input: properties.input || {} }
    session.tools.calls.delete(properties.callID)
    if (properties.callID) rememberBounded(session.finishedToolCalls, properties.callID, 500)
    if (!this.shouldMirrorTool(call.tool, call.input)) return
    if (call.reportedOnStart && ok) return
    const suffix = ok ? shortUsefulResult(properties) : shortError(properties)
    await this.appendToolLine(binding, formatToolLine(call.tool, call.input, ok, suffix))
  }

  async flushText(binding, block, force) {
    const startedAt = Date.now()
    const rawText = block.finalMarked ? withFinalAnswerMarker(block.text || "...") : block.text || "..."
    const payload = block.richFallback ? preparePlainAssistantText(rawText, this.config) : prepareRichMarkdown(rawText)
    if (!block.messageId) {
      const sent = await this.sendAssistantMarkdown(binding, payload, rawText, block)
      block.messageId = sent.message_id
      await this.notifyMirrorMessage(binding, sent)
      this.rememberAssistantMessage(binding, block.assistantMessageID, block.messageId)
      logMirrorFlush("mirror.text.sent", binding, {
        assistantMessageID: block.assistantMessageID,
        messageId: block.messageId,
        chars: block.text?.length || 0,
        durationMs: durationMs(startedAt),
      })
      return block.messageId
    }
    if (block.richFallback) {
      await ignoreEditRace(() => this.telegram.editMessageText({ chatId: binding.chatId, messageId: block.messageId, text: payload }))
    } else {
      try {
        await ignoreEditRace(() =>
          this.telegram.editRichMessage({
            chatId: binding.chatId,
            messageId: block.messageId,
            markdown: payload,
            skipEntityDetection: true,
          }),
        )
      } catch (error) {
        if (!isRichMessageError(error)) throw error
        block.richFallback = true
        await ignoreEditRace(() =>
          this.telegram.editMessageText({
            chatId: binding.chatId,
            messageId: block.messageId,
            text: preparePlainAssistantText(rawText, this.config),
          }),
        )
      }
    }
    this.rememberAssistantMessage(binding, block.assistantMessageID, block.messageId)
    const elapsedMs = durationMs(startedAt)
    if (force || shouldLogSlow(elapsedMs)) {
      logMirrorFlush("mirror.text.edited", binding, {
        assistantMessageID: block.assistantMessageID,
        messageId: block.messageId,
        chars: block.text?.length || 0,
        force,
        durationMs: elapsedMs,
      })
    }
    return block.messageId
  }

  async sendAssistantMarkdown(binding, markdown, rawText, block) {
    try {
      return await this.telegram.sendRichMessage({
        chatId: binding.chatId,
        topicId: binding.topicId,
        markdown,
        skipEntityDetection: true,
      })
    } catch (error) {
      if (!isRichMessageError(error)) throw error
      if (block) block.richFallback = true
      return this.telegram.sendMessage({
        chatId: binding.chatId,
        topicId: binding.topicId,
        text: preparePlainAssistantText(rawText, this.config),
      })
    }
  }

  async flushTools(binding, tools) {
    const startedAt = Date.now()
    const wasNew = !tools.messageId
    const text = clampTelegram((tools.truncated ? "...\n" : "") + tools.lines.join("\n"), this.config.mirror.maxTelegramChars)
    const markdown = toolQuoteMarkdownV2(text)
    if (!tools.messageId) {
      const sent = await this.sendToolQuote(binding, markdown, text, tools)
      tools.messageId = sent.message_id
      await this.notifyMirrorMessage(binding, sent)
    } else if (tools.formatFallback) {
      await ignoreEditRace(() => this.telegram.editMessageText({ chatId: binding.chatId, messageId: tools.messageId, text, format: "plain" }))
    } else {
      try {
        await ignoreEditRace(() =>
          this.telegram.editMessageText({
            chatId: binding.chatId,
            messageId: tools.messageId,
            text: markdown,
            format: "markdownv2",
          }),
        )
      } catch (error) {
        if (!isTelegramFormattingError(error)) throw error
        tools.formatFallback = true
        await ignoreEditRace(() => this.telegram.editMessageText({ chatId: binding.chatId, messageId: tools.messageId, text, format: "plain" }))
      }
    }
    const elapsedMs = durationMs(startedAt)
    if (wasNew || shouldLogSlow(elapsedMs)) {
      logMirrorFlush("mirror.tools.flushed", binding, {
        messageId: tools.messageId,
        lines: tools.lines.length,
        truncated: tools.truncated,
        fallback: tools.formatFallback,
        newMessage: wasNew,
        durationMs: elapsedMs,
      })
    }
  }

  async sendToolQuote(binding, markdown, fallbackText, tools) {
    try {
      return await this.telegram.sendMessage({
        chatId: binding.chatId,
        topicId: binding.topicId,
        text: markdown,
        format: "markdownv2",
      })
    } catch (error) {
      if (!isTelegramFormattingError(error)) throw error
      tools.formatFallback = true
      return this.telegram.sendMessage({ chatId: binding.chatId, topicId: binding.topicId, text: fallbackText, format: "plain" })
    }
  }

  async appendToolLine(binding, line) {
    const session = this.ensureSession(this.key(binding))
    if (session.tools.closed) session.tools = newToolBatch()
    session.tools.lines.push(line)
    if (session.tools.lines.length > this.config.mirror.toolBatchMaxLines) {
      session.tools.lines = session.tools.lines.slice(-this.config.mirror.toolBatchMaxLines)
      session.tools.truncated = true
    }
    const startedAt = Date.now()
    await this.flushTools(binding, session.tools)
    const elapsedMs = durationMs(startedAt)
    if (shouldLogSlow(elapsedMs)) {
      logMirrorFlush("mirror.tool_line.slow", binding, {
        lines: session.tools.lines.length,
        durationMs: elapsedMs,
      })
    }
  }

  async announceSubagentSpawn(binding, input = {}) {
    this.closeToolBatch(binding)
    await this.telegram.sendMessage({
      chatId: binding.chatId,
      topicId: binding.topicId,
      text: subagentSpawnMessage(input),
    })
  }

  closeToolBatch(binding) {
    const session = this.sessions.get(this.key(binding))
    if (session?.tools) session.tools.closed = true
  }

  async pinMessage(binding, messageId, fields = {}) {
    return this.effects.pinMessage(binding, messageId, fields)
  }

  async finalAssistantMessageReady(binding, assistantMessageID) {
    if (!assistantMessageID) return
    const session = this.ensureSession(this.key(binding))
    const messageId = session?.assistantLastMessageIds.get(assistantMessageID)
    if (!messageId) {
      session.pendingFinalAssistantIds.add(assistantMessageID)
      return
    }
    await this.markFinalAssistantMessage(binding, session, assistantMessageID, messageId)
    await this.notifyFinalMessage(binding, { assistantMessageID, messageId })
    this.sessions.delete(this.key(binding))
  }

  shouldPinUserPrompts() {
    return this.effects.shouldPinUserPrompts()
  }

  async markFinalAssistantMessage(binding, session, assistantMessageID, messageId) {
    const startedAt = Date.now()
    const block = findAssistantBlock(session, assistantMessageID)
    if (!block || block.finalMarked) return
    const rawText = withFinalAnswerMarker(block.text || "...")
    if (block.richFallback) {
      await ignoreEditRace(() =>
        this.telegram.editMessageText({
          chatId: binding.chatId,
          messageId,
          text: preparePlainAssistantText(rawText, this.config),
        }),
      )
    } else {
      try {
        await ignoreEditRace(() =>
          this.telegram.editRichMessage({
            chatId: binding.chatId,
            messageId,
            markdown: prepareRichMarkdown(rawText),
            skipEntityDetection: true,
          }),
        )
      } catch (error) {
        if (!isRichMessageError(error)) throw error
        block.richFallback = true
        await ignoreEditRace(() =>
          this.telegram.editMessageText({
            chatId: binding.chatId,
            messageId,
            text: preparePlainAssistantText(rawText, this.config),
          }),
        )
      }
    }
    block.finalMarked = true
    logMirrorFlush("mirror.final_marked", binding, {
      assistantMessageID,
      messageId,
      durationMs: durationMs(startedAt),
    })
  }

  rememberAssistantMessage(binding, assistantMessageID, messageId) {
    if (!assistantMessageID || !messageId) return
    const session = this.ensureSession(this.key(binding))
    session.assistantLastMessageIds.set(assistantMessageID, messageId)
  }

  ensureSession(key) {
    let session = this.sessions.get(key)
    if (!session) {
      session = {
        texts: new Map(),
        tools: newToolBatch(),
        assistantLastMessageIds: new Map(),
        hiddenToolCalls: new Set(),
        announcedTaskCalls: new Set(),
        finishedToolCalls: new Set(),
        pendingFinalAssistantIds: new Set(),
      }
      this.sessions.set(key, session)
    }
    return session
  }

  async notifyMirrorMessage(binding, message) {
    await this.effects.notifyMirrorMessage(binding, message)
  }

  async notifyFinalMessage(binding, details) {
    await this.effects.notifyFinalMessage(binding, details)
  }

  shouldMirrorTool(tool, input = {}) {
    if (this.mirrorMode() !== "full") return false
    if (isTaskTool(tool, input)) return false
    return !isHiddenTool(tool, this.hiddenTools)
  }

  mirrorMode() {
    return this.state?.mirrorMode?.() === "economy" ? "economy" : "full"
  }

  key(binding) {
    return `${binding.serverID}:${binding.sessionID}`
  }
}

export function webPromptMessages(text, maxTelegramChars = 3900) {
  const value = String(text ?? "")
  const single = `💬 ${escapeHtml(value)}`
  if (single.length <= maxTelegramChars) return [single]
  const chunks = splitEscapedText(value, Math.max(1, maxTelegramChars - 120))
  return chunks.map((chunk, index) => `💬 Web prompt ${index + 1}/${chunks.length}\n\n${escapeHtml(chunk)}`)
}

function splitEscapedText(text, maxEscapedChars) {
  const value = String(text ?? "")
  if (!value) return [""]
  const chunks = []
  let current = ""
  let currentEscapedLength = 0
  let lastBreakIndex = -1
  for (const char of value) {
    const charEscapedLength = escapeHtml(char).length
    if (current && currentEscapedLength + charEscapedLength > maxEscapedChars) {
      let chunk = current
      let carry = ""
      if (lastBreakIndex > Math.floor(current.length * 0.45)) {
        chunk = current.slice(0, lastBreakIndex).trimEnd()
        carry = current.slice(lastBreakIndex).trimStart()
      }
      chunks.push(chunk || current)
      current = carry
      currentEscapedLength = escapeHtml(current).length
      lastBreakIndex = -1
    }
    current += char
    currentEscapedLength += charEscapedLength
    if (/\s/.test(char)) lastBreakIndex = current.length
  }
  if (current || !chunks.length) chunks.push(current)
  return chunks
}

function newToolBatch() {
  return { calls: new Map(), lines: [], messageId: null, truncated: false, closed: false, formatFallback: false }
}

function rememberBounded(set, value, maxSize) {
  set.add(value)
  while (set.size > maxSize) set.delete(set.values().next().value)
}

function subagentSpawnMessage(input = {}) {
  const title = shortText(subagentSpawnTitle(input), 140)
  return `🤖 Subagent spawned: <code>${escapeHtml(title)}</code>`
}

function hasSubagentSpawnTitle(input = {}) {
  return Boolean(subagentSpawnTitle(input))
}

function subagentSpawnTitle(input = {}) {
  return firstText(input.description, input.title, input.name, input.subagent_type, input.agent)
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || "").replace(/\s+/g, " ").trim()
    if (text) return text
  }
  return ""
}

function shortText(value, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3))}...` : text
}

function findAssistantBlock(session, assistantMessageID) {
  if (!session || !assistantMessageID) return null
  for (const block of session.texts.values()) {
    if (block.assistantMessageID === assistantMessageID) return block
  }
  return null
}

async function ignoreEditRace(fn) {
  try {
    await fn()
  } catch (error) {
    if (/message is not modified/i.test(error.message)) return
    if (/Too Many Requests/i.test(error.message)) {
      logErrorEvent("telegram.edit.rate_limited_after_retry", error)
      return
    }
    throw error
  }
}

function logMirrorFlush(event, binding, fields = {}) {
  logInfo(event, {
    serverID: binding.serverID,
    sessionID: binding.sessionID,
    topicId: binding.topicId,
    ...fields,
  })
}
