import assert from "node:assert/strict"
import test from "node:test"

import { PromptQueue } from "../src/prompt-queue.mjs"

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
