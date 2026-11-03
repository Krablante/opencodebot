import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { StateStore, STATE_SCHEMA_VERSION } from "../src/state.mjs"
import { ControlMenus } from "../src/control-menu.mjs"
import { createRunAlerter } from "../src/run-alerts.mjs"
import { createFinalNotifier } from "../src/final-notifications.mjs"
import { createQuestionManager } from "../src/questions.mjs"
import { startArtifactGateway } from "../src/artifacts-gateway.mjs"
import { bindPendingTopicSession } from "../src/prompt-routing.mjs"
import { createTelegramPolling } from "../src/telegram-polling.mjs"
import { createUpdateManager } from "../src/update-manager.mjs"
import { UserSettings } from "../src/user-settings.mjs"
import { loadConfig } from "../src/config.mjs"
import { OpencodebotArtifactsPlugin } from "../plugins/opencodebot-artifacts/src/index.js"

const config = {
  telegram: { chatId: -1001, chatIds: [-1001, -1002], allowedUserIds: [11, 22] },
  finalNotifications: { enabled: true, userIds: [11, 22], chatUserIds: { "-1001": [11], "-1002": [22] } },
  opencode: { servers: [{ id: "local" }] },
  mirror: {},
  artifacts: { enabled: true, listenHost: "127.0.0.1", port: 0, token: "test", maxPayloadBytes: 65536, maxTextChars: 3400 },
}

async function fixture(t, legacy, settings = config) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-chats-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, "state.json")
  if (legacy) await writeFile(file, JSON.stringify(legacy))
  const state = new StateStore(file)
  await state.load()
  await state.configureChats(settings)
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

test("workshop configuration rejects invalid numeric IDs before deduplication", async (t) => {
  const state = await fixture(t)
  const file = path.join(path.dirname(state.filePath), "config.json")
  const write = (chatIds) => writeFile(file, JSON.stringify({ paths: { serversJson: path.resolve(import.meta.dirname, "../servers.example.json") }, telegram: { chatId: -1001, chatIds } }))
  for (const chatIds of [[-1001, -9007199254740992], [-1001, -1.5], [-1001, 0], [-1001, 123]]) {
    await write(chatIds)
    assert.throws(() => loadConfig(file), /negative Telegram group IDs/)
  }
  await write(["-1001", -1002, -1001])
  assert.deepEqual(loadConfig(file).telegram.chatIds, [-1001, -1002])
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

test("deleted panels recover in their own chat and a failed workshop cannot block startup", async (t) => {
  const state = await fixture(t)
  let unavailable = true
  const edits = [], sends = []
  const panels = new ControlMenus({ config, state, opencode: { sessionStatuses: async () => ({}) },
    promptQueue: { status: () => [] },
    telegram: { sendRichMessage: async (value) => {
      if (value.chatId === -1001 && unavailable) throw new Error("Forbidden: bot was kicked from the supergroup chat")
      sends.push(value); return { message_id: sends.length + 10 }
    }, pinChatMessage: async () => {},
    editRichMessage: async (value) => { edits.push(value); throw new Error("Bad Request: message to edit not found") },
    deleteMessage: async () => {},
    } })
  t.after(() => panels.stop())
  await panels.start()
  assert.ok(panels.forChat(-1001).rotationTimer, "failed startup schedules a bounded retry")
  assert.ok(state.controlMenuMessage(-1002), "the next workshop still starts")
  const otherPanel = structuredClone(state.controlMenuMessage(-1002))
  unavailable = false
  await panels.forChat(-1001).start()
  const count = edits.length
  await panels.forChat(-1001).editMenu("settings", { id: 11 })
  assert.equal(edits.length - count, 1, "a missing panel is cleared before its replacement is created")
  assert.deepEqual(state.controlMenuMessage(-1002), otherPanel)
  assert.deepEqual(Object.keys(state.data.telegram.chats).sort(), ["-1001", "-1002"])
})

test("unsupported state schemas fail before changing state or delivery journals", async (t) => {
  const state = await fixture(t)
  const future = JSON.stringify({ ...state.data, version: STATE_SCHEMA_VERSION + 1 })
  const journal = '["a","local","ses_test","msg_kept"]\n'
  await writeFile(state.filePath, future)
  await writeFile(state.markerPath, journal)
  await assert.rejects(new StateStore(state.filePath).load(), /state schema/i)
  assert.equal(await readFile(state.filePath, "utf8"), future)
  assert.equal(await readFile(state.markerPath, "utf8"), journal)
  for (const invalid of ["null", "[]", '"not state"']) {
    await writeFile(state.filePath, invalid)
    await assert.rejects(new StateStore(state.filePath).load(), /Invalid state document/)
    assert.equal(await readFile(state.filePath, "utf8"), invalid)
    assert.equal(await readFile(state.markerPath, "utf8"), journal)
  }
})

test("concurrent creation in the shared profile library never overwrites an existing profile", async (t) => {
  const state = await fixture(t)
  const settings = new UserSettings({ config: { ...config, defaultPrompt: { serverID: "local" }, promptProfiles: {}, artifacts: {} }, state })
  await settings.initialize()
  const first = { agent: "build", model: { providerID: "sample", modelID: "first" } }
  const second = { agent: "plan", model: { providerID: "sample", modelID: "second" } }
  const results = await Promise.allSettled([settings.saveProfile("shared", first), settings.saveProfile("shared", second)])
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"])
  assert.equal(results[1].reason.code, "PROFILE_EXISTS")
  assert.deepEqual(settings.data.profiles.shared, first)
})

test("failure alerts follow workshop subscriptions independently of the final-DM switch", async (t) => {
  const state = await fixture(t)
  await state.disableFinalNotificationsFor(22)
  const sent = []
  const alerter = createRunAlerter({ config, state, telegram: { sendMessage: async (message) => sent.push(message) } })
  await alerter.notify({ binding: { chatId: -1002, topicId: 42, serverID: "local", sessionID: "ses_second" }, alertKey: "failure", kind: "error" })
  assert.deepEqual(sent.map((message) => String(message.chatId)), ["22"])
})

test("finals and blocking questions use the same chat subscriptions and preserve the personal final switch", async (t) => {
  const state = await fixture(t)
  const binding = { chatId: -1002, topicId: 42, serverID: "local", sessionID: "ses_second" }
  await state.bindTopic(binding)
  for (const user of [11, 22]) await state.setFinalNotificationsEnabledFor(user, true)
  const sent = []
  const telegram = { sendMessage: async (message) => { sent.push(message); return { message_id: sent.length } },
    sendRichMessage: async (message) => { sent.push(message); return { message_id: sent.length } } }
  const opencode = { messages: async () => [] }
  const notifier = createFinalNotifier({ config, state, telegram, opencode })
  await notifier.notifyFinalAnswerReady(binding, { assistantMessageID: "msg_first", messageId: 5 })
  assert.deepEqual(sent.map((message) => String(message.chatId)), ["22"])
  sent.length = 0
  await state.disableFinalNotificationsFor(22)
  await notifier.notifyFinalAnswerReady(binding, { assistantMessageID: "msg_second", messageId: 6 })
  assert.equal(sent.length, 0)
  const questions = createQuestionManager({ config, state, telegram, opencode })
  const ask = (id) => questions.handleEvent({ id: "local" }, binding, { type: "question.asked", properties: {
    id, sessionID: binding.sessionID, questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }],
  } })
  await ask("que_first")
  assert.deepEqual(sent.map((message) => String(message.chatId)), ["-1002", "22"])
  sent.length = 0
  await state.setChatNotificationsFor(-1002, 22, false)
  await ask("que_second")
  assert.deepEqual(sent.map((message) => String(message.chatId)), ["-1002"])
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

test("first-chat bootstrap seeds all recipients before a personal subscription changes", async (t) => {
  const settings = { ...config, telegram: { ...config.telegram, chatId: null, chatIds: [], allowChatBootstrap: true },
    finalNotifications: { ...config.finalNotifications, chatUserIds: {} } }
  const state = await fixture(t, undefined, settings)
  let fetched = false, handled = false
  const signal = AbortSignal.timeout(2000)
  const polling = createTelegramPolling({ config: { ...settings, paths: { statePath: state.filePath } }, state,
    telegram: { sendMessage: async () => {}, getUpdates: async () => {
      if (!fetched) { fetched = true; return [{ update_id: 1, message: {
        chat: { id: -1001, type: "supergroup" }, from: { id: 11 }, message_id: 10, text: "/test",
      } }] }
      await new Promise((resolve) => setTimeout(resolve, 10)); return []
    } },
    commandHandlers: { handle: async () => { handled = true; return true } },
    handleTopicLifecycleMessage: async () => false, extractTelegramFiles: () => [], hasPendingAttachmentBatch: () => false,
    multipartPromptKey: () => "bootstrap", logError: (error) => { throw error },
  })
  await polling.poll({ shouldStop: () => handled, signal })
  assert.deepEqual(state.notificationUserIdsForChat(-1001, [11, 22]), [11, 22])
  await state.setChatNotificationsFor(-1001, 11, false)
  assert.deepEqual(state.notificationUserIdsForChat(-1001, [11, 22]), [22])
})

test("update offers retain chat identity and simultaneous apply clicks create only one installation run", async (t) => {
  const state = await fixture(t)
  const baseSha = "a".repeat(40), targetSha = "b".repeat(40)
  const offers = config.telegram.chatIds.map((chatId) => ({ chatId, messageId: 7, baseSha, targetSha, components: {} }))
  await state.update((data) => { data.updates.offers = structuredClone(offers) })
  const runtimeDir = path.join(path.dirname(state.filePath), "updates")
  await mkdir(runtimeDir)
  await writeFile(path.join(runtimeDir, "runner.json"), "{}")
  const answers = []
  const manager = createUpdateManager({ config: { ...config, updates: { runtimeDir, currentRevision: baseSha } }, state,
    telegram: { answerCallbackQuery: async (value) => answers.push(value), editMessageText: async () => {} } })
  t.after(() => manager.stop())
  const callback = (chatId, action) => ({ id: String(chatId), from: { id: 11 }, message: { chat: { id: chatId }, message_id: 7 }, data: `upd:${action}:${targetSha}` })
  await manager.handleCallback(callback(-1001, "later"))
  assert.equal(state.data.updates.offers.length, 1)
  assert.equal(state.data.updates.offers[0].chatId, -1002)
  await state.update((data) => { data.updates.offers = structuredClone(offers) })
  answers.length = 0
  await Promise.all(config.telegram.chatIds.map((chatId) => manager.handleCallback(callback(chatId, "apply"))))
  assert.equal(answers.filter((answer) => answer.showAlert).length, 1, "second apply is told an installation update is already running")
  const request = JSON.parse(await readFile(path.join(runtimeDir, "request.json"), "utf8"))
  assert.equal(request.id, state.data.updates.activeRun.id)
  await manager.reconcileStatus()
  manager.stop()
  await writeFile(path.join(runtimeDir, "status.json"), JSON.stringify({ id: request.id, stage: "succeeded" }))
  manager.telegram.editMessageText = manager.telegram.sendMessage = async () => { throw new Error("Telegram temporarily unavailable") }
  await manager.reconcileStatus()
  assert.equal(state.data.updates.activeRun.id, request.id, "failed status delivery remains retryable")
  let begin, release, deliveries = 0
  const started = new Promise((resolve) => { begin = resolve })
  manager.telegram.editMessageText = async () => {
    deliveries++; begin(); await new Promise((resolve) => { release = resolve })
  }
  const first = manager.reconcileStatus(), second = manager.reconcileStatus()
  assert.equal(first, second)
  await started
  assert.equal(deliveries, 1)
  release()
  await first
  assert.equal(state.data.updates.activeRun, null)
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
  await state.configureChats({ ...config, telegram: { ...config.telegram, chatIds: [-1001] } })
  await assert.rejects(plugin.tool.opencodebot_send_artifact.execute({ text: "removed workshop", caption: "routing", mode: "text" }, { sessionID: "ses_second" }), /inactive/)
  await state.configureChats(config)
  await state.patchChat(-1002, { artifactsTopic: null })
  await assert.rejects(plugin.tool.opencodebot_send_artifact.execute({ text: "missing destination", caption: "routing", mode: "text" }, { sessionID: "ses_second" }), /FILES is not configured/)
  await state.setArtifactsTopic({ chatId: -1002, topicId: 8 })
  await state.disableBinding("local", "ses_second", "closed")
  await assert.rejects(plugin.tool.opencodebot_send_artifact.execute({ text: "closed", caption: "routing", mode: "text" }, { sessionID: "ses_second" }), /inactive/)
  assert.equal(sent.length, 4)
})
