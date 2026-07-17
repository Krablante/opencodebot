import assert from "node:assert/strict"
import test from "node:test"

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

function createHarness({ usersOnly = true } = {}) {
  const now = Date.now()
  const binding = {
    serverID: "dima",
    sessionID: "session-1",
    chatId: "-1001",
    topicId: 42,
    directory: "/workspace",
    reconcileAfter: new Date(now - 60_000).toISOString(),
    reconcileUntil: new Date(now + 3_600_000).toISOString(),
    ...(usersOnly ? { reconcileUsersOnlyUntil: new Date(now + 3_600_000).toISOString() } : {}),
  }
  let messages = []
  let terminalMirrors = 0
  const renderedUsers = []
  const renderedAssistants = []
  const activationReasons = []
  const userMirrored = new Set()
  const assistantMirrored = new Set()
  const skippedBackendRequest = Symbol("skipped")

  const state = {
    findBinding: () => binding,
    isUserMirrored: (_serverID, _sessionID, messageID) => userMirrored.has(messageID),
    markUserMirrored: async (_serverID, _sessionID, messageID) => userMirrored.add(messageID),
    consumePendingPrompt: async () => null,
    isAssistantMirrored: (_serverID, _sessionID, messageID) => assistantMirrored.has(messageID),
    markAssistantMirrored: async (_serverID, _sessionID, messageID) => assistantMirrored.add(messageID),
  }
  const renderer = {
    userPrompt: async (_binding, text) => renderedUsers.push(text),
    compactTools: async () => {},
    assistantMessage: async (_binding, text) => renderedAssistants.push(text),
  }
  const promptQueue = {
    markTerminalMirrored: async () => {
      terminalMirrors += 1
    },
  }
  const reconciler = createSessionReconciler({
    config: {},
    state,
    telegram: {},
    opencode: {
      servers: [],
      messages: async () => messages,
    },
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
