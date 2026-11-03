import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { StateStore } from "../src/state.mjs"
import { ControlMenus } from "../src/control-menu.mjs"
import { createRunAlerter } from "../src/run-alerts.mjs"
import { startArtifactGateway } from "../src/artifacts-gateway.mjs"
import { bindPendingTopicSession } from "../src/prompt-routing.mjs"
import { createTelegramPolling } from "../src/telegram-polling.mjs"
import { OpencodebotArtifactsPlugin } from "../plugins/opencodebot-artifacts/src/index.js"

const config = {
  telegram: { chatId: -1001, chatIds: [-1001, -1002], allowedUserIds: [11, 22] },
  finalNotifications: { enabled: true, userIds: [11, 22], chatUserIds: { "-1001": [11], "-1002": [22] } },
  opencode: { servers: [{ id: "local" }] },
  mirror: {},
  artifacts: { enabled: true, listenHost: "127.0.0.1", port: 0, token: "test", maxPayloadBytes: 65536, maxTextChars: 3400 },
}

async function fixture(t, legacy) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-chats-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, "state.json")
  if (legacy) await writeFile(file, JSON.stringify(legacy))
  const state = new StateStore(file)
  await state.load()
  await state.configureChats(config)
  await state.initializeAnswerStats("UTC")
  return state
}

test("legacy chat migration preserves panels, destinations, pending launches and counters across restart", async (t) => {
  const state = await fixture(t, {
    telegram: { chatId: -1001, controlMenu: { chatId: -1001, messageId: 7, createdAt: 1 },
      artifactsTopic: { chatId: -1001, topicId: 8 }, soundsTopic: { chatId: -1001, topicId: 9 }, soundsMenuMessageId: 10 },
    pendingTopics: { "42": { chatId: -1001, serverID: "local", title: "kept" } },
    preferences: { setupComplete: true },
    answerStats: { startedAt: Date.now(), answers: [{ key: "old", at: Date.now() }] },
  })
  assert.equal(state.controlMenuMessage(-1001).messageId, 7)
  assert.equal(state.artifactsTopic(-1001).topicId, 8)
  assert.equal(state.soundsMenuMessageId(-1001), 10)
  assert.equal(state.chatRecord(-1001).setupComplete, true)
  assert.equal(state.pendingTopic(42, -1001).title, "kept")
  assert.equal(state.pendingTopic(42, -1002), undefined)
  assert.equal(state.artifactsTopic(-1002), null)
  assert.equal(state.answersToday(Date.now(), -1001), 1)
  assert.equal(state.answersToday(Date.now(), -1002), 0)
  const reloaded = new StateStore(state.filePath)
  await reloaded.load()
  await reloaded.configureChats(config)
  assert.deepEqual(reloaded.data.pendingTopics, state.data.pendingTopics)
  assert.equal(reloaded.data.telegram.controlMenu, undefined)
  assert.equal(reloaded.controlMenuMessage(-1001).messageId, 7)
  assert.deepEqual(reloaded.notificationUserIdsForChat(-1001, [11, 22]), [11])
  assert.deepEqual(reloaded.notificationUserIdsForChat(-1002, [11, 22]), [22])
})

test("identical topic IDs have independent launch, reset, title, closure and service-topic state", async (t) => {
  const state = await fixture(t)
  for (const chatId of config.telegram.chatIds) await state.addPendingTopic(42, { chatId, serverID: "local", title: String(chatId) })
  let sequence = 0
  const opencode = { defaultNewSessionDirectory: () => "/tmp", createSession: async () => ({ id: `ses_${++sequence}` }) }
  const bind = (chatId) => bindPendingTopicSession({ state, opencode, pending: state.pendingTopic(42, chatId), message: { chat: { id: chatId }, message_thread_id: 42 } })
  const [first, second] = await Promise.all([bind(-1001), bind(-1002)])
  assert.notEqual(first.sessionID, second.sessionID)
  await state.resetBindingToPending(first)
  assert.equal(state.pendingTopic(42, -1001).chatId, -1001)
  assert.equal(state.findBindingByTopic(-1002, 42).sessionID, second.sessionID)
  await state.updateTopicMetadata(-1001, 42, { title: "renamed", topicBaseTitle: "renamed", topicTitle: "renamed", titleSource: "user" })
  assert.equal(state.topicRecord(-1001, 42).title, "renamed")
  assert.equal(state.topicRecord(-1002, 42).title, "-1002")
  await state.recordDeliveredAnswer(second, "msg_second")
  assert.equal(state.answersToday(Date.now(), -1001), 0)
  assert.equal(state.answersToday(Date.now(), -1002), 1)
  await state.disableTopic(-1001, 42, "closed")
  assert.equal(state.pendingTopic(42, -1001), undefined)
  assert.equal(state.findBindingByTopic(-1002, 42).sessionID, second.sessionID)
  for (const chatId of config.telegram.chatIds) {
    await state.setArtifactsTopic({ chatId, topicId: 8 })
    await state.setSoundsTopic({ chatId, topicId: 9 })
    await state.setSoundsMenuMessageId(10, chatId)
  }
  await state.clearSoundsTopic(-1001, 9)
  assert.equal(state.isSoundsTopic(-1002, 9), true)
  assert.equal(state.soundsMenuMessageId(-1002), 10)
  assert.equal(state.isArtifactsTopic(-1001, 8), true)
  assert.equal(state.isArtifactsTopic(-1002, 8), true)
})

test("General panels with identical message IDs navigate independently and subscriptions survive restart", async (t) => {
  const state = await fixture(t)
  const edited = []
  const panels = new ControlMenus({ config, state, opencode: { sessionStatuses: async () => ({}) },
    promptQueue: { status: () => [] },
    telegram: { sendRichMessage: async () => ({ message_id: 7 }), pinChatMessage: async () => {},
      editRichMessage: async (value) => edited.push(value), answerCallbackQuery: async () => {} } })
  t.after(() => panels.stop())
  await panels.start()
  await panels.handleCallback({ from: { id: 11 }, message: { chat: { id: -1001 }, message_id: 7 }, data: "panel:sessions" })
  assert.equal(panels.forChat(-1001).currentPage, "sessions")
  assert.equal(panels.forChat(-1002).currentPage, "home")
  assert.equal(edited.at(-1).chatId, -1001)
  await panels.handleCallback({ from: { id: 11 }, message: { chat: { id: -1002 }, message_id: 7 }, data: "panel:subscribe:1" })
  assert.deepEqual(state.notificationUserIdsForChat(-1002, [11, 22]), [11, 22])
  assert.deepEqual(state.notificationUserIdsForChat(-1001, [11, 22]), [11])
  const stored = JSON.parse(await readFile(state.filePath, "utf8"))
  assert.deepEqual(stored.telegram.chats["-1002"].notificationUserIds, ["22", "11"])
})

test("failure alerts follow workshop subscriptions independently of the final-DM switch", async (t) => {
  const state = await fixture(t)
  await state.disableFinalNotificationsFor(22)
  const sent = []
  const alerter = createRunAlerter({ config, state, telegram: { sendMessage: async (message) => sent.push(message) } })
  await alerter.notify({ binding: { chatId: -1002, topicId: 42, serverID: "local", sessionID: "ses_second" }, alertKey: "failure", kind: "error" })
  assert.deepEqual(sent.map((message) => String(message.chatId)), ["22"])
})

test("one polling loop accepts both configured chats and rejects other groups", async (t) => {
  const state = await fixture(t)
  const abort = new AbortController()
  const handled = []
  let fetched = false
  const polling = createTelegramPolling({ config: { ...config, paths: { statePath: state.filePath } }, state,
    telegram: { sendMessage: async () => {}, getUpdates: async () => {
      if (!fetched) { fetched = true; return [-1001, -1002, -1003].map((chatId, index) => ({ update_id: index + 1, message: {
        chat: { id: chatId, type: "supergroup" }, from: { id: 11 }, message_thread_id: 42, message_id: 10, text: "/test",
      } })) }
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (handled.length === 2) abort.abort()
      return []
    } },
    commandHandlers: { handle: async (message) => { handled.push(message.chat.id); return true } },
    handleTopicLifecycleMessage: async () => false, extractTelegramFiles: () => [], hasPendingAttachmentBatch: () => false,
    multipartPromptKey: (message) => `${message.chat.id}:42:11`,
    logError: (error) => { throw error },
  })
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(2000)])
  await polling.poll({ shouldStop: () => signal.aborted, signal })
  assert.deepEqual(handled.sort((a, b) => a - b), [-1002, -1001])
})

test("artifact plugin supplies session identity and the gateway routes files and text by session, including parents", async (t) => {
  const state = await fixture(t)
  for (const chatId of config.telegram.chatIds) await state.setArtifactsTopic({ chatId, topicId: 8 })
  await state.bindTopic({ chatId: -1002, topicId: 42, serverID: "local", sessionID: "ses_second" })
  const sent = []
  const spoolDir = path.join(path.dirname(state.filePath), "spool")
  const gateway = startArtifactGateway({ config: { ...config, telegram: { ...config.telegram, botApi: { mode: "cloud", spoolDir } } }, state, telegram: {
    sendMessage: async (message) => { sent.push(message); return { message_id: sent.length } },
    sendDocument: async (message) => { assert.equal(await readFile(message.file.localPath, "utf8"), "file bytes"); sent.push(message); return { message_id: sent.length } },
  }, opencode: { servers: new Map([["local", {}]]), getSession: async (_server, sessionID) => sessionID === "ses_child" ? { parentID: "ses_second" } : {} } })
  t.after(async () => { gateway.closeAllConnections(); await new Promise((resolve) => gateway.close(resolve)) })
  if (!gateway.listening) await new Promise((resolve) => gateway.once("listening", resolve))
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`
  const plugin = await OpencodebotArtifactsPlugin({}, { gatewayUrl, token: "test", serverID: "local" })
  await plugin.tool.opencodebot_send_artifact.execute({ text: "test", caption: "routing", mode: "text" }, { sessionID: "ses_second" })
  assert.equal(sent.at(-1).chatId, -1002)
  await plugin.tool.opencodebot_send_artifact.execute({ text: "child", caption: "routing", mode: "text" }, { sessionID: "ses_child" })
  assert.equal(sent.at(-1).chatId, -1002)
  await plugin.tool.opencodebot_send_artifact.execute({ text: "standalone", caption: "routing", mode: "text" }, {})
  assert.equal(sent.at(-1).chatId, -1001)
  const artifact = path.join(path.dirname(state.filePath), "artifact.txt")
  await writeFile(artifact, "file bytes")
  await plugin.tool.opencodebot_send_artifact.execute({ path: artifact, caption: "routing", mode: "document" }, { sessionID: "ses_second" })
  assert.equal(sent.at(-1).chatId, -1002)
  assert.deepEqual(await readdir(spoolDir), [])
  await state.disableBinding("local", "ses_second", "closed")
  await assert.rejects(plugin.tool.opencodebot_send_artifact.execute({ text: "closed", caption: "routing", mode: "text" }, { sessionID: "ses_second" }), /inactive/)
  assert.equal(sent.length, 4)
})
