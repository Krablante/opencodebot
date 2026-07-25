import { logInfo } from "./logger.mjs"
import { clampTelegram, escapeHtml, telegramMessageLink } from "./telegram.mjs"
import { t } from "./i18n/index.mjs"

export function createRunAlerter({ config, state, telegram, logError = () => {} }) {
  const recipients = [...new Set((config.finalNotifications?.userIds || []).map(String))]

  async function notify({ binding, alertKey, kind, detail, topicMessageId, sessionUrl }) {
    if (!binding || !alertKey || !recipients.length) return 0
    let delivered = 0
    for (const userID of recipients) {
      if (state.runAlertSent(userID, alertKey)) continue
      try {
        await telegram.sendMessage({
          chatId: userID,
          text: runAlertText(binding, kind, detail),
          replyMarkup: runAlertMarkup(binding, topicMessageId, sessionUrl),
        })
        await state.markRunAlertSent(userID, alertKey)
        delivered += 1
        logInfo("run_alert.sent", {
          source: binding.serverID,
          sessionID: binding.sessionID,
          topicId: binding.topicId,
          userId: userID,
          alertKey,
          kind,
        })
      } catch (error) {
        logError(error, {
          event: "run_alert.send",
          serverID: binding.serverID,
          sessionID: binding.sessionID,
          topicId: binding.topicId,
          userID,
          alertKey,
          kind,
        })
      }
    }
    return delivered
  }

  return { notify }
}

function runAlertText(binding, kind, detail) {
  const title = t(kind === "interrupted" ? "runAlert.interrupted" : "runAlert.error")
  const topic = escapeHtml(binding.topicTitle || t("runAlert.topicFallback", { topicId: binding.topicId }))
  const source = escapeHtml(binding.serverID)
  const detailText = String(detail || t(kind === "interrupted" ? "runAlert.interruptedDetail" : "runAlert.failedDetail"))
  return [
    `${title}`,
    `💬 <b>${topic}</b>`,
    `🖥 <code>${source}</code>`,
    `<blockquote>${escapeHtml(clampTelegram(detailText, 1200))}</blockquote>`,
  ].join("\n")
}

function runAlertMarkup(binding, topicMessageId, sessionUrl) {
  const buttons = []
  const topicLink = telegramMessageLink(binding.chatId, topicMessageId || binding.topicId)
  if (topicLink) buttons.push({ text: t("runAlert.openTopic"), url: topicLink })
  if (sessionUrl) buttons.push({ text: t("runAlert.openSession"), url: sessionUrl })
  return buttons.length ? { inline_keyboard: [buttons] } : undefined
}
