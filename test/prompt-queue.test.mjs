import assert from "node:assert/strict"
import test from "node:test"

import { promptPayload } from "../src/opencode.mjs"
import { PromptQueue } from "../src/prompt-queue.mjs"

test("prompt payload leaves message ID generation to OpenCode", () => {
  const payload = promptPayload("hello", { agent: "build", model: null }, [])

  assert.equal("messageID" in payload, false)
})

test("queued prompts wait for both backend idle and terminal mirror", async () => {
  const binding = { serverID: "nuc", sessionID: "ses_queue" }
  const sent = []
  const queue = new PromptQueue(async (_binding, text) => sent.push(text))

  queue.markBusy(binding)
  await queue.enqueue(binding, "first")
  await queue.enqueue(binding, "second")

  assert.equal((await queue.markBackendIdle(binding)).status, "waiting")
  assert.deepEqual(sent, [])
  assert.equal((await queue.markTerminalMirrored(binding)).status, "sent")
  assert.deepEqual(sent, ["first"])

  assert.equal((await queue.markBackendIdle(binding)).status, "waiting")
  assert.deepEqual(sent, ["first"])

  queue.markBusy(binding)
  assert.equal((await queue.markTerminalMirrored(binding)).status, "waiting")
  assert.equal((await queue.markBackendIdle(binding)).status, "sent")
  assert.deepEqual(sent, ["first", "second"])
})

test("duplicate idle and recovered finals cannot release two queued prompts", async () => {
  const binding = { serverID: "local", sessionID: "ses_queue" }
  const sent = []
  const queue = new PromptQueue(async (_binding, text) => sent.push(text))
  queue.markBusy(binding, "msg_001")
  await queue.enqueue(binding, "first")
  await queue.enqueue(binding, "second")

  await queue.markTerminalMirrored(binding, { messageID: "msg_002" })
  await queue.markBackendIdle(binding)
  assert.deepEqual(sent, ["first"])

  // The backend emits session.status idle and session.idle for one completion.
  // Recovery sees its old final again before the new prompt event arrives.
  await queue.markBackendIdle(binding)
  await queue.markTerminalMirrored(binding, { messageID: "msg_002", backendIdle: true })
  queue.observeUserMessage(binding, "msg_001")
  await queue.markTerminalMirrored(binding, { messageID: "msg_002" })
  assert.deepEqual(sent, ["first"])

  queue.markBusy(binding, "msg_003")
  await queue.markTerminalMirrored(binding, { messageID: "msg_002", backendIdle: true })
  await queue.markTerminalMirrored(binding, { messageID: "msg_004" })
  assert.deepEqual(sent, ["first"])
  await queue.markBackendIdle(binding)
  assert.deepEqual(sent, ["first", "second"])
})

test("history ignores older turns and binds a queued submission recovered without SSE", async () => {
  const binding = { serverID: "local", sessionID: "ses_queue" }
  const sent = []
  const queue = new PromptQueue(async (_binding, text) => sent.push(text))
  queue.markBusy(binding)
  await queue.enqueue(binding, "first")
  await queue.enqueue(binding, "second")
  queue.observeUserMessage(binding, "msg_003", { submitted: true })
  await queue.markBackendIdle(binding)
  await queue.markTerminalMirrored(binding, { messageID: "msg_002" })
  assert.deepEqual(sent, [])
  await queue.markTerminalMirrored(binding, { messageID: "msg_004" })
  assert.deepEqual(sent, ["first"])

  queue.observeUserMessage(binding, "msg_005", { submitted: true })
  await queue.markTerminalMirrored(binding, { messageID: "msg_004", backendIdle: true })
  assert.deepEqual(sent, ["first"])
  await queue.markTerminalMirrored(binding, { messageID: "msg_006", backendIdle: true })
  assert.deepEqual(sent, ["first", "second"])
})

test("idle and terminal lookups started before a newer run cannot open its gates", async () => {
  const binding = { serverID: "local", sessionID: "ses_queue" }
  const sent = []
  const queue = new PromptQueue(async (_binding, text) => sent.push(text))
  queue.markBusy(binding, "msg_001")
  const generation = queue.generation(binding)
  await queue.enqueue(binding, "next")
  queue.markBusy(binding, "msg_003")
  await queue.markBackendIdle(binding, { generation })
  await queue.markTerminalMirrored(binding, { messageID: "msg_004", backendIdle: true, generation })
  assert.deepEqual(sent, [])
  await queue.markTerminalMirrored(binding, { messageID: "msg_004" })
  assert.deepEqual(sent, [])
  await queue.markBackendIdle(binding)
  assert.deepEqual(sent, ["next"])
})

test("a busy status invalidates an earlier idle signal without losing the delivered final", async () => {
  const binding = { serverID: "local", sessionID: "ses_queue" }
  const sent = []
  const queue = new PromptQueue(async (_binding, text) => sent.push(text))
  queue.markBusy(binding, "msg_001")
  await queue.enqueue(binding, "next")
  await queue.markBackendIdle(binding)
  queue.markBackendBusy(binding)
  await queue.markTerminalMirrored(binding, { messageID: "msg_002" })
  assert.deepEqual(sent, [])
  await queue.markBackendIdle(binding)
  assert.deepEqual(sent, ["next"])
})
