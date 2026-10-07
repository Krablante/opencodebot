import { escapeHtml, telegramMessageLink } from "./telegram.mjs"
import { buttonRows } from "./menu-format.mjs"
import { logInfo } from "./logger.mjs"
import { t } from "./i18n/index.mjs"

const CALLBACK_PREFIX = "oq:"
const CARD_FORMAT = "rich-v1"

export function createQuestionManager({ config, state, telegram, opencode, backendRequest, skippedBackendRequest, logError = () => {} }) {
  const operations = new Map()
  const reconcileOperations = new Map()

  // Buttons, replies, recovery and backend resolution share one request lane.
  // A second click cannot consume the next question while the first is drawing it.
  function ordered(serverID, requestID, action) {
    const key = `${serverID}:${requestID}`
    const previous = operations.get(key)
    const operation = (previous || Promise.resolve()).catch(() => {}).then(action)
    operations.set(key, operation)
    return operation.finally(() => { if (operations.get(key) === operation) operations.delete(key) })
  }

  function handleEvent(server, binding, event) {
    const requestID = event.properties?.id || event.properties?.requestID
    if (event.type === "question.asked") return handleAsked(server, binding, event.properties)
    return ordered(server.id, requestID, () => {
      if (event.type === "question.replied") return resolve(requestID, "answered", event.properties.answers || [])
      if (event.type === "question.rejected") return resolve(requestID, "rejected")
      return false
    })
  }

  function handleAsked(server, binding, info) {
    return ordered(server.id, info.id, async () => {
      const existing = state.questionRecord(info.id)
      // Late/replayed asked events must not reopen an already settled request.
      if (existing && existing.status !== "pending") return true
      const record = prepareRecord(existing || {
        requestID: info.id, serverID: server.id, sessionID: info.sessionID,
        chatId: binding.chatId, topicId: binding.topicId, directory: binding.directory,
        status: "pending", questions: normalizeQuestions(info.questions), answers: [],
        notifiedUserIds: [], createdAt: new Date().toISOString(),
      })
      if (!record.messageId || record.needsRender) {
        await draw(record)
        logInfo("question.telegram.sent", { source: server.id, sessionID: info.sessionID, requestID: info.id, topicId: binding.topicId, questions: record.questions.length })
      }
      await notifyRecipients(binding, record)
      return true
    })
  }

  async function draw(record) {
    record.revision += 1
    record.needsRender = true
    await state.upsertQuestion(record)
    const html = renderQuestionCard(record)
    if (record.messageId) {
      try {
        await telegram.editRichMessage({ chatId: record.chatId, messageId: record.messageId, html })
      } catch (error) {
        if (/message is not modified/i.test(error.message)) { /* already rendered */ }
        else if (/message (?:to edit )?not found|message can.t be edited/i.test(error.message)) {
          rememberMessage(record, record.messageId)
          record.messageId = undefined
        } else throw error
      }
    }
    if (!record.messageId) {
      const sent = await telegram.sendRichMessage({ chatId: record.chatId, topicId: record.topicId, html })
      record.messageId = sent.message_id
    }
    record.needsRender = false
    await state.upsertQuestion(record)
  }

  async function retireInput(record) {
    if (!record.input) return
    const messageId = record.input.messageId
    rememberMessage(record, messageId)
    record.input = null
    await state.upsertQuestion(record)
    await telegram.deleteMessage({ chatId: record.chatId, messageId }).catch((error) => logError(error, { event: "question.input.delete", requestID: record.requestID }))
  }

  async function resolve(requestID, status, answers = []) {
    const saved = state.questionRecord(requestID)
    if (!saved || (saved.status === status && !saved.needsRender)
      || (status === "closed" && ["answered", "rejected"].includes(saved.status))) return false
    const record = prepareRecord(saved)
    await retireInput(record)
    record.status = status
    record.answers = answers
    record.selections = []
    record.customAnswers = []
    record.notice = ""
    await state.resolveQuestion(requestID, status, answers)
    try { await draw(record) }
    catch (error) { logError(error, { event: "question.message.edit", requestID }) }
    logInfo("question.resolved", { source: record.serverID, sessionID: record.sessionID, requestID, status })
    return true
  }

  async function submit(record, reject = false) {
    await retireInput(record)
    await state.upsertQuestion(record)
    try {
      if (reject) await opencode.rejectQuestion(record.serverID, record.requestID, { directory: record.directory })
      else await opencode.replyQuestion(record.serverID, record.requestID, draftAnswers(record), { directory: record.directory })
      await resolve(record.requestID, reject ? "rejected" : "answered", reject ? [] : draftAnswers(record))
    } catch (error) {
      logError(error, { event: "question.reply", requestID: record.requestID })
      if (error.status === 404) return resolve(record.requestID, "closed")
      // Keep the draft, including the last selection, for a safe explicit retry.
      if (!reject) record.step = record.questions.length
      record.notice = t(reject ? "questions.dismissFailed" : "questions.sendFailed")
      await draw(record)
    }
  }

  async function advance(record) {
    if (record.questions.length === 1) return submit(record)
    record.step = record.returnToReview ? record.questions.length : record.step + 1
    record.returnToReview = false
    await draw(record)
  }

  async function askCustom(record, actor) {
    await retireInput(record)
    const question = record.questions[record.step]
    const name = escapeHtml(actor.first_name || t("questions.you"))
    const html = `<h3>✎ ${escapeHtml(t("questions.ownAnswer"))}</h3><p>${escapeHtml(question.text)}</p><p><a href="tg://user?id=${actor.id}">${name}</a>, ${escapeHtml(t("questions.inputHelp"))}</p>`
    const sent = await telegram.sendRichMessage({ chatId: record.chatId, topicId: record.topicId, html,
      replyMarkup: { force_reply: true, selective: true, input_field_placeholder: t("questions.inputPlaceholder") },
    })
    record.input = { messageId: sent.message_id, questionIndex: record.step, actorID: actor.id }
    rememberMessage(record, sent.message_id)
    await draw(record)
  }

  async function handleCallback(query) {
    const data = String(query?.data || "")
    if (!data.startsWith(CALLBACK_PREFIX)) return false
    const [, requestID, revision, action] = data.split(":")
    const saved = state.questionRecord(requestID)
    const answer = (text, showAlert = false) => telegram.answerCallbackQuery({ callbackQueryId: query.id, text, showAlert })
    if (!saved) { await answer(t("questions.alreadyAnswered"), true); return true }
    return ordered(saved.serverID, requestID, async () => {
      const current = state.questionRecord(requestID)
      if (!current) { await answer(t("questions.alreadyAnswered"), true); return true }
      const record = prepareRecord(current)
      if (record.status !== "pending") { await answer(t("questions.alreadyAnswered"), true); return true }
      const binding = state.findBinding(record.serverID, record.sessionID)
      if (!binding || binding.disabled || binding.topicId !== record.topicId || binding.chatId !== record.chatId) {
        await answer(t("questions.alreadyAnswered"), true)
        await resolve(requestID, "closed")
        return true
      }
      if (query.message?.chat?.id !== record.chatId || query.message?.message_id !== record.messageId) {
        await answer(t("questions.wrongQuestion"), true); return true
      }
      if (String(record.revision) !== revision || record.needsRender) {
        await answer(t("questions.cardUpdated")); return true
      }
      const question = record.questions[record.step]
      const pick = /^pick(\d+)$/.exec(action || "")
      const go = /^go(\d+)$/.exec(action || "")
      if ((pick && !question?.options[Number(pick[1])]) || (go && !record.questions[Number(go[1])])
        || (action === "custom" && (!question?.custom || !query.from?.id))
        || (action === "next" && !question) || (action === "back" && record.step <= 0)
        || (action === "submit" && record.step !== record.questions.length)
        || (action === "clear" && !record.customAnswers[record.step])
        || (!pick && !go && !["custom", "clear", "next", "back", "submit", "reject"].includes(action))) {
        await answer(t("questions.optionUnavailable"), true); return true
      }
      await answer()
      record.notice = ""
      try {
        if (action === "submit" || action === "reject") { await submit(record, action === "reject"); return true }
        if (action === "custom") { await askCustom(record, query.from); return true }
        await retireInput(record)
        if (pick) {
          const index = Number(pick[1])
          const selected = record.selections[record.step] || []
          record.selections[record.step] = question.multiple
            ? (selected.includes(index) ? selected.filter((value) => value !== index) : [...selected, index]) : [index]
          if (!question.multiple) {
            record.customAnswers[record.step] = ""
            await advance(record)
            return true
          }
        } else if (action === "clear") record.customAnswers[record.step] = ""
        else if (go) { record.step = Number(go[1]); record.returnToReview = true }
        else if (action === "back") { record.step -= 1; record.returnToReview = false }
        else if (action === "next") { await advance(record); return true }
        await draw(record)
      } catch (error) {
        logError(error, { event: "question.action", requestID })
        // Persisted needsRender makes the existing recovery loop retry the card.
        await telegram.sendMessage({ chatId: record.chatId, topicId: record.topicId, text: t("questions.actionFailed") })
      }
      return true
    })
  }

  async function handleReplyMessage(message) {
    const replyID = message?.reply_to_message?.message_id
    if (!replyID) return false
    const saved = state.questionRecords().find((item) => item.chatId === message.chat?.id
      && item.topicId === message.message_thread_id && (item.messageId === replyID || item.input?.messageId === replyID || item.previousMessageIds?.includes(replyID)))
    if (!saved) return false
    return ordered(saved.serverID, saved.requestID, async () => {
      const current = state.questionRecord(saved.requestID)
      if (!current) return true
      const record = prepareRecord(current)
      const input = record.input
      const binding = state.findBinding(record.serverID, record.sessionID)
      // Recognized old/foreign replies are consumed, never routed as prompts.
      if (record.status !== "pending" || !binding || binding.disabled) return true
      if (!input || input.messageId !== replyID || input.actorID !== message.from?.id || input.questionIndex !== record.step) {
        if (replyID === record.messageId && record.questions[record.step]?.custom) await telegram.sendMessage({
          chatId: record.chatId, topicId: record.topicId, text: t("questions.useOwnButton"),
        })
        return true
      }
      const text = String(message.text || message.caption || "").trim()
      if (text === "/cancel") { await retireInput(record); await draw(record); return true }
      if (!text) {
        await telegram.sendMessage({ chatId: record.chatId, topicId: record.topicId, text: t("questions.textRequired") })
        return true
      }
      await retireInput(record)
      record.customAnswers[record.step] = text
      if (!record.questions[record.step].multiple) record.selections[record.step] = []
      if (record.questions[record.step].multiple) await draw(record)
      else await advance(record)
      return true
    })
  }

  async function reconcile() {
    await Promise.all([...opencode.servers.values()].map((server) => reconcileServer(server.id)))
  }

  function reconcileServer(serverID) {
    const existing = reconcileOperations.get(serverID)
    if (existing) return existing
    const operation = reconcileServerNow(serverID).finally(() => reconcileOperations.delete(serverID))
    reconcileOperations.set(serverID, operation)
    return operation
  }

  async function reconcileServerNow(serverID) {
    const server = opencode.servers.get(serverID)
    if (!server) return
    const directories = new Set([server.home,
      ...state.bindings().filter((binding) => binding.serverID === server.id && !binding.disabled).map((binding) => binding.directory),
      ...state.questionRecords().filter((record) => record.serverID === server.id && (record.status === "pending" || record.needsRender)).map((record) => record.directory),
    ].filter(Boolean))
    for (const directory of directories) {
      try {
        const tracked = new Set(state.questionRecords().filter((record) => record.serverID === server.id && record.directory === directory).map((record) => record.requestID))
        const pending = backendRequest
          ? await backendRequest(server.id, "pending questions", () => opencode.questions(server.id, { directory }))
          : await opencode.questions(server.id, { directory })
        if (pending === skippedBackendRequest) return
        const pendingIDs = new Set(pending.map((item) => item.id))
        await Promise.all(pending.map(async (info) => {
          const binding = state.findBinding(server.id, info.sessionID)
          if (binding && !binding.disabled) await handleAsked(server, binding, info)
        }))
        for (const saved of state.questionRecords()) {
          if (saved.serverID !== server.id || saved.directory !== directory) continue
          await ordered(server.id, saved.requestID, async () => {
            const record = state.questionRecord(saved.requestID)
            if (!record) return
            const binding = state.findBinding(server.id, record.sessionID)
            if (record.status === "pending" && ((tracked.has(record.requestID) && !pendingIDs.has(record.requestID)) || !binding || binding.disabled)) await resolve(record.requestID, "closed")
            else if (record.needsRender) {
              if (record.status === "pending") await draw(prepareRecord(record))
              else await resolve(record.requestID, record.status, record.answers || [])
            }
          })
        }
      } catch (error) { logError(error, { event: "question.reconcile", serverID: server.id, directory }) }
    }
  }

  async function notifyRecipients(binding, record) {
    const link = telegramMessageLink(binding.chatId, record.messageId)
    for (const userID of config.finalNotifications?.userIds || []) {
      const value = String(userID)
      if (record.notifiedUserIds.includes(value)) continue
      try {
        await telegram.sendMessage({ chatId: userID,
          text: t("questions.notification", { topicHtml: escapeHtml(binding.topicTitle || t("questions.topicFallback", { topicId: binding.topicId })) }),
          replyMarkup: link ? { inline_keyboard: [[{ text: t("questions.open"), url: link }]] } : undefined,
        })
        record.notifiedUserIds.push(value)
        await state.upsertQuestion(record)
      } catch (error) { logError(error, { event: "question.notification", requestID: record.requestID, userID }) }
    }
  }

  return { handleEvent, handleCallback, handleReplyMessage, reconcile, reconcileServer,
    hasPending: (serverID, sessionID) => state.hasPendingQuestion(serverID, sessionID) }
}

function prepareRecord(saved) {
  const record = structuredClone(saved)
  if (record.format !== CARD_FORMAT) {
    record.questions = normalizeQuestions(record.questions || (record.question ? [record.question] : []))
    record.format = CARD_FORMAT
    record.needsRender = true
    delete record.question
    delete record.interactive
  }
  record.revision ||= 0
  record.step ||= 0
  record.selections ||= []
  record.customAnswers ||= []
  record.previousMessageIds ||= []
  record.notifiedUserIds ||= []
  return record
}

function rememberMessage(record, messageId) {
  if (messageId && !record.previousMessageIds.includes(messageId)) record.previousMessageIds.push(messageId)
}

function normalizeQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).map((value) => ({
    header: String(value.header || "").trim(), text: String(value.question || value.text || "").trim(),
    multiple: Boolean(value.multiple), custom: value.custom !== false,
    options: (Array.isArray(value.options) ? value.options : []).map((option) => ({
      label: String(option.label || "").trim(), description: String(option.description || "").trim(),
    })).filter((option) => option.label),
  }))
}

function draftAnswers(record) {
  return record.questions.map((question, index) => [...new Set([
    ...(record.selections[index] || []).map((option) => question.options[option]?.label).filter(Boolean),
    ...(record.customAnswers[index] ? [record.customAnswers[index]] : []),
  ])])
}

export function renderQuestionCard(saved) {
  const record = prepareRecord(saved)
  const total = record.questions.length
  const button = (text, action, style) => ({ text, callback_data: `${CALLBACK_PREFIX}${record.requestID}:${record.revision}:${action}`, style })
  const notice = record.notice ? `<blockquote>${escapeHtml(record.notice)}</blockquote>` : ""
  const summary = (answers, editable) => record.questions.map((question, index) =>
    `<h3>${index + 1}. ${escapeHtml(question.header || t("questions.questionLabel"))}</h3><p>${escapeHtml(question.text)}</p>`
    + `<blockquote>${escapeHtml((answers[index] || []).join(" · ") || t("questions.skipped"))}</blockquote>`
    + (editable ? buttonRows([[button(t("questions.change"), `go${index}`, "link")]]) : "")).join("")
  if (record.status !== "pending") {
    const title = t(record.status === "answered" ? "questions.doneTitle" : record.status === "rejected" ? "questions.rejectedTitle" : "questions.closedTitle")
    return `<h2>${escapeHtml(title)}</h2>` + (record.status === "answered" ? summary(record.answers || [], false) : "")
  }
  if (record.step >= total) {
    return `<h2>${escapeHtml(t("questions.reviewTitle"))}</h2><footer>${escapeHtml(t("questions.reviewHelp"))}</footer>`
      + notice + summary(draftAnswers(record), true)
      + buttonRows([[button(t("questions.sendAnswers"), "submit", "success")],
        ...(total ? [[button(t("questions.back"), "back", "link"), button(t("questions.dismiss"), "reject", "link")]] : [[button(t("questions.dismiss"), "reject", "link")]])])
  }
  const question = record.questions[record.step]
  const selected = record.selections[record.step] || []
  const own = record.customAnswers[record.step]
  let html = `<h2>${escapeHtml(t("questions.cardTitle"))}</h2><footer>${escapeHtml(t("questions.progress", { current: record.step + 1, total }))} · ${escapeHtml(t(question.multiple ? "questions.chooseMany" : "questions.chooseOne"))}</footer>`
    + notice + `<p>${escapeHtml(question.text)}</p>`
  question.options.forEach((option, index) => {
    const picked = selected.includes(index)
    const mark = question.multiple ? (picked ? "☑" : "☐") : (picked ? "●" : "○")
    html += buttonRows([[button(`${mark} ${option.label}`, `pick${index}`, picked ? "primary" : undefined)]])
    if (option.description) html += `<footer>${escapeHtml(option.description)}</footer>`
  })
  if (question.custom) {
    html += buttonRows([[button(`${own ? "✓" : "✎"} ${t("questions.ownAnswer")}`, "custom", own ? "primary" : undefined)]])
    if (own) html += `<blockquote>${escapeHtml(own)}</blockquote>` + buttonRows([[button(t("questions.clearOwnAnswer"), "clear", "link")]])
  }
  if (record.input) html += `<footer>${escapeHtml(t("questions.waitingInput"))}</footer>`
  const hasAnswer = draftAnswers(record)[record.step].length > 0
  const next = question.multiple || hasAnswer || total > 1
    ? button(total === 1 ? t("questions.sendAnswer") : record.returnToReview ? t("questions.toReview") : t("questions.next"), "next", hasAnswer ? "success" : undefined) : null
  // Single choice advances on its option button. Empty batch answers are explicit.
  html += buttonRows([
    ...(next && (hasAnswer || total > 1) ? [[hasAnswer ? next : button(t("questions.skip"), "next", "link")]] : []),
    [...(record.step > 0 ? [button(t("questions.back"), "back", "link")] : []), button(t("questions.dismiss"), "reject", "link")],
  ])
  return html
}
