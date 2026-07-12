import assert from "node:assert/strict"
import test from "node:test"

import { createQuestionManager } from "../src/questions.mjs"

test("single-choice questions render buttons, notify, and reply through OpenCodez", async () => {
  let record
  const sent = []
  const edits = []
  const callbacks = []
  const replies = []
  const binding = { chatId: -100123, topicId: 55, topicTitle: "Test topic", serverID: "nuc", sessionID: "ses_test", directory: "/tmp" }
  const state = {
    questionRecord: () => record || null,
    questionRecords: () => record ? [record] : [],
    hasPendingQuestion: () => record?.status === "pending",
    findBinding: () => binding,
    async upsertQuestion(value) { record = { ...(record || {}), ...value }; return record },
    async resolveQuestion(_requestID, status, answers) { record = { ...record, status, answers }; return record },
  }
  const telegram = {
    async sendMessage(message) { sent.push(message); return { message_id: sent.length === 1 ? 77 : 88 } },
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
  assert.equal(sent[1].chatId, 7)
  assert.equal(manager.hasPending("nuc", "ses_test"), true)

  await manager.handleCallback({ id: "cb_test", data: "oq:que_test:1", message: { chat: { id: binding.chatId }, message_id: 77 } })

  assert.deepEqual(replies, [{ serverID: "nuc", requestID: "que_test", answers: [["Сделай ты"]] }])
  assert.deepEqual(edits[0].replyMarkup, { inline_keyboard: [] })
  assert.match(edits[0].text, /Выбран ответ.*Сделай ты/s)
  assert.equal(callbacks[0].text, "Выбрано: Сделай ты")
  assert.equal(manager.hasPending("nuc", "ses_test"), false)
})
