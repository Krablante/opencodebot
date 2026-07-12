import assert from "node:assert/strict"
import test from "node:test"

import { createQuestionManager } from "../src/questions.mjs"

test("single-choice questions render buttons, notify, and reply through OpenCodez", async () => {
  const records = new Map()
  const sent = []
  const edits = []
  const callbacks = []
  const replies = []
  const binding = { chatId: -100123, topicId: 55, topicTitle: "Test topic", serverID: "nuc", sessionID: "ses_test", directory: "/tmp" }
  const state = {
    questionRecord: (requestID) => records.get(requestID) || null,
    questionRecords: () => [...records.values()],
    hasPendingQuestion: () => [...records.values()].some((record) => record.status === "pending"),
    findBinding: () => binding,
    async upsertQuestion(value) { const record = { ...(records.get(value.requestID) || {}), ...value }; records.set(value.requestID, record); return record },
    async resolveQuestion(requestID, status, answers) { const record = { ...records.get(requestID), status, answers }; records.set(requestID, record); return record },
  }
  const telegram = {
    async sendMessage(message) { sent.push(message); return { message_id: 70 + sent.length } },
    async editMessageText(message) { edits.push(message) },
    async answerCallbackQuery(message) { callbacks.push(message) },
  }
  const opencode = {
    servers: new Map(),
    async replyQuestion(serverID, requestID, answers) { replies.push({ serverID, requestID, answers }) },
  }
  const manager = createQuestionManager({ config: { finalNotifications: { userIds: [7] } }, state, telegram, opencode })

  await manager.handleEvent({ id: "nuc" }, binding, {
    type: "question.asked",
    properties: {
      id: "que_test",
      sessionID: "ses_test",
      questions: [{ question: "Кто выполнит merge?", header: "Merge", multiple: false, custom: true, options: [
        { label: "Я сам", description: "Пользователь выполнит merge" },
        { label: "Сделай ты", description: "Агент выполнит merge" },
      ] }],
    },
  })

  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0].replyMarkup.inline_keyboard.map((row) => row[0].text), ["Я сам", "Сделай ты"])
  assert.doesNotMatch(sent[0].text, /<b>Merge<\/b>/)
  assert.equal(sent[1].chatId, 7)
  assert.equal(manager.hasPending("nuc", "ses_test"), true)

  await manager.handleCallback({ id: "cb_test", data: "oq:que_test:1", message: { chat: { id: binding.chatId }, message_id: 71 } })

  assert.deepEqual(replies, [{ serverID: "nuc", requestID: "que_test", answers: [["Сделай ты"]] }])
  assert.deepEqual(edits[0].replyMarkup, { inline_keyboard: [] })
  assert.match(edits[0].text, /Выбран ответ.*Сделай ты/s)
  assert.equal(callbacks[0].text, "Выбрано: Сделай ты")
  assert.equal(manager.hasPending("nuc", "ses_test"), false)

  await manager.handleEvent({ id: "nuc" }, binding, {
    type: "question.asked",
    properties: {
      id: "que_custom",
      sessionID: "ses_test",
      questions: [{ question: "Напишите собственный ответ", header: "Custom", multiple: false, custom: true, options: [{ label: "Готовый вариант", description: "Можно выбрать кнопкой" }] }],
    },
  })
  const custom = state.questionRecord("que_custom")
  assert.equal(await manager.handleReplyMessage({
    chat: { id: binding.chatId },
    message_thread_id: binding.topicId,
    text: "Мой собственный ответ",
    reply_to_message: { message_id: custom.messageId },
  }), true)
  assert.deepEqual(replies[1], { serverID: "nuc", requestID: "que_custom", answers: [["Мой собственный ответ"]] })
  assert.match(edits.at(-1).text, /Выбран ответ.*Мой собственный ответ/s)
})
