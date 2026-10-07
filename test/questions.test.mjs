import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { once } from "node:events"
import { createQuestionManager, renderQuestionCard } from "../src/questions.mjs"
import { StateStore } from "../src/state.mjs"
import { OpenCodeClient } from "../src/opencode.mjs"

const choice = (overrides = {}) => ({ question: "Which gesture?", header: "Gesture", custom: true,
  options: [{ label: "Drag", description: "Drag across the canvas" }, { label: "Buttons", description: "Use the controls" }], ...overrides })

function fixture(stateStore) {
  const records = new Map(), sent = [], edits = [], callbacks = [], replies = [], deleted = [], rejected = []
  const binding = { chatId: -100123, topicId: 55, topicTitle: "Test topic", serverID: "sample", sessionID: "ses_test", directory: "/tmp" }
  const server = { id: "sample", home: "/tmp" }
  const state = stateStore || {
    questionRecord: (id) => records.get(id) || null,
    questionRecords: () => [...records.values()],
    hasPendingQuestion: () => [...records.values()].some((record) => record.status === "pending"),
    findBinding: () => binding, bindings: () => [binding],
    async upsertQuestion(record) { records.set(record.requestID, structuredClone(record)) },
    async resolveQuestion(id, status, answers) { records.set(id, { ...records.get(id), status, answers }) },
  }
  const telegram = {
    async sendRichMessage(message) { sent.push(message); return { message_id: 70 + sent.length } },
    async sendMessage(message) { sent.push(message); return { message_id: 70 + sent.length } },
    async editRichMessage(message) { edits.push(message) },
    async deleteMessage(message) { deleted.push(message.messageId) },
    async answerCallbackQuery(message) { callbacks.push(message) },
  }
  const opencode = { servers: new Map([[server.id, server]]), pending: [],
    async questions() { return this.pending },
    async replyQuestion(serverID, requestID, answers) { replies.push({ serverID, requestID, answers }); if (this.failure) throw this.failure },
    async rejectQuestion(serverID, requestID) { rejected.push(requestID) },
  }
  const manager = createQuestionManager({ config: { finalNotifications: { userIds: [7] } }, state, telegram, opencode })
  const record = () => state.questionRecord("que_test")
  const callback = (action, revision = record().revision, overrides = {}) => ({
    id: "cb_test", data: `oq:que_test:${revision}:${action}`, from: { id: 7, first_name: "Tester" },
    message: { chat: { id: binding.chatId }, message_id: record().messageId }, ...overrides,
  })
  const reply = (text, overrides = {}) => ({ chat: { id: binding.chatId }, message_thread_id: binding.topicId,
    from: { id: 7 }, text, reply_to_message: { message_id: record().input?.messageId || record().messageId }, ...overrides })
  async function ask(questions = [choice()]) {
    const info = { id: "que_test", sessionID: binding.sessionID, questions }
    opencode.pending = [info]
    await manager.handleEvent(server, binding, { type: "question.asked", properties: info })
  }
  return { records, state, binding, server, sent, edits, callbacks, replies, deleted, rejected, telegram, opencode, manager, record, callback, reply, ask }
}

test("single choice uses embedded rich buttons, notifications and a one-click backend answer", async () => {
  const f = fixture()
  await f.ask()
  assert.equal(f.sent.length, 2)
  assert.match(f.sent[0].html, /<tg-button.*oq:que_test:1:pick0.*○ Drag/)
  assert.match(f.sent[0].html, /Drag across the canvas/)
  assert.equal(f.sent[0].replyMarkup, undefined)
  assert.equal(f.manager.hasPending("sample", "ses_test"), true)
  await f.manager.handleCallback(f.callback("pick1"))
  assert.deepEqual(f.replies, [{ serverID: "sample", requestID: "que_test", answers: [["Buttons"]] }])
  assert.match(f.edits.at(-1).html, /Answers sent.*Gesture.*Buttons/s)
  assert.doesNotMatch(f.edits.at(-1).html, /tg-button|waiting|answer through/i)
  assert.equal(f.manager.hasPending("sample", "ses_test"), false)
  await f.ask()
  assert.equal(f.sent.length, 2, "a repeated asked event cannot reopen a resolved request")
})

test("a batch collects choices and custom multi-select, survives restart, supports edits and submits once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-questions-"))
  try {
    const state = new StateStore(path.join(root, "state.json"))
    await state.load()
    const f = fixture(state)
    await state.bindTopic(f.binding)
    await f.ask([choice(), choice({ question: "Which browsers?", header: "Browsers", multiple: true,
      options: [{ label: "Firefox", description: "Android" }, { label: "Chrome", description: "Desktop" }] })])
    await f.manager.handleCallback(f.callback("pick0"))
    assert.equal(f.record().step, 1)
    assert.equal(f.replies.length, 0)
    await f.manager.handleCallback(f.callback("pick0"))
    await f.manager.handleCallback(f.callback("pick1"))
    await f.manager.handleCallback(f.callback("pick1"))
    assert.deepEqual(f.record().selections[1], [0])
    assert.match(f.edits.at(-1).html, /☑ Firefox/)
    await f.manager.handleCallback(f.callback("custom"))
    const inputId = f.record().input.messageId
    assert.equal(f.sent.at(-1).replyMarkup.force_reply, true)
    assert.equal(f.sent.at(-1).replyMarkup.selective, true)
    assert.match(f.sent.at(-1).html, /tg:\/\/user\?id=7/)

    const restart = new StateStore(path.join(root, "state.json"))
    await restart.load()
    const restarted = createQuestionManager({ config: { finalNotifications: { userIds: [7] } }, state: restart, telegram: f.telegram, opencode: f.opencode })
    await restarted.reconcile()
    assert.equal(f.sent.length, 3, "recovery does not resend the card or DM")
    assert.equal(await restarted.handleReplyMessage(f.reply("Foreign", { from: { id: 8 } })), true)
    assert.equal(restart.questionRecord("que_test").input.messageId, inputId)
    assert.equal(await restarted.handleReplyMessage(f.reply("/custom/path")), true)
    assert.equal(restart.questionRecord("que_test").customAnswers[1], "/custom/path")
    const click = (action) => ({ ...f.callback(action), data: `oq:que_test:${restart.questionRecord("que_test").revision}:${action}` })
    await restarted.handleCallback(click("next"))
    assert.match(f.edits.at(-1).html, /Review your answers.*Drag.*Firefox · \/custom\/path/s)
    await restarted.handleCallback(click("go0"))
    await restarted.handleCallback(click("pick1"))
    assert.equal(restart.questionRecord("que_test").step, 2)
    await restarted.handleCallback(click("submit"))
    assert.deepEqual(f.replies[0].answers, [["Buttons"], ["Firefox", "/custom/path"]])
    assert.equal(await restarted.handleReplyMessage(f.reply("Late", { reply_to_message: { message_id: inputId } })), true)
    assert.equal(f.replies.length, 1)
    assert.ok(f.deleted.includes(inputId))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("old and overlapping clicks cannot consume another question; main-card replies never become prompts", async () => {
  const f = fixture()
  await f.ask([choice(), choice()])
  const first = f.callback("pick0"), second = f.callback("pick1")
  await Promise.all([f.manager.handleCallback(first), f.manager.handleCallback(second)])
  assert.equal(f.record().step, 1)
  assert.deepEqual(f.record().selections, [[0]])
  assert.equal(f.replies.length, 0)
  assert.match(f.callbacks.at(-1).text, /card has changed/)
  assert.equal(await f.manager.handleReplyMessage(f.reply("Reply to card")), true)
  assert.match(f.sent.at(-1).text, /Tap.*own answer/)
  assert.equal(await f.manager.handleReplyMessage(f.reply("Unrelated", { reply_to_message: { message_id: 9999 } })), false)
  await f.manager.handleCallback(f.callback("custom"))
  const staleReply = f.reply("Too late")
  await f.manager.handleCallback(f.callback("back"))
  assert.equal(await f.manager.handleReplyMessage(staleReply), true)
  assert.equal(f.record().step, 0)
  assert.equal(f.record().customAnswers.some(Boolean), false)
})

test("custom input cancellation, custom:false, skipping and backend resolution retain correct question boundaries", async () => {
  const f = fixture()
  await f.ask([choice({ custom: false }), choice()])
  assert.doesNotMatch(f.sent[0].html, /own answer/)
  await f.manager.handleCallback(f.callback("custom"))
  assert.equal(f.record().input, undefined)
  await f.manager.handleCallback(f.callback("next"))
  await f.manager.handleCallback(f.callback("custom"))
  const inputId = f.record().input.messageId
  await f.manager.handleReplyMessage(f.reply("/cancel"))
  assert.equal(f.record().input, null)
  assert.equal(f.record().step, 1)
  await f.manager.handleCallback(f.callback("custom"))
  await f.manager.handleEvent(f.server, f.binding, { type: "question.replied", properties: {
    requestID: "que_test", answers: [["Web answer 1"], ["Web answer 2"]],
  } })
  assert.match(f.edits.at(-1).html, /1\. Gesture.*Web answer 1.*2\. Gesture.*Web answer 2/s)
  assert.doesNotMatch(f.edits.at(-1).html, /tg-button/)
  assert.equal(await f.manager.handleReplyMessage(f.reply("Late", { reply_to_message: { message_id: inputId } })), true)
  assert.equal(f.replies.length, 0)
})

test("failed submissions keep answers for retry; rejection closes the backend and Telegram controls", async () => {
  const f = fixture()
  await f.ask()
  f.opencode.failure = new Error("Transport unavailable")
  await f.manager.handleCallback(f.callback("pick1"))
  assert.equal(f.record().status, "pending")
  assert.match(f.edits.at(-1).html, /They are saved/)
  assert.deepEqual(f.record().selections, [[1]])
  f.opencode.failure = null
  await f.manager.handleCallback(f.callback("submit"))
  assert.deepEqual(f.replies[1].answers, [["Buttons"]])
  assert.equal(f.record().status, "answered")
  const g = fixture()
  await g.ask()
  await g.manager.handleCallback(g.callback("reject"))
  assert.deepEqual(g.rejected, ["que_test"])
  assert.match(g.edits.at(-1).html, /Questionnaire dismissed/)
})

test("legacy cards upgrade in place and failed renders recover without losing choices", async () => {
  const f = fixture()
  f.records.set("que_test", { requestID: "que_test", serverID: "sample", sessionID: "ses_test", chatId: f.binding.chatId,
    topicId: f.binding.topicId, directory: "/tmp", status: "pending", messageId: 90,
    questions: [{ ...choice(), text: "Legacy text", question: undefined }], notifiedUserIds: ["7"] })
  await f.ask()
  assert.equal(f.sent.length, 0)
  assert.equal(f.record().messageId, 90)
  assert.match(f.edits.at(-1).html, /Legacy text/)
  const edit = f.telegram.editRichMessage
  f.telegram.editRichMessage = async () => { throw new Error("Network unavailable") }
  await f.manager.handleCallback(f.callback("custom"))
  assert.equal(f.record().needsRender, true)
  f.telegram.editRichMessage = edit
  await f.manager.reconcile()
  assert.equal(f.record().needsRender, false)
  assert.equal(f.record().input.questionIndex, 0)
  f.opencode.pending = []
  await f.manager.reconcile()
  assert.equal(f.record().status, "closed")
  await f.manager.handleEvent(f.server, f.binding, { type: "question.replied", properties: { requestID: "que_test", answers: [["Actual answer"]] } })
  assert.equal(f.record().status, "answered", "an authoritative reply supersedes recovery's closed marker")
})

test("rich rendering escapes question text, option labels, descriptions and answers", () => {
  const html = renderQuestionCard({ requestID: "que_test", status: "pending", questions: [choice({
    question: "<tg-button> & question", options: [{ label: "<b>Choice</b>", description: "<script> & details" }],
  })] })
  assert.match(html, /&lt;tg-button&gt; &amp; question/)
  assert.match(html, /○ &lt;b&gt;Choice&lt;\/b&gt;/)
  assert.match(html, /&lt;script&gt; &amp; details/)
})

test("removing custom multi-select text preserves checked options", async () => {
  const f = fixture()
  await f.ask([choice({ multiple: true })])
  await f.manager.handleCallback(f.callback("pick0"))
  await f.manager.handleCallback(f.callback("custom"))
  await f.manager.handleReplyMessage(f.reply("Another gesture"))
  await f.manager.handleCallback(f.callback("clear"))
  await f.manager.handleCallback(f.callback("next"))
  assert.deepEqual(f.replies[0].answers, [["Drag"]])
})

test("the OpenCodez HTTP transport sends one ordered answer batch and supports rejection", async () => {
  const received = []
  const server = http.createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    received.push({ method: request.method, url: new URL(request.url, "http://localhost"), body: body ? JSON.parse(body) : null })
    response.writeHead(200, { "content-type": "application/json" }).end("true")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const client = new OpenCodeClient({ opencode: { servers: [{ id: "sample", url: `http://127.0.0.1:${server.address().port}` }] } })
    const f = fixture()
    f.opencode.replyQuestion = client.replyQuestion.bind(client)
    await f.ask([choice(), choice()])
    await f.manager.handleCallback(f.callback("pick0"))
    await f.manager.handleCallback(f.callback("pick1"))
    assert.equal(received.length, 0)
    await f.manager.handleCallback(f.callback("submit"))
    assert.equal(received[0].method, "POST")
    assert.equal(received[0].url.pathname, "/question/que_test/reply")
    assert.equal(received[0].url.searchParams.get("directory"), "/tmp")
    assert.deepEqual(received[0].body, { answers: [["Drag"], ["Buttons"]] })
    await client.rejectQuestion("sample", "que_other", { directory: "/tmp" })
    assert.equal(received[1].url.pathname, "/question/que_other/reject")
    assert.equal(received[1].method, "POST")
  } finally { await new Promise((resolve) => server.close(resolve)) }
})

test("missing-session cleanup retires input and keeps reply identifiers for the replacement topic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-questions-"))
  try {
    const state = new StateStore(path.join(root, "state.json"))
    await state.load()
    const f = fixture(state)
    await state.bindTopic(f.binding)
    await f.ask()
    await f.manager.handleCallback(f.callback("custom"))
    const oldReply = f.reply("Old session answer")
    await state.removeMissingBinding("sample", "ses_test")
    await f.manager.reconcile()
    assert.equal(f.record().status, "closed")
    assert.equal(f.record().input, null)
    assert.ok(f.deleted.includes(oldReply.reply_to_message.message_id))
    await state.bindTopic({ ...f.binding, sessionID: "ses_replacement" })
    assert.equal(await f.manager.handleReplyMessage(oldReply), true)
    assert.equal(f.replies.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
