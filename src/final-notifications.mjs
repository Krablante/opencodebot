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
      const promptText = await finalPromptText({ opencode, binding, assistantMessageID })
      const replyMarkup = finalNotificationReplyMarkup(link)
      const text = finalNotificationMarkdown({ title, serverID: binding.serverID, promptText })
      const fallbackText = finalNotificationFallbackHtml({ title, serverID: binding.serverID })
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

function finalNotificationMarkdown({ title, serverID, promptText }) {
  const lines = [
    "🏁 *Final answer is ready*",
    `🧵 *${escapeMarkdownV2(title)}*`,
    `🖥️ Server: ${escapeMarkdownV2(serverID)}`,
  ]
  if (promptText) lines.push("", toolQuoteMarkdownV2(promptText))
  return lines.join("\n")
}

function finalNotificationFallbackHtml({ title, serverID }) {
  return [
    "🏁 Final answer is ready",
    `🧵 <b>${escapeHtml(title)}</b>`,
    `🖥️ Server: <code>${escapeHtml(serverID)}</code>`,
  ].join("\n")
}

function finalNotificationReplyMarkup(link) {
  if (!link) return undefined
  return { inline_keyboard: [[{ text: "Open topic", url: link }]] }
}

async function finalPromptText({ opencode, binding, assistantMessageID }) {
  try {
    const messages = await opencode.messages(binding.serverID, binding.sessionID)
    return promptTextBeforeAssistant(messages, assistantMessageID)
  } catch (error) {
    logErrorEvent("final_notification.prompt_lookup_failed", error, {
      serverID: binding.serverID,
      sessionID: binding.sessionID,
      assistantMessageID,
    })
    return ""
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
