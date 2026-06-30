import { textFromPrompt } from "./opencode.mjs"
import { escapeMarkdownV2, toolQuoteMarkdownV2 } from "./rich-markdown.mjs"
import { escapeHtml, telegramMessageLink } from "./telegram.mjs"
import { logErrorEvent, logInfo } from "./logger.mjs"

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
      const summary = await finalSessionSummary({ opencode, binding, assistantMessageID })
      const replyMarkup = finalNotificationReplyMarkup(link)
      const text = finalNotificationMarkdown({ topicSource, serverID: binding.serverID, promptText: summary.promptText, completedTodos: summary.completedTodos })
      const fallbackText = finalNotificationFallbackHtml({ topicSource, serverID: binding.serverID, completedTodos: summary.completedTodos })
      const compactText = finalNotificationCompactHtml({ topicSource, serverID: binding.serverID })
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

export function finalNotificationMarkdown({ topicSource, serverID, promptText, completedTodos = [] }) {
  const lines = [
    "🏁 *Final answer is ready*",
    finalNotificationTopicMarkdown(topicSource),
    `🖥️ Server: ${escapeMarkdownV2(serverID)}`,
  ]
  const prompt = truncateNotificationText(promptText, FINAL_NOTIFICATION_PROMPT_CHARS)
  if (prompt) lines.push("", toolQuoteMarkdownV2(prompt))
  const todoLines = formatCompletedTodoMarkdown(completedTodos, { maxItems: FINAL_NOTIFICATION_TODO_ITEMS, maxItemChars: FINAL_NOTIFICATION_TODO_CHARS })
  if (todoLines.length) lines.push("", ...todoLines)
  return clampNotificationMarkdown(lines)
}

function finalNotificationFallbackHtml({ topicSource, serverID, completedTodos = [] }) {
  const lines = [
    "🏁 Final answer is ready",
    finalNotificationTopicHtml(topicSource),
    `🖥️ Server: <code>${escapeHtml(serverID)}</code>`,
  ]
  const todoLines = formatCompletedTodoHtml(completedTodos, { maxItems: FINAL_NOTIFICATION_TODO_ITEMS, maxItemChars: FINAL_NOTIFICATION_TODO_CHARS })
  if (todoLines.length) lines.push("", ...todoLines)
  return lines.join("\n")
}

function finalNotificationCompactHtml({ topicSource, serverID }) {
  return [
    "🏁 Final answer is ready",
    finalNotificationTopicHtml(topicSource),
    `🖥️ Server: <code>${escapeHtml(serverID)}</code>`,
  ].join("\n")
}

function clampNotificationMarkdown(lines) {
  let text = lines.join("\n")
  if (text.length <= FINAL_NOTIFICATION_SAFE_CHARS) return text
  const compact = lines.slice(0, 3)
  compact.push("", toolQuoteMarkdownV2("Notification context was too long and was trimmed. Open the topic for full context."))
  text = compact.join("\n")
  return text.length <= FINAL_NOTIFICATION_SAFE_CHARS ? text : text.slice(0, FINAL_NOTIFICATION_SAFE_CHARS - 3) + "..."
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

async function finalSessionSummary({ opencode, binding, assistantMessageID }) {
  try {
    const messages = await opencode.messages(binding.serverID, binding.sessionID, { directory: binding.directory })
    return {
      promptText: promptTextBeforeAssistant(messages, assistantMessageID),
      completedTodos: completedTodosBeforeAssistant(messages, assistantMessageID),
    }
  } catch (error) {
    logErrorEvent("final_notification.session_summary_lookup_failed", error, {
      serverID: binding.serverID,
      sessionID: binding.sessionID,
      assistantMessageID,
    })
    return { promptText: "", completedTodos: [] }
  }
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
