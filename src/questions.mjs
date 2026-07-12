import { clampTelegram, escapeHtml, telegramMessageLink } from "./telegram.mjs"

const CALLBACK_PREFIX = "oq:"

export function createQuestionManager({ config, state, telegram, opencode, logError = () => {} }) {
  const inflight = new Set()

  async function handleEvent(server, binding, event) {
    if (event.type === "question.asked") return handleAsked(server, binding, event.properties)
    if (event.type === "question.replied") return handleResolved(event.properties.requestID, "answered", event.properties.answers || [])
    if (event.type === "question.rejected") return handleResolved(event.properties.requestID, "rejected", [])
    return false
  }

  async function handleAsked(server, binding, info) {
    const existing = state.questionRecord(info.id)
    if (existing?.status === "pending" && existing.messageId) {
      await telegram.editMessageText({
        chatId: existing.chatId,
        messageId: existing.messageId,
        text: renderQuestion(existing),
        replyMarkup: questionReplyMarkup(existing),
      })
      return true
    }
    if (inflight.has(info.id)) return true
    inflight.add(info.id)
    try {
      const questions = normalizeQuestions(info.questions)
      const question = questions.length === 1 ? questions[0] : null
      const record = {
        requestID: info.id,
        serverID: server.id,
        sessionID: info.sessionID,
        chatId: binding.chatId,
        topicId: binding.topicId,
        directory: binding.directory,
        status: "pending",
        interactive: Boolean(question && !question.multiple && question.options.length),
        question,
        questions,
        answers: [],
        notifiedUserIds: existing?.notifiedUserIds || [],
        createdAt: existing?.createdAt || new Date().toISOString(),
      }
      const sent = await telegram.sendMessage({
        chatId: binding.chatId,
        topicId: binding.topicId,
        text: renderQuestion(record),
        replyMarkup: questionReplyMarkup(record),
      })
      record.messageId = sent.message_id
      await state.upsertQuestion(record)
      await notifyRecipients(binding, record)
      return true
    } finally {
      inflight.delete(info.id)
    }
  }

  async function handleResolved(requestID, status, answers) {
    const record = state.questionRecord(requestID)
    if (!record) return false
    await state.resolveQuestion(requestID, status, answers)
    try {
      await telegram.editMessageText({
        chatId: record.chatId,
        messageId: record.messageId,
        text: renderQuestion({ ...record, status, answers }),
        replyMarkup: { inline_keyboard: [] },
      })
    } catch (error) {
      logError(error, { event: "question.message.edit", requestID })
    }
    return true
  }

  async function handleCallback(query) {
    const data = String(query?.data || "")
    if (!data.startsWith(CALLBACK_PREFIX)) return false
    const [, requestID, optionText] = data.split(":")
    const record = state.questionRecord(requestID)
    if (!record || record.status !== "pending") {
      await telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "На этот вопрос уже ответили", showAlert: true })
      return true
    }
    if (query.message?.chat?.id !== record.chatId || query.message?.message_id !== record.messageId) {
      await telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "Кнопка относится к другому вопросу", showAlert: true })
      return true
    }
    const option = record.question?.options?.[Number(optionText)]
    if (!option) {
      await telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "Вариант больше недоступен", showAlert: true })
      return true
    }
    const binding = state.findBinding(record.serverID, record.sessionID)
    try {
      await opencode.replyQuestion(record.serverID, requestID, [[option.label]], { directory: binding?.directory })
      await handleResolved(requestID, "answered", [[option.label]])
      await telegram.answerCallbackQuery({ callbackQueryId: query.id, text: `Выбрано: ${option.label}` })
    } catch (error) {
      logError(error, { event: "question.reply", requestID })
      await telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "Не удалось отправить ответ", showAlert: true })
    }
    return true
  }

  async function handleReplyMessage(message) {
    const replyToMessageID = message?.reply_to_message?.message_id
    const text = String(message?.text || message?.caption || "").trim()
    if (!replyToMessageID || !text || text.startsWith("/")) return false
    const record = state.questionRecords().find((item) => item.status === "pending"
      && item.chatId === message.chat?.id
      && item.topicId === message.message_thread_id
      && item.messageId === replyToMessageID
      && item.question?.custom)
    if (!record) return false
    const binding = state.findBinding(record.serverID, record.sessionID)
    try {
      await opencode.replyQuestion(record.serverID, record.requestID, [[text]], { directory: binding?.directory })
      await handleResolved(record.requestID, "answered", [[text]])
    } catch (error) {
      logError(error, { event: "question.custom_reply", requestID: record.requestID })
      await telegram.sendMessage({ chatId: record.chatId, topicId: record.topicId, text: "Не удалось отправить собственный ответ в OpenCodez." })
    }
    return true
  }

  async function reconcile() {
    for (const server of opencode.servers.values()) {
      const directories = new Set([server.home, ...state.bindings().filter((binding) => binding.serverID === server.id).map((binding) => binding.directory)].filter(Boolean))
      for (const directory of directories) {
        try {
          const pending = await opencode.questions(server.id, { directory })
          const pendingIDs = new Set(pending.map((item) => item.id))
          for (const info of pending) {
            const binding = state.findBinding(server.id, info.sessionID)
            if (binding) await handleAsked(server, binding, info)
          }
          for (const record of state.questionRecords()) {
            if (record.serverID !== server.id || record.directory !== directory || record.status !== "pending" || pendingIDs.has(record.requestID)) continue
            await handleResolved(record.requestID, "closed", [])
          }
        } catch (error) {
          logError(error, { event: "question.reconcile", serverID: server.id, directory })
        }
      }
    }
  }

  function hasPending(serverID, sessionID) {
    return state.hasPendingQuestion(serverID, sessionID)
  }

  async function notifyRecipients(binding, record) {
    const link = telegramMessageLink(binding.chatId, record.messageId)
    for (const userID of config.finalNotifications?.userIds || []) {
      const value = String(userID)
      if (record.notifiedUserIds.includes(value)) continue
      try {
        await telegram.sendMessage({
          chatId: userID,
          text: `❓ <b>OpenCodez ждёт ответа</b>\n💬 ${escapeHtml(binding.topicTitle || `Topic ${binding.topicId}`)}\nБез ответа работа в этой сессии не продолжится.`,
          replyMarkup: link ? { inline_keyboard: [[{ text: "Открыть вопрос", url: link }]] } : undefined,
        })
        record.notifiedUserIds.push(value)
        await state.upsertQuestion(record)
      } catch (error) {
        logError(error, { event: "question.notification", requestID: record.requestID, userID })
      }
    }
  }

  return { handleEvent, handleCallback, handleReplyMessage, reconcile, hasPending }
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) return []
  return questions.map((value) => ({
    header: String(value.header || "").trim(),
    text: String(value.question || "").trim(),
    multiple: Boolean(value.multiple),
    custom: value.custom !== false,
    options: Array.isArray(value.options)
      ? value.options.map((option) => ({ label: String(option.label || "").trim(), description: String(option.description || "").trim() })).filter((option) => option.label)
      : [],
  }))
}

function renderQuestion(record) {
  const question = record.question
  const lines = ["❓ <b>OpenCodez ждёт ответа</b>"]
  if (!question) {
    lines.push("", "В опроснике несколько вопросов. Ответьте на них в OpenCodez.")
    ;(record.questions || []).forEach((item, index) => {
      lines.push("", `<b>${index + 1}.</b> ${escapeHtml(item.text)}`)
    })
  } else {
    lines.push("", escapeHtml(question.text))
    question.options.forEach((option, index) => {
      lines.push("", `<b>${index + 1}. ${escapeHtml(option.label)}</b>`)
      if (option.description) lines.push(escapeHtml(option.description))
    })
    if (question.multiple) lines.push("", "Для выбора нескольких вариантов ответьте через OpenCodez.")
    else if (question.custom) lines.push("", "Свой ответ можно отправить реплаем на это сообщение.")
  }
  if (record.status === "answered") lines.push("", `✅ <b>Выбран ответ:</b> ${escapeHtml(flattenAnswers(record.answers))}`)
  if (record.status === "rejected") lines.push("", "⚪️ Вопрос отменён в OpenCodez.")
  if (record.status === "closed") lines.push("", "⚪️ Вопрос закрыт в OpenCodez.")
  return clampTelegram(lines.join("\n"))
}

function questionReplyMarkup(record) {
  if (!record.interactive || record.status !== "pending") return undefined
  return {
    inline_keyboard: record.question.options.map((option, index) => [{
      text: option.label.slice(0, 64),
      callback_data: `${CALLBACK_PREFIX}${record.requestID}:${index}`,
    }]),
  }
}

function flattenAnswers(answers) {
  return (answers || []).flat().filter(Boolean).join(", ") || "ответ отправлен"
}
