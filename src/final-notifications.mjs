import { textFromPrompt } from "./opencode.mjs"
import { escapeMarkdownV2, toolQuoteMarkdownV2 } from "./rich-markdown.mjs"
import { escapeHtml, telegramMessageLink } from "./telegram.mjs"
import { logErrorEvent, logInfo } from "./logger.mjs"
import { changedFilesForTool, isHiddenTool, isTaskTool, toolNameSet, toolSummaryLabel } from "./tool-formatting.mjs"

const FINAL_NOTIFICATION_SAFE_CHARS = 3800
const FINAL_NOTIFICATION_PROMPT_CHARS = 1200
const FINAL_NOTIFICATION_TODO_ITEMS = 12
const FINAL_NOTIFICATION_TODO_CHARS = 140

export function createFinalNotifier({ config, state, telegram, opencode }) {
  return {
    async notifyFinalAnswerReady(binding, { assistantMessageID, messageId }) {
      if (config.finalNotifications?.enabled === false) return
      if (!messageId) return
      if (state.finalNotificationSent(binding.serverID, binding.sessionID, assistantMessageID, messageId)) return
      const configuredUserIds = new Set((config.finalNotifications?.userIds || []).map(String))
      const userIds = state.finalNotificationUserIds().filter((userId) => configuredUserIds.has(String(userId)))
      if (!userIds.length) return
      const link = telegramMessageLink(binding.chatId, messageId)
      const topicSource = finalNotificationTopicSource(binding)
      const summary = await finalSessionSummary({ opencode, binding, assistantMessageID, hiddenTools: config.mirror?.hiddenTools })
      const replyMarkup = finalNotificationReplyMarkup(link)
      const text = finalNotificationMarkdown({ topicSource, serverID: binding.serverID, ...summary })
      const fallbackText = finalNotificationFallbackHtml({ topicSource, serverID: binding.serverID, ...summary })
      const compactText = finalNotificationCompactHtml({ topicSource, serverID: binding.serverID, ...summary })
      let sentCount = 0
      for (const userId of userIds) {
        try {
          await sendFinalNotificationMessage({ telegram, userId, text, fallbackText, compactText, replyMarkup })
          sentCount += 1
          logInfo("final_notification.sent", { userId, serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId, messageId })
        } catch (error) {
          logErrorEvent("final_notification.failed", error, { userId, serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId, messageId })
        }
      }
      if (!sentCount) return
      await state.markFinalNotificationSent(binding.serverID, binding.sessionID, assistantMessageID, messageId, config.finalNotifications.maxSentMarkers)
    },
  }
}

async function sendFinalNotificationMessage({ telegram, userId, text, fallbackText, compactText, replyMarkup }) {
  try {
    await telegram.sendMessage({ chatId: userId, text, format: "markdownv2", disablePreview: true, replyMarkup })
  } catch (error) {
    if (/message is too long/i.test(error.message)) {
      logInfo("final_notification.too_long", { userId })
      await telegram.sendMessage({ chatId: userId, text: compactText, disablePreview: true, replyMarkup })
      return
    }
    if (!/can't parse entities|entity/i.test(error.message)) throw error
    logErrorEvent("final_notification.markdown_failed", error, { userId })
    await telegram.sendMessage({ chatId: userId, text: fallbackText, disablePreview: true, replyMarkup })
  }
}

export function finalNotificationMarkdown({ topicSource, serverID, promptText, completedTodos = [], tools = [], patchedFiles = [] }) {
  const lines = [
    "🏁 *Final answer is ready*",
    finalNotificationTopicMarkdown(topicSource),
    `🖥️ Server: ${escapeMarkdownV2(serverID)}`,
  ]
  const prompt = truncateNotificationText(promptText, FINAL_NOTIFICATION_PROMPT_CHARS)
  if (prompt) lines.push("", toolQuoteMarkdownV2(prompt))
  const todoLines = formatCompletedTodoMarkdown(completedTodos, { maxItems: FINAL_NOTIFICATION_TODO_ITEMS, maxItemChars: FINAL_NOTIFICATION_TODO_CHARS })
  if (todoLines.length) lines.push("", ...todoLines)
  const toolLines = formatToolSummaryMarkdown(tools, patchedFiles)
  if (toolLines.length) lines.push("", ...toolLines)
  return clampNotificationMarkdown(lines, toolLines)
}

function finalNotificationFallbackHtml({ topicSource, serverID, completedTodos = [], tools = [], patchedFiles = [] }) {
  const lines = [
    "🏁 Final answer is ready",
    finalNotificationTopicHtml(topicSource),
    `🖥️ Server: <code>${escapeHtml(serverID)}</code>`,
  ]
  const todoLines = formatCompletedTodoHtml(completedTodos, { maxItems: FINAL_NOTIFICATION_TODO_ITEMS, maxItemChars: FINAL_NOTIFICATION_TODO_CHARS })
  if (todoLines.length) lines.push("", ...todoLines)
  const toolLines = formatToolSummaryHtml(tools, patchedFiles)
  if (toolLines.length) lines.push("", ...toolLines)
  return lines.join("\n")
}

function finalNotificationCompactHtml({ topicSource, serverID, tools = [], patchedFiles = [] }) {
  const lines = [
    "🏁 Final answer is ready",
    finalNotificationTopicHtml(topicSource),
    `🖥️ Server: <code>${escapeHtml(serverID)}</code>`,
  ]
  const toolLines = formatToolSummaryHtml(tools, patchedFiles)
  if (toolLines.length) lines.push("", ...toolLines)
  return lines.join("\n")
}

function clampNotificationMarkdown(lines, importantTail = []) {
  let text = lines.join("\n")
  if (text.length <= FINAL_NOTIFICATION_SAFE_CHARS) return text
  const compact = lines.slice(0, 3)
  compact.push("", toolQuoteMarkdownV2("Notification context was too long and was trimmed. Open the topic for full context."))
  if (importantTail.length) compact.push("", ...importantTail)
  text = compact.join("\n")
  return text.length <= FINAL_NOTIFICATION_SAFE_CHARS ? text : text.slice(0, FINAL_NOTIFICATION_SAFE_CHARS - 3) + "..."
}

function formatToolSummaryMarkdown(tools, patchedFiles) {
  const lines = []
  const toolText = summarizeItems(
    tools.map((tool) => `${tool.name} × ${tool.count}${tool.failed ? ` (${tool.failed} failed)` : ""}`),
    900,
  )
  const patchedText = summarizeItems(patchedFileDisplayNames(patchedFiles), 2200)
  if (toolText) lines.push(`🔧 Tools: ${toolText}`)
  if (patchedText) lines.push(`🩹 Patched: ${patchedText}`)
  return lines.length ? toolQuoteMarkdownV2(lines.join("\n")).split("\n") : []
}

function formatToolSummaryHtml(tools, patchedFiles) {
  const lines = []
  const toolText = summarizeItems(
    tools.map((tool) => `${tool.name} × ${tool.count}${tool.failed ? ` (${tool.failed} failed)` : ""}`),
    900,
  )
  const patchedText = summarizeItems(patchedFileDisplayNames(patchedFiles), 2200)
  if (toolText) lines.push(`🔧 Tools: ${toolText}`)
  if (patchedText) lines.push(`🩹 Patched: ${patchedText}`)
  return lines.length ? [`<blockquote>${lines.map((line) => escapeHtml(line)).join("\n")}</blockquote>`] : []
}

function summarizeItems(values, maxChars) {
  const items = values.map((value) => String(value || "").trim()).filter(Boolean)
  const visible = []
  for (let index = 0; index < items.length; index += 1) {
    const remaining = items.length - visible.length
    const suffix = remaining > 1 ? `; +${remaining} more` : ""
    const candidate = [...visible, items[index]].join("; ")
    if (candidate.length + suffix.length > maxChars && visible.length) break
    visible.push(items[index])
  }
  if (visible.length === items.length) return visible.join("; ")
  return `${visible.join("; ")}; +${items.length - visible.length} more`
}

function patchedFileDisplayNames(values) {
  return [...new Set(values.map(fileDisplayName).filter(Boolean))]
}

function fileDisplayName(value) {
  const text = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "")
  if (!text) return ""
  const parts = text.split("/").filter(Boolean)
  return parts.length ? parts[parts.length - 1] : text
}

function truncateNotificationText(value, maxChars) {
  const text = String(value || "").trim()
  if (!text || text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 16)).trimEnd()}... [trimmed]`
}

function finalNotificationReplyMarkup(link) {
  if (!link) return undefined
  return { inline_keyboard: [[{ text: "Open topic", url: link }]] }
}

function finalNotificationTopicSource(binding) {
  return {
    title: String(binding?.topicTitle || `Topic ${binding?.topicId || ""}`).trim(),
    iconCustomEmojiId: normalizeCustomEmojiId(binding?.topicIconCustomEmojiId),
    iconEmoji: normalizeTopicIconEmoji(binding?.topicIconEmoji),
  }
}

export { finalNotificationTopicSource }

function finalNotificationTopicMarkdown(topicSource) {
  const icon = topicSource?.iconCustomEmojiId ? `![${escapeMarkdownV2(topicSource.iconEmoji || "💬")}](tg://emoji?id=${topicSource.iconCustomEmojiId}) ` : ""
  return `💬 *Topic:* ${icon}${escapeMarkdownV2(topicSource?.title || "Topic")}`
}

function finalNotificationTopicHtml(topicSource) {
  const icon = topicSource?.iconCustomEmojiId ? `<tg-emoji emoji-id="${escapeHtml(topicSource.iconCustomEmojiId)}">${escapeHtml(topicSource.iconEmoji || "💬")}</tg-emoji> ` : ""
  return `💬 Topic: ${icon}<b>${escapeHtml(topicSource?.title || "Topic")}</b>`
}

function normalizeCustomEmojiId(value) {
  const id = String(value || "").trim()
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : ""
}

function normalizeTopicIconEmoji(value) {
  const emoji = String(value || "").trim()
  return emoji.length <= 8 ? emoji : ""
}

async function finalSessionSummary({ opencode, binding, assistantMessageID, hiddenTools }) {
  try {
    const messages = await opencode.messages(binding.serverID, binding.sessionID, { directory: binding.directory })
    return {
      promptText: promptTextBeforeAssistant(messages, assistantMessageID),
      completedTodos: completedTodosBeforeAssistant(messages, assistantMessageID),
      ...toolSummaryBeforeAssistant(messages, assistantMessageID, hiddenTools),
    }
  } catch (error) {
    logErrorEvent("final_notification.session_summary_lookup_failed", error, {
      serverID: binding.serverID,
      sessionID: binding.sessionID,
      assistantMessageID,
    })
    return { promptText: "", completedTodos: [], tools: [], patchedFiles: [] }
  }
}

export function toolSummaryBeforeAssistant(messages, assistantMessageID, hiddenToolNames = []) {
  if (!Array.isArray(messages) || !messages.length) return { tools: [], patchedFiles: [] }
  const stopIndex = assistantMessageIndex(messages, assistantMessageID)
  let startIndex = -1
  for (let index = stopIndex - 1; index >= 0; index -= 1) {
    if (messageRole(messages[index]) !== "user") continue
    startIndex = index
    break
  }
  const hiddenTools = toolNameSet(hiddenToolNames)
  const counts = new Map()
  const patchedFiles = []
  const seenParts = new Set()
  for (let messageIndex = startIndex + 1; messageIndex <= stopIndex; messageIndex += 1) {
    const message = messages[messageIndex]
    if (messageRole(message) !== "assistant") continue
    for (const [partIndex, part] of (message.parts || []).entries()) {
      if (part?.type !== "tool") continue
      const partID = String(part.id || `${messageID(message)}:${partIndex}`)
      if (seenParts.has(partID)) continue
      seenParts.add(partID)
      const input = normalizeToolInput(part.state?.input ?? part.input) || {}
      const tool = part.tool || part.name || "tool"
      if (isTaskTool(tool, input) || isHiddenTool(tool, hiddenTools)) continue
      const label = toolSummaryLabel(tool, input)
      const status = String(part.state?.status || part.status || "").toLowerCase()
      const current = counts.get(label) || { name: label, count: 0, failed: 0, order: counts.size }
      current.count += 1
      if (status === "error" || status === "failed") current.failed += 1
      counts.set(label, current)
      if (status === "completed" || status === "success") patchedFiles.push(...changedFilesForTool(tool, input))
    }
  }
  const tools = [...counts.values()]
    .sort((left, right) => right.count - left.count || left.order - right.order)
    .map(({ name, count, failed }) => ({ name, count, failed }))
  return { tools, patchedFiles: [...new Set(patchedFiles)] }
}

function assistantMessageIndex(messages, assistantMessageID) {
  if (assistantMessageID) {
    const index = messages.findIndex((message) => messageID(message) === assistantMessageID)
    if (index >= 0) return index
  }
  return messages.length - 1
}

function messageID(message) {
  return String(message?.info?.id || message?.id || "")
}

function messageRole(message) {
  return String(message?.info?.role || message?.role || "")
}

function promptTextBeforeAssistant(messages, assistantMessageID) {
  if (!Array.isArray(messages) || !messages.length) return ""
  let stopIndex = messages.length
  if (assistantMessageID) {
    const index = messages.findIndex((message) => message?.info?.id === assistantMessageID || message?.id === assistantMessageID)
    if (index >= 0) stopIndex = index
  }
  for (let index = stopIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.info?.role !== "user" && message?.role !== "user") continue
    const text = textFromMessagePrompt(message)
    if (text) return text
  }
  return ""
}

function textFromMessagePrompt(message) {
  const fromPrompt = textFromPrompt(message?.prompt)
  if (fromPrompt) return fromPrompt
  const fromMessage = textFromPrompt(message)
  if (fromMessage) return fromMessage
  return textFromPrompt(message?.content)
}

export function completedTodosBeforeAssistant(messages, assistantMessageID) {
  if (!Array.isArray(messages) || !messages.length) return []
  let stopIndex = messages.length
  if (assistantMessageID) {
    const index = messages.findIndex((message) => message?.info?.id === assistantMessageID || message?.id === assistantMessageID)
    if (index >= 0) stopIndex = index
  }
  for (let messageIndex = stopIndex - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = Array.isArray(messages[messageIndex]?.parts) ? messages[messageIndex].parts : []
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const todos = todosFromToolPart(parts[partIndex])
      if (todos === null) continue
      return todos.length > 0 && todos.every((todo) => todo.status === "completed") ? todos.map((todo) => todo.content).filter(Boolean) : []
    }
  }
  return []
}

function todosFromToolPart(part) {
  if (part?.type !== "tool" || part?.tool !== "todowrite") return null
  if (part.state?.status && part.state.status !== "completed") return []
  const input = normalizeToolInput(part.state?.input ?? part.input)
  const todos = Array.isArray(input?.todos) ? input.todos : []
  return todos
    .map((todo) => ({ content: String(todo?.content || "").trim(), status: String(todo?.status || "") }))
    .filter((todo) => todo.content)
}

function normalizeToolInput(input) {
  if (!input || typeof input !== "string") return input
  try {
    return JSON.parse(input)
  } catch {
    return {}
  }
}

export function formatCompletedTodoMarkdown(todos, { maxItems = 16, maxItemChars = 160 } = {}) {
  const lines = formatCompletedTodoLines(todos, { maxItems, maxItemChars })
  return lines.length ? toolQuoteMarkdownV2(lines.join("\n")).split("\n") : []
}

function formatCompletedTodoHtml(todos, { maxItems = 16, maxItemChars = 160 } = {}) {
  const lines = formatCompletedTodoLines(todos, { maxItems, maxItemChars })
  return lines.length ? [`<blockquote>${lines.map((line) => escapeHtml(line)).join("\n")}</blockquote>`] : []
}

function formatCompletedTodoLines(todos, { maxItems, maxItemChars }) {
  const items = clampTodoItems(todos, { maxItems, maxItemChars })
  if (!items.visible.length) return []
  const lines = [`📋 Tasks [${items.visible.length}/${items.total}]:`]
  items.visible.forEach((item, index) => lines.push(`✅ ${index + 1}. ${item}`))
  if (items.hidden > 0) lines.push(`✅ ${items.visible.length + 1}. and ${items.hidden} more`)
  return lines
}

function clampTodoItems(todos, { maxItems, maxItemChars }) {
  const all = Array.isArray(todos) ? todos.map((item) => String(item || "").trim()).filter(Boolean) : []
  const visible = all.slice(0, maxItems).map((item) => (item.length > maxItemChars ? `${item.slice(0, maxItemChars - 3)}...` : item))
  return { visible, hidden: Math.max(0, all.length - visible.length), total: all.length }
}
