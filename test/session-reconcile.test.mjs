import assert from "node:assert/strict"
import test from "node:test"

import { loadCurrentTurnMessages } from "../src/final-notifications.mjs"
import { createSessionReconciler } from "../src/session-reconcile.mjs"

test("a recovered web prompt persistently ends users-only catch-up before its assistant arrives", async () => {
  const harness = createHarness()
  harness.setMessages([userMessage("user-1", "Fix the mirror")])

  await harness.reconciler.reconcileBinding(harness.binding)

  assert.deepEqual(harness.renderedUsers, ["Fix the mirror"])
  assert.equal(harness.activationReasons.at(-1), "reconcile-user-prompt")
  assert.equal(harness.binding.reconcileUsersOnlyUntil, undefined)

  harness.setMessages([
    userMessage("user-1", "Fix the mirror"),
    assistantMessage("assistant-1", "Mirroring resumed"),
  ])

  await harness.reconciler.reconcileBinding(harness.binding)

  assert.deepEqual(harness.renderedAssistants, ["Mirroring resumed"])
  assert.equal(harness.assistantMirrored.has("assistant-1"), true)
  assert.equal(harness.terminalMirrors, 1)
})

test("an already mirrored prompt also ends users-only catch-up for a long-running session", async () => {
  const harness = createHarness()
  harness.userMirrored.add("user-1")
  harness.setMessages([
    userMessage("user-1", "Keep working"),
    assistantMessage("assistant-1", "Long-run progress"),
  ])

  await harness.reconciler.reconcileBinding(harness.binding)

  assert.deepEqual(harness.renderedUsers, [])
  assert.deepEqual(harness.renderedAssistants, ["Long-run progress"])
  assert.equal(harness.activationReasons.at(-1), "reconcile-user-prompt")
  assert.equal(harness.binding.reconcileUsersOnlyUntil, undefined)
  assert.equal(harness.assistantMirrored.has("assistant-1"), true)
})

test("historical assistants stay muted until a recovered web prompt is mirrored", async () => {
  const harness = createHarness()
  harness.setMessages([
    assistantMessage("assistant-old", "Historical output"),
    userMessage("user-live", "Continue from here"),
  ])

  await harness.reconciler.reconcileBinding(harness.binding)

  assert.deepEqual(harness.renderedAssistants, [])
  assert.equal(harness.assistantMirrored.has("assistant-old"), true)
  assert.equal(harness.binding.reconcileUsersOnlyUntil, undefined)

  harness.setMessages([
    assistantMessage("assistant-old", "Historical output"),
    userMessage("user-live", "Continue from here"),
    assistantMessage("assistant-live", "Current output"),
  ])

  await harness.reconciler.reconcileBinding(harness.binding)

  assert.deepEqual(harness.renderedAssistants, ["Current output"])
})

test("a replacement branch after revert mirrors without replaying removed messages", async () => {
  const harness = createHarness({ usersOnly: false })
  harness.setMessages([
    userMessage("user-old", "First attempt"),
    assistantMessage("assistant-old", "First result"),
  ])

  await harness.reconciler.reconcileBinding(harness.binding)

  harness.setMessages([
    userMessage("user-new", "Replacement attempt"),
    assistantMessage("assistant-new", "Replacement result"),
  ])

  await harness.reconciler.reconcileBinding(harness.binding)

  assert.deepEqual(harness.renderedUsers, ["First attempt", "Replacement attempt"])
  assert.deepEqual(harness.renderedAssistants, ["First result", "Replacement result"])
  assert.equal(harness.renderedAssistants.filter((text) => text === "First result").length, 1)
})

test("a disabled binding cannot resume reconciliation after a topic reset", async () => {
  const harness = createHarness({ usersOnly: false })
  harness.binding.disabled = true
  harness.binding.disabledReason = "topic-reset"
  harness.setMessages([
    userMessage("user-after-reset", "Old prompt"),
    assistantMessage("assistant-after-reset", "Old result"),
  ])

  const result = await harness.reconciler.reconcileBinding(harness.binding)

  assert.equal(result, undefined)
  assert.deepEqual(harness.renderedUsers, [])
  assert.deepEqual(harness.renderedAssistants, [])
  assert.equal(harness.terminalMirrors, 0)
})

test("incremental reconcile stops paging at the last fully scanned message cursor", async () => {
  const harness = createHarness({
    pages: [
      { messages: [userMessage("user-1", "Prompt"), assistantMessage("assistant-known", "Known")], before: undefined },
      { messages: [assistantMessage("assistant-known", "Known"), assistantMessage("assistant-new", "New progress")], before: "older" },
    ],
    usersOnly: false,
  })
  await harness.reconciler.reconcileBinding(harness.binding)
  harness.renderedAssistants.length = 0
  await harness.reconciler.reconcileBinding(harness.binding)

  assert.equal(harness.pageCalls, 2)
  assert.deepEqual(harness.renderedAssistants, ["New progress"])
})

test("a durable reconcile cursor avoids replaying older pages after restart", async () => {
  const harness = createHarness({
    cursor: "assistant-known",
    pages: [
      { messages: [assistantMessage("assistant-known", "Known"), assistantMessage("assistant-new", "New progress")], before: "older" },
    ],
    usersOnly: false,
  })
  harness.assistantMirrored.add("assistant-known")

  await harness.reconciler.reconcileBinding(harness.binding)

  assert.equal(harness.pageCalls, 1)
  assert.deepEqual(harness.renderedAssistants, ["New progress"])
  assert.deepEqual(harness.pageLimits, [5])
})

test("reconcile uses a small first page and full-sized fallback pages", async () => {
  const harness = createHarness({
    pages: [
      { messages: [assistantMessage("assistant-new", "New progress")], before: "older" },
      { messages: [userMessage("user-old", "Prompt")], before: undefined },
    ],
    usersOnly: false,
  })

  await harness.reconciler.reconcileBinding(harness.binding)

  assert.deepEqual(harness.pageLimits, [5, 20])
})

test("an unchanged watchdog checks the small session object without fetching messages", async () => {
  const harness = createHarness({
    pages: [{ messages: [userMessage("user-1", "Prompt")], before: undefined }],
    usersOnly: false,
    watchdog: true,
  })

  await harness.reconciler.reconcileBinding(harness.binding)
  await harness.reconciler.reconcileBinding(harness.binding)

  assert.equal(harness.pageCalls, 1)
  assert.equal(harness.sessionCalls, 2)
})

test("session discovery is parallel and reuses an overlapping high-water mark", async () => {
  let active = 0
  let maxActive = 0
  const calls = []
  const reconciler = createSessionReconciler({
    config: {
      telegram: { chatId: 1, autocreateTopics: true },
      opencode: { servers: [{ id: "nuc" }, { id: "dima" }] },
    },
    state: {
      chatId: 1,
      seedSeenSessions: async () => 0,
      findBinding: () => undefined,
      hasSeenSession: () => true,
    },
    opencode: {
      listSessions: async (serverID, options) => {
        calls.push({ serverID, options })
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active -= 1
        return [{ id: `session-${serverID}`, time: { updated: 1_000_000 } }]
      },
    },
    telegram: {},
    renderer: {},
    questionManager: {},
    promptQueue: {},
    titleManager: { observeSessions: async () => {} },
    backendRequest: async (_serverID, _operation, request) => request(),
    skippedBackendRequest: Symbol("skipped"),
    isInternalSession: () => false,
    activateBindingForPrompt: async () => {},
    consumePendingPrompt: async () => undefined,
    maybeExtendBindingActivity: async () => {},
    logError: () => {},
    shouldStop: () => false,
  })

  await reconciler.seedExistingSessions()
  await reconciler.reconcileSessions()

  assert.equal(maxActive, 2)
  assert.deepEqual(calls.slice(0, 2).map((call) => call.options.start), [undefined, undefined])
  assert.deepEqual(calls.slice(2).map((call) => call.options.start), [700_000, 700_000])
})

test("final notification history stops at the current turn user message", async () => {
  const calls = []
  const messages = await loadCurrentTurnMessages({
    message: async () => assistantMessage("assistant-final", "Done"),
    messagePage: async (_serverID, _sessionID, options) => {
      calls.push(options)
      return {
        messages: [
          userMessage("user-current", "Current prompt"),
          assistantMessage("assistant-step", "Working"),
          assistantMessage("assistant-final", "Done"),
        ],
        before: "older",
      }
    },
    messages: async () => assert.fail("full history fallback must not run"),
  }, {
    serverID: "dima",
    sessionID: "session-1",
    directory: "/workspace",
  }, "assistant-final")

  assert.deepEqual(messages.map((message) => message.info.id), ["user-current", "assistant-step", "assistant-final"])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].limit, 20)
})

test("final notification history keeps the full-history recovery fallback", async () => {
  const fallback = [userMessage("user-old", "Prompt"), assistantMessage("assistant-final", "Done")]
  const messages = await loadCurrentTurnMessages({
    message: async () => {
      throw new Error("unsupported endpoint")
    },
    messagePage: async () => assert.fail("pagination must stop after exact-message failure"),
    messages: async () => fallback,
  }, {
    serverID: "legacy",
    sessionID: "session-1",
    directory: "/workspace",
  }, "assistant-final")

  assert.equal(messages, fallback)
})

test("a stable message event uses the exact message endpoint before page fallback", async () => {
  const harness = createHarness({ targetedMessage: userMessage("user-web", "Web prompt"), usersOnly: false })

  await harness.reconciler.handleOpenCodeEvent({ id: "dima" }, {
    type: "message.updated",
    properties: { info: { id: "user-web", sessionID: "session-1", role: "user", time: { created: Date.now() } } },
  })
  await harness.reconciler.handleOpenCodeEvent({ id: "dima" }, {
    type: "message.part.updated",
    properties: { part: { id: "part-1", messageID: "user-web", sessionID: "session-1", type: "text", text: "Web prompt" } },
  })
  await new Promise((resolve) => setTimeout(resolve, 550))

  assert.equal(harness.messageCalls, 1)
  assert.equal(harness.pageCalls, 0)
  assert.deepEqual(harness.renderedUsers, ["Web prompt"])
})

test("a completed assistant event uses the exact message renderer", async () => {
  const harness = createHarness({ targetedMessage: assistantMessage("assistant-exact", "Exact answer"), usersOnly: false })

  await harness.reconciler.handleOpenCodeEvent({ id: "dima" }, {
    type: "message.updated",
    properties: {
      info: {
        id: "assistant-exact",
        sessionID: "session-1",
        role: "assistant",
        time: { created: Date.now() - 1, completed: Date.now() },
      },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 200))

  assert.equal(harness.messageCalls, 1)
  assert.equal(harness.pageCalls, 0)
  assert.deepEqual(harness.renderedAssistants, ["Exact answer"])
  assert.equal(harness.renderedAssistants.includes("[object Object]"), false)
})

function createHarness({ cursor, pages, targetedMessage, usersOnly = true, watchdog = false } = {}) {
  const now = Date.now()
  const binding = {
    serverID: "dima",
    sessionID: "session-1",
    chatId: "-1001",
    topicId: 42,
    directory: "/workspace",
    reconcileAfter: new Date(now - 60_000).toISOString(),
    reconcileUntil: new Date(now + 3_600_000).toISOString(),
    ...(cursor ? { reconcileCursorMessageID: cursor } : {}),
    ...(usersOnly ? { reconcileUsersOnlyUntil: new Date(now + 3_600_000).toISOString() } : {}),
  }
  let messages = []
  let terminalMirrors = 0
  let pageCalls = 0
  const pageLimits = []
  let sessionCalls = 0
  let messageCalls = 0
  const renderedUsers = []
  const renderedAssistants = []
  const activationReasons = []
  const userMirrored = new Set()
  const assistantMirrored = new Set()
  const skippedBackendRequest = Symbol("skipped")

  const state = {
    mirrorEnabled: () => true,
    findBinding: () => binding,
    isUserMirrored: (_serverID, _sessionID, messageID) => userMirrored.has(messageID),
    markUserMirrored: async (_serverID, _sessionID, messageID) => userMirrored.add(messageID),
    consumePendingPrompt: async () => null,
    isAssistantMirrored: (_serverID, _sessionID, messageID) => assistantMirrored.has(messageID),
    markAssistantMirrored: async (_serverID, _sessionID, messageID) => assistantMirrored.add(messageID),
    markAssistantMirroredMany: async (_serverID, _sessionID, messageIDs) => messageIDs.forEach((messageID) => assistantMirrored.add(messageID)),
    checkpointBindingReconcileCursor: async (_serverID, _sessionID, messageID) => {
      binding.reconcileCursorMessageID = messageID
    },
  }
  const renderer = {
    userPrompt: async (_binding, text) => renderedUsers.push(text),
    compactTools: async () => {},
    assistantMessage: async (_binding, text) => renderedAssistants.push(text),
  }
  const promptQueue = {
    hasExpectedStop: () => false,
    markBusy: () => {},
    markTerminalMirrored: async () => {
      terminalMirrors += 1
    },
  }
  const opencode = {
    servers: [],
    messages: async () => messages,
    ...(targetedMessage ? {
      message: async () => {
        messageCalls += 1
        return targetedMessage
      },
    } : {}),
    ...(watchdog ? {
      getSession: async () => {
        sessionCalls += 1
        return { id: binding.sessionID, time: { updated: now } }
      },
    } : {}),
    ...(pages ? {
      messagePage: async (_serverID, _sessionID, options) => {
        pageLimits.push(options.limit)
        const page = pages[pageCalls] || { messages: [], before: undefined }
        pageCalls += 1
        return page
      },
    } : {}),
  }
  const reconciler = createSessionReconciler({
    config: {},
    state,
    telegram: {},
    opencode,
    renderer,
    promptQueue,
    questionManager: {},
    backendRequest: async (_serverID, _operation, request) => request(),
    skippedBackendRequest,
    createTopicForSession: async () => {},
    createTopicForWebSession: async () => {},
    isInternalSession: () => false,
    activateBindingForPrompt: async (_binding, reason) => {
      activationReasons.push(reason)
      delete binding.reconcileUsersOnlyUntil
    },
    maybeExtendBindingActivity: async () => {},
    logError: () => {},
    shouldStop: () => false,
    reconcileWatchdogMs: watchdog ? 0 : 60_000,
  })

  return {
    binding,
    reconciler,
    renderedUsers,
    renderedAssistants,
    activationReasons,
    userMirrored,
    assistantMirrored,
    get terminalMirrors() {
      return terminalMirrors
    },
    get pageCalls() {
      return pageCalls
    },
    pageLimits,
    get sessionCalls() {
      return sessionCalls
    },
    get messageCalls() {
      return messageCalls
    },
    setMessages(next) {
      messages = next
    },
  }
}

function userMessage(id, text) {
  return {
    info: {
      id,
      role: "user",
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text }],
  }
}

function assistantMessage(id, text) {
  const now = Date.now()
  return {
    info: {
      id,
      role: "assistant",
      finish: "stop",
      time: { created: now, completed: now },
    },
    parts: [{ type: "text", text }],
  }
}
