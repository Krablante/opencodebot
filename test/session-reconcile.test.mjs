import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { fromMarkdown } from "mdast-util-from-markdown"

import {
  buildCollapsedContextMessages,
  extractContextTurns,
  loadRecentContextTurns,
  parseContextTurnCount,
} from "../src/context-export.mjs"
import { loadCurrentTurnMessages } from "../src/final-notifications.mjs"
import { createSessionReconciler } from "../src/session-reconcile.mjs"
import { PromptQueue } from "../src/prompt-queue.mjs"
import { extractSessionExportTurns, loadSessionExport, sendSessionExport, sessionMarkdownChunks } from "../src/session-export.mjs"
import { createTelegramCommandHandlers } from "../src/commands.mjs"
import { TelegramClient } from "../src/telegram.mjs"
import { createTelegramPolling } from "../src/telegram-polling.mjs"

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

test("paired idle events and recovery of the previous final release only one queued task", async () => {
  const sent = []
  let backendStatus = { type: "idle" }
  const queue = new PromptQueue(async (_binding, text) => sent.push(text))
  const harness = createHarness({ usersOnly: false, queue, sessionStatus: async () => backendStatus })
  const { binding, reconciler } = harness
  const event = (type, properties) => reconciler.handleOpenCodeEvent({ id: binding.serverID }, {
    type, properties: { sessionID: binding.sessionID, ...properties },
  })
  queue.markBusy(binding, "msg_001")
  await queue.enqueue(binding, "first")
  await queue.enqueue(binding, "second")
  harness.setMessages([userMessage("msg_001", "original"), assistantMessage("msg_002", "original final")])
  harness.userMirrored.add("msg_001")
  harness.assistantMirrored.add("msg_002")
  await queue.markTerminalMirrored(binding, { messageID: "msg_002" })

  await event("session.status", { status: { type: "idle" } })
  assert.deepEqual(sent, ["first"])
  // Keep the backend temporarily idle before its new user event is observable.
  await event("session.idle", {})
  await reconciler.reconcileBinding(binding)
  assert.deepEqual(sent, ["first"])
  assert.equal(queue.status(binding).length, 1)

  backendStatus = { type: "busy" }
  await event("message.updated", { info: { ...userMessage("msg_003", "first").info, sessionID: binding.sessionID } })
  await event("message.updated", { info: { ...assistantMessage("msg_002", "original final").info, sessionID: binding.sessionID } })
  await event("session.idle", {})
  assert.deepEqual(sent, ["first"])

  harness.setMessages([userMessage("msg_003", "first"), assistantMessage("msg_004", "first final")])
  await queue.markTerminalMirrored(binding, { messageID: "msg_004" })
  assert.deepEqual(sent, ["first"])
  backendStatus = { type: "idle" }
  await event("session.status", { status: backendStatus })
  assert.deepEqual(sent, ["first", "second"])
  assert.equal(queue.isBusy(binding), true)
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
          userMessage("user-previous", "Previous prompt"),
          assistantMessage("assistant-previous", "Previous answer"),
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
    serverID: "recovery",
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

test("a completed assistant event recovers through the exact-message path when lifecycle rendering missed it", async () => {
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
  assert.deepEqual(harness.renderedAssistants, ["Exact answer"])
})

test("context export counts interrupted prompts, keeps completed answers, and omits the active turn", () => {
  const turns = extractContextTurns([
    userMessage("user-1", "First prompt"),
    { info: { id: "assistant-tool", role: "assistant", finish: "tool-calls" }, parts: [{ type: "text", text: "intermediate" }] },
    assistantMessage("assistant-1", "First final"),
    userMessage("user-interrupted", "Interrupted prompt"),
    { info: { id: "assistant-partial", role: "assistant", finish: "length" }, parts: [{ type: "text", text: "Interrupted progress" }] },
    { info: { id: "user-2", role: "user" }, parts: [{ type: "text", text: "Second prompt" }, { type: "file", filename: "image.png", mime: "image/png" }] },
    assistantMessage("assistant-2", "Second final"),
    userMessage("user-active", "Still running"),
    { info: { id: "assistant-active", role: "assistant", finish: "tool-calls" }, parts: [{ type: "text", text: "Active progress must stay out" }] },
  ])

  assert.deepEqual(turns, [
    { prompt: "First prompt", answer: "First final", progress: [], interrupted: false },
    { prompt: "Interrupted prompt", answer: "", progress: ["Interrupted progress"], interrupted: true },
    { prompt: "Second prompt\n[Attachment: image.png (image/png)]", answer: "Second final", progress: [], interrupted: false },
  ])
})

test("the latest ledger-marked interruption exports user prompt and visible progress notes", () => {
  const turns = extractContextTurns([
    userMessage("user-interrupted", "Keep this prompt"),
    {
      info: { id: "assistant-progress-1", role: "assistant", finish: "tool-calls" },
      parts: [{ type: "reasoning", text: "private reasoning" }, { type: "text", text: "First progress note" }, { type: "tool", tool: "bash", state: { output: "private tool output" } }],
    },
    { info: { id: "assistant-progress-2", role: "assistant", finish: "length" }, parts: [{ type: "text", text: "Second progress note" }] },
  ], { interruptedUserMessageIDs: new Set(["user-interrupted"]) })
  const rich = buildCollapsedContextMessages(turns)

  assert.deepEqual(turns, [{ prompt: "Keep this prompt", answer: "", progress: ["First progress note", "Second progress note"], interrupted: true }])
  assert.match(rich[0].html, /User — interrupted/)
  assert.match(rich[0].html, /Progress 1[\s\S]*First progress note[\s\S]*Progress 2[\s\S]*Second progress note/)
  assert.doesNotMatch(rich[0].html, /private reasoning|private tool output|### Assistant/)
})

test("context history pagination verifies the oldest selected turn before stopping", async () => {
  const calls = []
  const turns = await loadRecentContextTurns({
    opencode: {
      async messagePage(_serverID, _sessionID, options) {
        calls.push(options)
        if (!options.before) return { messages: [userMessage("active", "Active")], before: "older" }
        if (options.before === "oldest") return { messages: [userMessage("user-0", "Earlier prompt"), assistantMessage("assistant-0", "Earlier final")], before: null }
        return { messages: [userMessage("user-1", "Prompt"), assistantMessage("assistant-1", "Final")], before: "oldest" }
      },
    },
    binding: { serverID: "dima", sessionID: "session-1", directory: "/workspace" },
    count: 1,
  })

  assert.deepEqual(turns, [{ prompt: "Prompt", answer: "Final", progress: [], interrupted: false }])
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map((call) => call.before), [undefined, "older", "oldest"])
})

test("context follows compaction replays and reminders to the original external prompt", () => {
  const original = { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "Original request" }] }
  const marker = { info: { role: "user", id: "compact" }, parts: [{ type: "compaction", turn_id: "u1", replay_id: "replay" }] }
  const replay = { info: { role: "user", id: "replay" }, parts: [{ type: "text", text: "Duplicated request" }] }
  const reminder = { info: { role: "user", id: "reminder" }, parts: [{ type: "text", text: "REMINDER: original request", metadata: { opencodebot_reminder: { turnID: "u1", compactionID: "compact" } } }] }
  const summary = { info: { role: "assistant", id: "summary", parentID: "compact", finish: "stop", summary: true }, parts: [{ type: "text", text: "Internal summary" }] }
  const final = { info: { role: "assistant", id: "final", parentID: "reminder", finish: "stop" }, parts: [{ type: "text", text: "Actual final answer" }] }
  assert.deepEqual(extractContextTurns([original, marker, summary, replay, reminder, final]), [{ prompt: "Original request", answer: "Actual final answer", progress: [], interrupted: false }])
})

test("collapsed context chunks remain hidden, escaped, and copyable without truncation", () => {
  const answer = `<tag>&${"x".repeat(120)}`
  const messages = buildCollapsedContextMessages([
    { prompt: "Prompt <private>", answer },
    { prompt: "Second", answer: "Done" },
  ], { maxRichContentBytes: 100 })

  assert.ok(messages.length > 1)
  assert.ok(messages.every((message) => message.html.startsWith("<details><summary>")))
  assert.ok(messages.every((message) => message.html.includes("<pre><code>")))
  assert.ok(messages.every((message) => !message.html.includes("Prompt <private>")))
  assert.ok(messages.every((message) => {
    const escaped = message.html.match(/<pre><code>([\s\S]*)<\/code><\/pre>/)?.[1] || ""
    return Buffer.byteLength(escaped, "utf8") <= 100
  }))
  assert.equal(messages.map((message) => message.text).join(""), "### User\nPrompt <private>\n\n### Assistant\n" + answer + "\n\n---\n\n### User\nSecond\n\n### Assistant\nDone")
})

test("context turn count accepts only the supported range", () => {
  assert.equal(parseContextTurnCount("3"), 3)
  assert.equal(parseContextTurnCount("", { allowEmpty: true }), undefined)
  assert.throws(() => parseContextTurnCount("0"), /1 to 10/)
  assert.throws(() => parseContextTurnCount("11"), /1 to 10/)
  assert.throws(() => parseContextTurnCount("three"), /1 to 10/)
})

test("session export preserves literal repetitions and finals without older prompts' progress notes", () => {
  const prompt = "  Repeat this\n\n## Pretend heading\n````\n<literal>&\t\r\n"
  const final = "\n  **Final**\n```js\nx()\n```\n\n"
  const done = assistantMessage("a1", final)
  done.info.parentID = "u1"
  const messages = [
    userMessage("u1", prompt),
    { info: { id: "a-progress", role: "assistant", parentID: "u1", finish: "tool-calls" }, parts: [
      { type: "text", text: "discard completed progress" }, { type: "reasoning", text: "secret reasoning" },
      { type: "tool", state: { output: "secret tool output" } },
    ] },
    done,
    userMessage("u2", prompt),
    { info: { id: "a2", role: "assistant", parentID: "u2", finish: "length" }, parts: [{ type: "text", text: "  unfinished note\n" }] },
    userMessage("u3", "Last prompt with no notes"),
    userMessage("u4", "Later prompt with a final"),
    { info: { id: "a4", role: "assistant", parentID: "u4", finish: "stop", time: { completed: 1 } }, parts: [{ type: "text", text: "Later completed final" }] },
  ]
  const original = structuredClone(messages)
  const turns = extractSessionExportTurns(messages)
  assert.deepEqual(turns.map((turn) => turn.prompt), [[prompt], [prompt], ["Last prompt with no notes"], ["Later prompt with a final"]])
  assert.deepEqual(turns[0].answer, [final])
  assert.deepEqual(turns[0].progress, [])
  assert.equal(turns[1].answer, null)
  assert.deepEqual(turns[1].progress, [])
  assert.equal(turns[2].answer, null)
  assert.deepEqual(turns[3].answer, ["Later completed final"])
  assert.deepEqual(messages, original)
  const markdown = [...sessionMarkdownChunks(turns, "en")].join("")
  assert.equal(markdown.split(prompt).length - 1, 2)
  assert.ok(markdown.includes(final))
  assert.doesNotMatch(markdown, /discard completed progress|secret reasoning|secret tool output/)
  assert.doesNotMatch(markdown, /Appendix — progress notes|unfinished note|progress note 1/)
  const tree = fromMarkdown(markdown)
  assert.equal(tree.children.filter((node) => node.type === "heading").some((node) => node.children[0]?.value === "Pretend heading"), false)
  assert.equal(tree.children.filter((node) => node.type === "code").length, 6)
  assert.equal(tree.children.filter((node) => node.type === "heading" && node.depth === 1).length, 1)
  const russian = [...sessionMarkdownChunks(turns, "ru")].join("")
  assert.doesNotMatch(russian, /Приложение — промежуточные сообщения|unfinished note|progress note 1/)
})

test("session export appends only the latest prompt's notes while its final is missing", () => {
  const note = (id, parentID, text) => ({ info: { id, role: "assistant", parentID, finish: "tool-calls", time: { completed: 1 } }, parts: [{ type: "text", text }] })
  const turns = extractSessionExportTurns([
    userMessage("u1", "Earlier unfinished prompt"), note("a1", "u1", "Earlier progress"),
    userMessage("u2", "Latest unfinished prompt"), note("a-late", "u1", "Late progress for earlier prompt"),
    { info: { id: "c2", role: "user" }, parts: [{ type: "compaction", turn_id: "u2", replay_id: "r2" }] },
    userMessage("r2", "Internal replay"), note("a2", "r2", "  Latest note one\n"), note("a3", "r2", "Latest note two"),
  ])
  assert.equal(turns.length, 2)
  assert.deepEqual(turns[0].progress, [])
  assert.deepEqual(turns[1].progress, [["  Latest note one\n"], ["Latest note two"]])
  for (const language of ["en", "ru"]) {
    const markdown = [...sessionMarkdownChunks(turns, language)].join("")
    assert.ok(markdown.includes("  Latest note one\n"))
    assert.ok(markdown.includes("Latest note two"))
    assert.match(markdown, /### (Prompt|Запрос) 2 — progress note 1/)
    assert.match(markdown, /### (Prompt|Запрос) 2 — progress note 2/)
    assert.doesNotMatch(markdown, /Earlier progress|Late progress|Internal replay/)
    assert.ok(markdown.indexOf("Latest note one") > markdown.indexOf("Latest unfinished prompt"))
  }
  turns[0].progress = [["Stale older notes"]]
  turns[1].progress = []
  assert.doesNotMatch([...sessionMarkdownChunks(turns, "en")].join(""), /Appendix — progress notes|Stale older notes/)
  turns[1].answer = ["Latest completed final"]
  turns[1].progress = [["Stale latest notes"]]
  assert.doesNotMatch([...sessionMarkdownChunks(turns, "en")].join(""), /Appendix — progress notes|Stale latest notes|Stale older notes/)
})

test("session export preserves separate source text parts without inserting separators into their contents", () => {
  const prompt = ["  First part\n", "\nSecond part  "]
  const answer = ["**Answer part one**", "\tAnswer part two\n\n"]
  const turns = extractSessionExportTurns([
    { info: { role: "user", id: "u1" }, parts: prompt.map((text) => ({ type: "text", text })) },
    { info: { role: "assistant", id: "a1", parentID: "u1", finish: "stop", time: { completed: 1 } },
      parts: answer.map((text) => ({ type: "text", text })) },
  ])
  const markdown = [...sessionMarkdownChunks(turns, "en")].join("")
  assert.deepEqual(fromMarkdown(markdown).children.filter((node) => node.type === "code").map((node) => node.value), [...prompt, ...answer])
  assert.doesNotMatch(markdown, /Appendix — progress notes/)
})

test("session export resolves chained replay/reminder parents and only accepts completed non-summary finals", () => {
  const original = userMessage("u1", "  Original\n")
  const marker = { info: { id: "c1", role: "user" }, parts: [{ type: "compaction", turn_id: "u1", replay_id: "r1" }] }
  const replay = userMessage("r1", "automatic replay")
  const secondMarker = { info: { id: "c2", role: "user" }, parts: [{ type: "compaction", turn_id: "r1", replay_id: "r2" }] }
  const secondReplay = userMessage("r2", "second automatic replay")
  const reminder = { info: { id: "reminder", role: "user" }, parts: [{ type: "text", text: "internal reminder",
    metadata: { opencodebot_reminder: { turnID: "r2", compactionID: "c2" } } }] }
  const final = (id, text, extra = {}) => ({ info: { id, role: "assistant", parentID: "reminder", finish: "stop", time: { completed: 10 }, ...extra }, parts: [{ type: "text", text }] })
  const turns = extractSessionExportTurns([
    original, marker, final("summary", "internal summary", { summary: true }), replay,
    secondMarker, secondReplay, reminder, final("first", "first final"), final("latest", "  latest final\n"),
    { info: { id: "synthetic", role: "user" }, parts: [{ type: "text", text: "synthetic input", synthetic: true }] },
    userMessage("u2", "Unfinished"),
    { info: { id: "draft", role: "assistant", parentID: "u2", finish: "stop" }, parts: [{ type: "text", text: "streaming final draft" }] },
    userMessage("u3", "Failed"), final("error", "failed output", { parentID: "u3", error: { name: "MessageAbortedError" } }),
  ])
  assert.equal(turns.length, 3)
  assert.deepEqual(turns[0].prompt, ["  Original\n"])
  assert.deepEqual(turns[0].answer, ["  latest final\n"])
  assert.equal(turns[1].answer, null)
  assert.deepEqual(turns[1].progress, [])
  assert.equal(turns[2].answer, null)
  assert.doesNotMatch([...sessionMarkdownChunks(turns, "en")].join(""), /automatic replay|internal reminder|internal summary|synthetic input|first final/)
})

test("full session export reads every page, follows cross-page replay links and hides revert/future tails", async () => {
  const calls = []
  const { title, turns } = await loadSessionExport({
    binding: { serverID: "local", sessionID: "session-1", directory: "/workspace" }, asOf: 100,
    opencode: {
      async getSession() { return { title: "Actual OpenCodez session name", revert: { messageID: "009" } } },
      async messagePage(_server, _session, options) {
        calls.push(options)
        if (!options.before) return { before: "middle", messages: [
          { info: { id: "005", role: "assistant", parentID: "004", finish: "stop", time: { completed: 90 } }, parts: [{ type: "text", text: "Final" }] },
          { info: { id: "008", role: "user", time: { created: 101 } }, parts: [{ type: "text", text: "future" }] },
          { info: { id: "009", role: "user" }, parts: [{ type: "text", text: "reverted" }] },
        ] }
        if (options.before === "middle") return { before: "oldest", messages: [
          { info: { id: "003", role: "user" }, parts: [{ type: "compaction", turn_id: "001", replay_id: "004" }] },
          { info: { id: "004", role: "user" }, parts: [{ type: "text", text: "replay" }] },
        ] }
        return { messages: [
          { info: { id: "001", role: "user" }, parts: [{ type: "text", text: "Original" }] },
          { info: { id: "002", role: "assistant", finish: "tool-calls", parentID: "001" }, parts: [{ type: "text", text: "progress" }] },
        ] }
      },
    },
  })
  assert.deepEqual(calls.map((call) => call.before), [undefined, "middle", "oldest"])
  assert.ok(calls.every((call) => call.directory === "/workspace"))
  assert.equal(title, "Actual OpenCodez session name")
  assert.deepEqual(turns, [{ userMessageID: "001", prompt: ["Original"], answer: ["Final"], progress: [] }])
  await assert.rejects(loadSessionExport({ binding: {}, opencode: {
    getSession: async () => ({}), messagePage: async () => ({ messages: [], before: "loop" }),
  } }), /repeated history cursor/)
})

test("/export uploads a file-backed Markdown document to its topic and removes temporary files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencodebot-export-test-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let received
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const form = await new Request("http://test/", { method: "POST", headers: request.headers, body: Buffer.concat(chunks) }).formData()
    received = { url: request.url, chat: form.get("chat_id"), topic: form.get("message_thread_id"),
      filename: form.get("document").name, text: await form.get("document").text() }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: { message_id: 1 } }))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const telegram = new TelegramClient("test", { rootUrl: `http://127.0.0.1:${server.address().port}` })
  const binding = { chatId: -1001, topicId: 42, serverID: "local", sessionID: "ses_export", title: "Telegram topic name" }
  const messages = [
    userMessage("u0", "Earlier superseded prompt"),
    { info: { id: "a0", role: "assistant", parentID: "u0", finish: "tool-calls" }, parts: [{ type: "text", text: "Earlier progress" }] },
    userMessage("u1", "  Literal\n\n<user>&"), assistantMessage("a1", "**Final**\n"),
  ]
  let sessionReads = 0
  const sessionTitle = "Исправление **экспорта** [буквально] <tag> &amp; #"
  const opencode = { getSession: async () => { sessionReads++; return { title: sessionTitle } }, messagePage: async () => ({ messages }) }
  const config = { telegram: { botApi: { spoolDir: root } } }
  const result = await sendSessionExport({ config, binding, telegram, opencode, language: "en" })
  assert.equal(result.prompts, 2)
  assert.equal(result.finals, 1)
  assert.equal(received.url, "/bottest/sendDocument")
  assert.equal(received.chat, "-1001")
  assert.equal(received.topic, "42")
  assert.equal(received.filename, "session-ses_export.md")
  assert.equal(sessionReads, 1)
  const heading = fromMarkdown(received.text).children[0]
  assert.equal(heading.type, "heading")
  assert.equal(heading.depth, 1)
  assert.ok(heading.children.every((node) => node.type === "text"))
  assert.equal(heading.children.map((node) => node.value).join(""), sessionTitle)
  assert.doesNotMatch(received.text, /Telegram topic name/)
  assert.ok(received.text.includes("  Literal\n\n<user>&"))
  assert.ok(received.text.includes("**Final**\n"))
  assert.doesNotMatch(received.text, /Appendix — progress notes|Earlier progress/)
  assert.equal(result.bytes, Buffer.byteLength(received.text, "utf8"))
  assert.deepEqual(await fs.readdir(root), [])
  const state = { chatId: binding.chatId, data: { runtime: { telegramUpdateOffset: 0 } },
    findBindingByTopic: () => binding, isArtifactsTopic: () => false, isSoundsTopic: () => false }
  const handlers = createTelegramCommandHandlers({ config, state, opencode, telegram,
    multipartPrompts: { flushKey: async () => assert.fail("export must leave buffered input alone") },
  })
  const inboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencodebot-export-polling-"))
  t.after(() => fs.rm(inboxRoot, { recursive: true, force: true }))
  let fetched = false, finished = false, releasePoll
  const handled = new Promise((resolve) => { releasePoll = resolve })
  messages.push(userMessage("u2", "Latest unfinished prompt"), {
    info: { id: "a2", role: "assistant", parentID: "u2", finish: "tool-calls" },
    parts: [{ type: "text", text: "Latest progress only" }],
  })
  telegram.getUpdates = async () => {
    if (fetched) { await handled; return [] }
    fetched = true
    return [{ update_id: 1, message: { message_id: 1, chat: { id: binding.chatId, type: "supergroup" },
      from: { id: 42 }, message_thread_id: binding.topicId, text: "/export@test_bot" } }]
  }
  const polling = createTelegramPolling({
    config: { ...config, paths: { statePath: path.join(inboxRoot, "state.json") }, mirror: { deletePinServiceMessages: false },
      telegram: { ...config.telegram, chatId: binding.chatId, allowedUserIds: [42] } }, state, telegram,
    commandHandlers: { ...handlers, async handle(...args) {
      try { return await handlers.handle(...args) }
      finally { finished = true; releasePoll() }
    } },
    handleTopicLifecycleMessage: async () => false, extractTelegramFiles: () => [], hasPendingAttachmentBatch: () => false,
    multipartPromptKey: () => "buffer-key", flushPromptKey: async () => assert.fail("export must not flush input"),
    queueTelegramPrompt: async () => assert.fail("export must never become an agent prompt"), logError: assert.fail,
  })
  await polling.poll({ shouldStop: () => finished })
  assert.equal(received.topic, "42")
  assert.equal(fromMarkdown(received.text).children[0].children.map((node) => node.value).join(""), sessionTitle)
  assert.ok(received.text.includes("  Literal\n\n<user>&"))
  assert.match(received.text, /The latest prompt 3 has no final answer/)
  assert.match(received.text, /Prompt 3 — progress note 1/)
  assert.ok(received.text.indexOf("## Appendix — progress notes") > received.text.indexOf("Latest unfinished prompt"))
  assert.ok(received.text.includes("Latest progress only"))
  assert.doesNotMatch(received.text, /Earlier progress/)
  assert.deepEqual(await fs.readdir(root), [])
  await assert.rejects(sendSessionExport({ config, binding, opencode, language: "en",
    telegram: { sendDocument: async ({ file }) => {
      const [directory] = await fs.readdir(root)
      assert.equal((await fs.stat(path.join(root, directory))).mode & 0o777, 0o700)
      assert.equal((await fs.stat(path.join(root, directory, file.filename))).mode & 0o777, 0o600)
      throw new Error("delivery failed")
    } },
  }), /delivery failed/)
  assert.deepEqual(await fs.readdir(root), [])
  const oversized = userMessage("large", "x".repeat(50 * 1024 * 1024))
  await assert.rejects(sendSessionExport({ config, binding, language: "en",
    opencode: { getSession: async () => ({}), messagePage: async () => ({ messages: [oversized] }) },
    telegram: { sendDocument: async () => assert.fail("oversized exports must not send a partial file") },
  }), { code: "EXPORT_TOO_LARGE" })
  assert.deepEqual(await fs.readdir(root), [])
})

test("/export never flushes buffered prompts or mutates the session, including no-session errors", async () => {
  const replies = []
  const binding = { chatId: -1001, topicId: 42, serverID: "local", sessionID: "ses_export" }
  const handlers = createTelegramCommandHandlers({ config: {}, state: { findBindingByTopic: () => null },
    multipartPrompts: { flushKey: async () => assert.fail("export must not submit buffered prompts") },
    opencode: { promptAsync: async () => assert.fail("export must not submit a prompt") },
    telegram: { sendMessage: async (message) => replies.push(message) },
  })
  const message = { chat: { id: binding.chatId }, message_thread_id: binding.topicId }
  assert.equal(await handlers.handle(message, { name: "export", args: "" }, "buffer-key"), true)
  assert.equal(replies[0].topicId, binding.topicId)
  assert.match(replies[0].text, /no active OpenCodez session/)
  await handlers.handle(message, { name: "export", args: "3" }, "buffer-key")
  assert.match(replies[1].text, /without arguments/)
})

function createHarness({ cursor, pages, targetedMessage, usersOnly = true, watchdog = false, queue, sessionStatus } = {}) {
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
  const promptQueue = queue || {
    hasExpectedStop: () => false,
    markBusy: () => {},
    markTerminalMirrored: async () => {
      terminalMirrors += 1
    },
  }
  const opencode = {
    servers: [],
    messages: async () => messages,
    ...(sessionStatus ? { sessionStatus } : {}),
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
