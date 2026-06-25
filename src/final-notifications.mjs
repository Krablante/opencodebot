import { textFromPrompt } from "./opencode.mjs"
import { escapeMarkdownV2, toolQuoteMarkdownV2 } from "./rich-markdown.mjs"
import { escapeHtml, telegramMessageLink } from "./telegram.mjs"
import { logErrorEvent, logInfo } from "./logger.mjs"

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
      const title = binding.title || `Topic ${binding.topicId}`
      const summary = await finalSessionSummary({ opencode, binding, assistantMessageID })
      const replyMarkup = finalNotificationReplyMarkup(link)
      const text = finalNotificationMarkdown({ title, serverID: binding.serverID, promptText: summary.promptText, completedTodos: summary.completedTodos })
      const fallbackText = finalNotificationFallbackHtml({ title, serverID: binding.serverID, completedTodos: summary.completedTodos })
      for (const userId of userIds) {
        try {
          await sendFinalNotificationMessage({ telegram, userId, text, fallbackText, replyMarkup })
          logInfo("final_notification.sent", { userId, serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId, messageId })
        } catch (error) {
          logErrorEvent("final_notification.failed", error, { userId, serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId, messageId })
        }
      }
      await state.markFinalNotificationSent(binding.serverID, binding.sessionID, assistantMessageID, messageId, config.finalNotifications.maxSentMarkers)
    },
  }
}

async function sendFinalNotificationMessage({ telegram, userId, text, fallbackText, replyMarkup }) {
  try {
    await telegram.sendMessage({ chatId: userId, text, format: "markdownv2", disablePreview: true, replyMarkup })
  } catch (error) {
    if (!/can't parse entities|entity/i.test(error.message)) throw error
    logErrorEvent("final_notification.markdown_failed", error, { userId })
    await telegram.sendMessage({ chatId: userId, text: fallbackText, disablePreview: true, replyMarkup })
  }
}

function finalNotificationMarkdown({ title, serverID, promptText, completedTodos = [] }) {
  const lines = [
    "🏁 *Final answer is ready*",
    `🧵 *${escapeMarkdownV2(title)}*`,
    `🖥️ Server: ${escapeMarkdownV2(serverID)}`,
  ]
  if (promptText) lines.push("", toolQuoteMarkdownV2(promptText))
  const todoLines = formatCompletedTodoMarkdown(completedTodos)
  if (todoLines.length) lines.push("", ...todoLines)
  return lines.join("\n")
}

function finalNotificationFallbackHtml({ title, serverID, completedTodos = [] }) {
  const lines = [
    "🏁 Final answer is ready",
    `🧵 <b>${escapeHtml(title)}</b>`,
    `🖥️ Server: <code>${escapeHtml(serverID)}</code>`,
  ]
  const todoLines = formatCompletedTodoHtml(completedTodos)
  if (todoLines.length) lines.push("", ...todoLines)
  return lines.join("\n")
}

function finalNotificationReplyMarkup(link) {
  if (!link) return undefined
  return { inline_keyboard: [[{ text: "Open topic", url: link }]] }
}

async function finalSessionSummary({ opencode, binding, assistantMessageID }) {
  try {
    const messages = await opencode.messages(binding.serverID, binding.sessionID)
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
