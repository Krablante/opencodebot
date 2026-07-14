import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { artifactTargetPath, handleArtifactUploadMessage, resolveUploadTarget } from "../src/artifact-uploads.mjs"
import { AttachmentBuffer } from "../src/attachments.mjs"
import { createTelegramCommandHandlers, telegramBotCommands } from "../src/commands.mjs"
import { assertRuntimeConfig, loadConfig } from "../src/config.mjs"
import { finalNotificationMarkdown, toolSummaryBeforeAssistant } from "../src/final-notifications.mjs"
import { OPENCODE_REQUEST_TIMEOUT_MS, OpenCodeClient, visibleTextFromParts } from "../src/opencode.mjs"
import { PromptQueue } from "../src/prompt-queue.mjs"
import { MirrorRenderer, webPromptMessages } from "../src/render.mjs"
import { normalizeNestedRichLists } from "../src/rich-list-normalization.mjs"
import { bindingSessionReconcileRefresh, createSessionReconciler, shouldSkipAssistantForCatchup } from "../src/session-reconcile.mjs"
import { normalizeSpeechConfig } from "../src/config/speech.mjs"
import { SpeechModule, transcriptMessage } from "../src/speech/index.mjs"
import { GroqSpeechClient } from "../src/speech/groq-client.mjs"
import { OpenRouterSpeechClient, audioFormat } from "../src/speech/openrouter-client.mjs"
import { StateStore } from "../src/state.mjs"
import { TelegramClient } from "../src/telegram.mjs"
import { createTopicLifecycle } from "../src/topic-lifecycle.mjs"
import { OpencodebotArtifactsPlugin } from "../plugins/opencodebot-artifacts/src/index.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, "..")
const explicitConfigPath = process.argv[2]
const config = loadConfig(explicitConfigPath || path.join(projectRoot, "config.example.json"))

await smokeLocalInvariants()
await smokeRuntimeHealth(config, { explicit: Boolean(explicitConfigPath) })

async function smokeLocalInvariants() {
  smokeConfigExample()
  smokeSyntheticTextFilter()
  smokeNestedRichListNormalization()
  await smokeArtifactDropbox()
  await smokeArtifactPluginBatchCaptions()
  await smokeSpeechOpenRouterRequest()
  await smokeSpeechGroqRequest()
  await smokeSpeechTopicRouting()
  await smokeSpeechModelMenu()
  smokeSpeechTranscriptMessage()
  await smokeOpenCodeAbortClient()
  await smokeQueuedAttachmentPayload()
  await smokeQueuedMediaGroupAttachmentPayload()
  await smokeAttachmentTextChunksWaitForIdle()
  smokeExpiredBindingReconcileRefresh()
  smokeCatchupAssistantGate()
  await smokeActiveBindingLeavesUsersOnlyCatchup()
  await smokeTopicCreationSingleFlight()
  await smokeReconcileTopicRetry()
  await smokeReconcileSingleFlight()
  await smokeMirrorModeCommands()
  await smokeMirrorModeRendering()
  smokeFinalToolSummary()
  await smokeCoreFailureInvariants()
  await smokeChunkedWebPromptMirror()
  await smokeKillCommand()
  await smokeResetCommand()
  await smokeKillCommandAbortFailure()
  await smokeKillSuppressesAbortFallout()
  await smokeQueueDrainsOnSessionIdle()
  await smokeIncompleteRunNotice()
}

function smokeNestedRichListNormalization() {
  const simple = "1. one\n2. two\n"
  const fenced = "```md\n1. parent\n   - child\n```"
  assert.equal(normalizeNestedRichLists(simple), simple)
  assert.equal(normalizeNestedRichLists(fenced), fenced)

  const screenshotCase = [
    "## Nested list",
    "",
    "1. First top-level item.",
    "2. Item with **bold**, `code`, and [link](https://example.com).",
    "3. Third top-level item.",
    "4. Atomic transition:",
    "",
    "   - disable the old binding;",
    "   - create pending state.",
    "",
    "5. Preserve settings:",
    "",
    "   - server and directory;",
    "   - profile and title.",
    "",
    "6. Final top-level item.",
  ].join("\n")
  const normalized = normalizeNestedRichLists(screenshotCase)
  assert.match(normalized, /1⁠\. First top-level item\.  \n/)
  assert.match(normalized, /2⁠\. Item with \*\*bold\*\*, `code`, and \[link\]\(https:\/\/example\.com\)\.  \n/)
  assert.match(normalized, /4⁠\. Atomic transition:  \n • disable the old binding;  \n • create pending state\.  \n5⁠\. Preserve settings:/)
  assert.match(normalized, / • profile and title\.  \n6⁠\. Final top-level item\./)
  assert.doesNotMatch(normalized, /\n\s+5⁠\./)

  const deepMixed = [
    "7. outer",
    "   - nested unordered",
    "     1. deeply nested ordered",
    "   - nested sibling",
    "8. outer sibling",
  ].join("\n")
  assert.equal(
    normalizeNestedRichLists(deepMixed),
    ["7⁠. outer  ", " • nested unordered  ", "  1⁠. deeply nested ordered  ", " • nested sibling  ", "8⁠. outer sibling"].join("\n"),
  )

  const quoted = ["> 1. parent", ">    - child", "> 2. back"].join("\n")
  assert.equal(normalizeNestedRichLists(quoted), ["> 1⁠. parent  ", ">  • child  ", "> 2⁠. back"].join("\n"))

  const taskAndCode = [
    "1. [ ] task with code:",
    "",
    "   ```js",
    "   const value = 1",
    "   ```",
    "",
    "   - nested follow-up",
    "2. back to top",
  ].join("\n")
  const codeNormalized = normalizeNestedRichLists(taskAndCode)
  assert.match(codeNormalized, /1⁠\. \\\[ ] task with code:/)
  assert.match(codeNormalized, /```js\nconst value = 1\n```/)
  assert.match(codeNormalized, / • nested follow-up/)
  assert.match(codeNormalized, /2⁠\. back to top/)
}

async function smokeMirrorModeCommands() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-mode-smoke-"))
  const statePath = path.join(root, "state.json")
  const sent = []
  try {
    const state = new StateStore(statePath)
    await state.load()
    assert.equal(state.mirrorMode(), "full")
    const handlers = createTelegramCommandHandlers({
      config: { chatTemplates: {} },
      state,
      telegram: { async sendMessage(message) { sent.push(message) } },
      opencode: {},
      promptQueue: {},
      multipartPrompts: { async flushKey() {} },
      createPendingTopic: async () => {},
    })
    const message = { chat: { id: 123 }, message_thread_id: 456 }
    assert.equal(await handlers.handle(message, { name: "mode", args: "economy" }, "123:456"), true)
    assert.equal(state.mirrorMode(), "economy")
    assert.match(sent.at(-1).text, /Mode: <b>ECONOMY<\/b>/)
    const reloaded = new StateStore(statePath)
    await reloaded.load()
    assert.equal(reloaded.mirrorMode(), "economy")
    assert.equal(await handlers.handle(message, { name: "mode", args: "full" }, "123:456"), true)
    assert.equal(state.mirrorMode(), "full")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function smokeMirrorModeRendering() {
  let mode = "full"
  const sent = []
  const renderer = new MirrorRenderer({
    config: {
      mirror: { hiddenTools: ["todowrite"], toolBatchMaxLines: 50, toolBatchMaxChars: 3000, maxTelegramChars: 3900 },
      telegram: { pinUserPrompts: false },
    },
    state: { mirrorMode: () => mode },
    telegram: {
      async sendMessage(message) {
        sent.push(message)
        return { message_id: sent.length }
      },
      async editMessageText() {},
    },
  })
  const binding = { serverID: "nuc", sessionID: "ses_mode", chatId: "123", topicId: 456 }
  await renderer.toolCalled(binding, { callID: "read-full", tool: "read", input: { filePath: "/tmp/a" } })
  await renderer.toolResult(binding, { callID: "read-full", tool: "read", output: "ok", ok: true })
  assert.equal(sent.length, 1)
  await renderer.toolCalled(binding, { callID: "task-full", tool: "task", input: { subagent_type: "explore", prompt: "inspect" } })
  await renderer.toolResult(binding, { callID: "task-full", tool: "task", output: "done", ok: true })
  assert.equal(sent.length, 2)
  assert.equal(sent.at(-1).text, "🤖 Subagent spawned: <code>explore</code>")
  await renderer.toolCalled(binding, { callID: "task-title-late", tool: "task", input: {} })
  assert.equal(sent.length, 2)
  await renderer.toolCalled(binding, { callID: "task-title-late", tool: "task", input: { subagent_type: "explore", description: "Deep harness exploration" } })
  await renderer.toolResult(binding, { callID: "task-title-late", tool: "task", output: "done", ok: true })
  assert.equal(sent.length, 3)
  assert.equal(sent.at(-1).text, "🤖 Subagent spawned: <code>Deep harness exploration</code>")
  await renderer.toolCalled(binding, { callID: "prompt-tool-full", tool: "image", input: { prompt: "draw" } })
  await renderer.toolResult(binding, { callID: "prompt-tool-full", tool: "image", output: "ok", ok: true })
  assert.equal(sent.length, 4)
  assert.doesNotMatch(sent.at(-1).text, /Subagent spawned/)
  mode = "economy"
  await renderer.toolCalled(binding, { callID: "read-economy", tool: "read", input: { filePath: "/tmp/b" } })
  await renderer.toolResult(binding, { callID: "read-economy", tool: "read", output: "ok", ok: true })
  assert.equal(sent.length, 4)
  await renderer.toolCalled(binding, { callID: "task-economy", tool: "task", input: { subagent_type: "general", prompt: "inspect" } })
  await renderer.toolResult(binding, { callID: "task-economy", tool: "task", output: "done", ok: true })
  assert.equal(sent.length, 5)
  assert.equal(sent.at(-1).text, "🤖 Subagent spawned: <code>general</code>")
  await renderer.compactTools(binding, ["📄 Read /tmp/c"])
  assert.equal(sent.length, 5)
}

function smokeFinalToolSummary() {
  const messages = [
    { info: { id: "old-user", role: "user" }, parts: [{ type: "text", text: "old" }] },
    { info: { id: "old-assistant", role: "assistant" }, parts: [{ id: "old-read", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "old.txt" } } }] },
    { info: { id: "user", role: "user" }, parts: [{ type: "text", text: "change files" }] },
    { info: { id: "assistant", role: "assistant" }, parts: [
      { id: "read-1", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "src/a.mjs" } } },
      { id: "read-2", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "src/b.mjs" } } },
      { id: "patch-1", type: "tool", tool: "apply_patch", state: { status: "completed", input: { patchText: "*** Begin Patch\n*** Update File: /home/bloob/repo/src/a.mjs\n*** Move to: /home/bloob/repo/src/moved.mjs\n*** Add File: /home/bloob/repo/src/new.mjs\n*** End Patch" } } },
      { id: "edit-1", type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "C:\\repo\\src\\edit.mjs" } } },
      { id: "write-1", type: "tool", tool: "write", state: { status: "error", input: { filePath: "src/failed.mjs" } } },
      { id: "task-1", type: "tool", tool: "task", state: { status: "completed", input: { subagent_type: "explore", prompt: "inspect" } } },
      { id: "todo-1", type: "tool", tool: "todowrite", state: { status: "completed", input: {} } },
    ] },
  ]
  const summary = toolSummaryBeforeAssistant(messages, "assistant", ["todowrite"])
  assert.deepEqual(summary.tools, [
    { name: "Read", count: 2, failed: 0 },
    { name: "Patch", count: 1, failed: 0 },
    { name: "Edit", count: 1, failed: 0 },
    { name: "Write", count: 1, failed: 1 },
  ])
  assert.deepEqual(summary.patchedFiles, ["/home/bloob/repo/src/a.mjs", "/home/bloob/repo/src/moved.mjs", "/home/bloob/repo/src/new.mjs", "C:\\repo\\src\\edit.mjs"])
  const notification = finalNotificationMarkdown({ topicSource: { title: "topic" }, serverID: "nuc", promptText: "change files", ...summary })
  assert.ok(notification.includes(">🔧 Tools: Read × 2; Patch × 1; Edit × 1; Write × 1 \\(1 failed\\)"))
  assert.ok(notification.includes(">🩹 Patched: a\\.mjs; moved\\.mjs; new\\.mjs; edit\\.mjs||"))
  assert.doesNotMatch(notification, /\/home\/bloob|C:\\repo|old\.txt|failed\.mjs|Explore|Todo/)
}

async function smokeCoreFailureInvariants() {
  await smokeOpenCodeEventOrdering()
  await smokeOpenCodeRequestTimeout()
  await smokeOpenCodeSessionModelSwitch()
  await smokeStatePruning()
  await smokeStateWriteRecovery()
  await smokeStrictConfigLoading()
  await smokeTelegramDownloadLimit()
}

async function smokeOpenCodeEventOrdering() {
  const events = []
  const server = createServer((request, response) => {
    if (request.url !== "/event") {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: {\"type\":\"first\",\"properties\":{}}\n\n")
    response.write("data: {\"type\":\"second\",\"properties\":{}}\n\n")
    response.end()
  })
  const { url, close } = await listen(server)
  const controller = new AbortController()
  try {
    const client = new OpenCodeClient({ opencode: { password: "", mirrorScope: "global", servers: [{ id: "local", url }] } })
    await client.subscribeEvents("local", async (_server, event) => {
      events.push(`start:${event.type}`)
      if (event.type === "first") await wait(25)
      events.push(`end:${event.type}`)
      if (event.type === "second") controller.abort()
    }, controller.signal)
    assert.deepEqual(events, ["start:first", "end:first", "start:second", "end:second"])
  } finally {
    controller.abort()
    await close()
  }
}

async function smokeOpenCodeRequestTimeout() {
  assert.equal(OPENCODE_REQUEST_TIMEOUT_MS, 120_000)
  const server = createServer((_request, _response) => {})
  const { url, close } = await listen(server)
  try {
    const client = new OpenCodeClient({ opencode: { password: "", mirrorScope: "global", servers: [{ id: "local", url }] } })
    await assert.rejects(() => client.listSessions("local", { timeoutMs: 20 }), /timed out after/)
  } finally {
    await close()
  }
}

async function smokeOpenCodeSessionModelSwitch() {
  let captured = null
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    captured = { method: request.method, url: request.url, body: JSON.parse(body) }
    response.writeHead(204).end()
  })
  const { url, close } = await listen(server)
  try {
    const client = new OpenCodeClient({ opencode: { password: "", mirrorScope: "global", servers: [{ id: "local", url }] } })
    await client.switchSessionModel("local", "ses_model", {
      providerID: "openai",
      modelID: "gpt-5.6-sol-fast",
      variant: "max",
    }, { directory: "/tmp/work" })
    assert.equal(captured.method, "POST")
    assert.equal(captured.url, "/api/session/ses_model/model?directory=%2Ftmp%2Fwork")
    assert.deepEqual(captured.body, {
      model: { providerID: "openai", id: "gpt-5.6-sol-fast", variant: "max" },
    })
  } finally {
    await close()
  }
}

async function smokeStatePruning() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-state-prune-smoke-"))
  const statePath = path.join(root, "state.json")
  try {
    const oversizedMessages = Array.from({ length: 300 }, (_, index) => `msg-${index}`)
    const oversizedBuckets = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`nuc:ses-${index}`, [String(index)]]))
    oversizedBuckets["nuc:big"] = oversizedMessages
    await writeFile(statePath, JSON.stringify({ version: 1, telegram: {}, mirroredAssistantBySession: oversizedBuckets, mirroredUserBySession: oversizedBuckets }))
    const state = new StateStore(statePath)
    await state.load()
    assert.ok(Object.keys(state.data.mirroredAssistantBySession).length <= 250)
    assert.equal(state.data.mirroredAssistantBySession["nuc:big"].length, 300)
    assert.equal(state.data.mirroredUserBySession["nuc:big"].length, 300)
    assert.equal(oversizedMessages.every((messageID) => state.isAssistantMirrored("nuc", "big", messageID)), true)
    await state.markAssistantMirrored("nuc", "big", "msg-300")
    assert.equal(state.data.mirroredAssistantBySession["nuc:big"].length, 301)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function smokeStateWriteRecovery() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-state-recovery-smoke-"))
  const blockedParent = path.join(root, "blocked")
  const statePath = path.join(blockedParent, "state.json")
  try {
    await writeFile(blockedParent, "not a directory")
    const state = new StateStore(statePath)
    await assert.rejects(() => state.setMirrorMode("full"))

    await rm(blockedParent)
    await mkdir(blockedParent)
    await state.setMirrorMode("economy")

    const reloaded = new StateStore(statePath)
    await reloaded.load()
    assert.equal(reloaded.data.telegram.mirrorMode, "economy")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function smokeStrictConfigLoading() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-config-smoke-"))
  const configPath = path.join(root, "config.json")
  const missingPath = path.join(root, "missing.json")
  const oldToken = process.env.OPENCODEBOT_SMOKE_TOKEN
  const oldAllowed = process.env.OPENCODEBOT_SMOKE_ALLOWED
  const oldNoiseToken = process.env.TOKEN
  try {
    assert.throws(() => loadConfig(missingPath), /Config file not found/)
    process.env.OPENCODEBOT_SMOKE_TOKEN = "123456:abcdefghijklmnopqrstuvwxyz"
    process.env.OPENCODEBOT_SMOKE_ALLOWED = "42,43"
    process.env.TOKEN = "999999:wrongwrongwrongwrongwrongwrong"
    await writeFile(path.join(root, "servers.example.json"), JSON.stringify([{ id: "nuc", url: "http://127.0.0.1:40999" }]))
    await writeFile(configPath, JSON.stringify({
      telegram: { token: { env: "OPENCODEBOT_SMOKE_TOKEN" }, allowedUserIds: { env: "OPENCODEBOT_SMOKE_ALLOWED" } },
      artifacts: { enabled: false },
    }))
    const strict = loadConfig(configPath)
    assert.equal(strict.telegram.token, process.env.OPENCODEBOT_SMOKE_TOKEN)
    assert.deepEqual(strict.telegram.allowedUserIds, [42, 43])
    assert.equal(strict.opencode.servers[0].transfer.type, "local")

    await writeFile(path.join(root, "servers.example.json"), JSON.stringify([
      { id: "nuc", url: "http://127.0.0.1:40999" },
      { id: "nuc", url: "ftp://invalid", pathStyle: "plan9", offline_ok: "false", transfer: { type: "shh" } },
      { id: "ssh", url: "https://example.test", transfer: { type: "ssh", user: "", port: 70000 } },
      null,
      { id: "", url: "" },
    ]))
    assert.throws(() => loadConfig(configPath), (error) => {
      assert.match(error.message, /Invalid servers config:/)
      assert.match(error.message, /servers\[1\]\.id duplicates servers\[0\]\.id \("nuc"\)/)
      assert.match(error.message, /servers\[1\]\.url must be an absolute HTTP\(S\) URL/)
      assert.match(error.message, /servers\[1\]\.transfer\.type must be "local" or "ssh"/)
      assert.match(error.message, /servers\[1\]\.pathStyle must be "posix" or "windows"/)
      assert.match(error.message, /servers\[1\]\.offline_ok must be a boolean/)
      assert.match(error.message, /servers\[2\]\.transfer\.host is required for SSH transfer/)
      assert.match(error.message, /servers\[2\]\.transfer\.port must be an integer from 1 to 65535/)
      assert.match(error.message, /servers\[3\] must be an object/)
      assert.match(error.message, /servers\[4\]\.id must be a non-empty string/)
      return true
    })
  } finally {
    restoreEnv("OPENCODEBOT_SMOKE_TOKEN", oldToken)
    restoreEnv("OPENCODEBOT_SMOKE_ALLOWED", oldAllowed)
    restoreEnv("TOKEN", oldNoiseToken)
    await rm(root, { recursive: true, force: true })
  }
}

async function smokeTelegramDownloadLimit() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-download-smoke-"))
  const destination = path.join(root, "too-big.bin")
  const server = createServer((request, response) => {
    if (request.url.includes("/getFile")) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: true, result: { file_path: "files/too-big.bin" } }))
      return
    }
    response.writeHead(200, { "content-type": "application/octet-stream" })
    response.end(Buffer.alloc(16))
  })
  const { url, close } = await listen(server)
  try {
    const telegram = new TelegramClient("123:test", { rootUrl: url, fileRootUrl: url })
    await assert.rejects(() => telegram.downloadFile({ fileId: "file", destination, maxBytes: 8 }), /exceeded limit/)
  } finally {
    await close()
    await rm(root, { recursive: true, force: true })
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((closeResolve, closeReject) => server.close((error) => (error ? closeReject(error) : closeResolve()))),
      })
    })
  })
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function smokeConfigExample() {
  const example = loadConfig(path.join(projectRoot, "config.example.json"))
  assert.equal(example.artifactUploads.enabled, true)
  assert.equal(example.artifactUploads.root, "~/trash")
  assert.equal(example.attachments.maxFileBytes, 20000000)
  assert.equal(example.attachments.maxTotalBytes, 60000000)
  assert.equal(example.speech.enabled, false)
  assert.equal(example.speech.defaultModel, "openai/whisper-large-v3-turbo")
  assert.equal(example.speech.models.length, 3)
  assert.equal(example.speech.models[1].apiProvider, "groq")
  assert.equal(example.speech.models[1].apiModel, "whisper-large-v3")
  assert.ok(example.opencode.servers.length > 0)
}

async function smokeSpeechOpenRouterRequest() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-speech-smoke-"))
  const audioPath = path.join(root, "voice.oga")
  await writeFile(audioPath, "fake audio bytes")
  const requests = []
  const normalized = normalizeSpeechConfig({
    enabled: true,
    language: "ru",
    prompt: "short prompt",
    openrouter: { apiKeyEnv: "OPENROUTER_API_KEY" },
    groq: { apiKeyEnv: "GROQ_API_KEY" },
    models: [
      { id: "openai/whisper-large-v3-turbo", apiProvider: "openrouter", label: "Whisper V3 Turbo", upstreamProvider: "Groq" },
      { id: "groq/whisper-large-v3", apiProvider: "groq", apiModel: "whisper-large-v3", label: "Whisper V3" },
    ],
  }, { OPENROUTER_API_KEY: "test-key", GROQ_API_KEY: "groq-key" })
  assert.equal(normalized.providers.openrouter.apiKey, "test-key")
  assert.equal(normalized.providers.groq.apiKey, "groq-key")
  assert.equal(normalized.models[0].language, "ru")
  assert.equal(normalized.models[0].provider, "OpenRouter")
  assert.equal(normalized.models[0].upstreamProvider, "Groq")
  assert.equal(normalized.models[1].provider, "Groq")
  assert.equal(normalizeSpeechConfig({ enabled: true, language: "EN" }).models[0].language, "en")
  assert.equal(normalizeSpeechConfig({ enabled: true, language: null }).models[0].language, null)
  assert.equal(normalizeSpeechConfig({ enabled: true, language: "auto" }).models[0].language, null)
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options, body: JSON.parse(options.body) })
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ text: "готовый transcript" })
      },
    }
  }
  try {
    const client = new OpenRouterSpeechClient(normalized.providers.openrouter, {}, fetchImpl)
    const result = await client.transcribeFile({ localPath: audioPath, filename: "voice.oga", mime: "audio/ogg" }, normalized.models[0])
    assert.equal(result.text, "готовый transcript")
    assert.equal(audioFormat({ filename: "voice.oga" }), "ogg")
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, "https://openrouter.ai/api/v1/audio/transcriptions")
    assert.equal(requests[0].options.method, "POST")
    assert.match(requests[0].options.headers.Authorization, /^Bearer /)
    assert.equal(requests[0].body.model, "openai/whisper-large-v3-turbo")
    assert.equal(requests[0].body.input_audio.format, "ogg")
    assert.equal(requests[0].body.language, "ru")
    assert.equal(requests[0].body.temperature, 0)
    assert.equal(requests[0].body.provider.options.groq.prompt, "short prompt")
    const autoBody = client.requestBody(Buffer.from("audio"), "ogg", { ...normalized.models[0], language: null })
    assert.equal(Object.hasOwn(autoBody, "language"), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function smokeSpeechGroqRequest() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-groq-smoke-"))
  const audioPath = path.join(root, "voice.oga")
  await writeFile(audioPath, "fake audio bytes")
  const normalized = normalizeSpeechConfig({
    enabled: true,
    language: "auto",
    prompt: "Проверка терминов.",
    groq: { apiKeyEnv: "GROQ_API_KEY" },
    models: [{ id: "groq/whisper-large-v3", apiProvider: "groq", apiModel: "whisper-large-v3", label: "Whisper V3" }],
  }, { GROQ_API_KEY: "groq-key" })
  let request = null
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options }
    return new Response(JSON.stringify({ text: "Прямой ответ Groq." }), { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    const client = new GroqSpeechClient(normalized.providers.groq, {}, fetchImpl)
    const result = await client.transcribeFile({ localPath: audioPath, filename: "voice.oga", mime: "audio/ogg" }, normalized.models[0])
    assert.equal(request.url, "https://api.groq.com/openai/v1/audio/transcriptions")
    assert.equal(request.options.headers.Authorization, "Bearer groq-key")
    assert.equal(request.options.body.get("model"), "whisper-large-v3")
    assert.equal(request.options.body.get("language"), null)
    assert.equal(request.options.body.get("prompt"), "Проверка терминов.")
    assert.equal(request.options.body.get("response_format"), "json")
    assert.equal(request.options.body.get("file").name, "voice.ogg")
    assert.equal(result.text, "Прямой ответ Groq.")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function smokeSpeechTopicRouting() {
  const jobs = []
  const speech = new SpeechModule({
    config: normalizeSpeechConfig({
      enabled: true,
      maxFileBytes: 25_000_000,
      queueConcurrency: 1,
      statusMessage: "Transcribing voice...",
      openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", timeoutMs: 5000 },
    }, { OPENROUTER_API_KEY: "test-key" }),
    telegram: {},
    state: {
      isSoundsTopic: (chatId, topicID) => String(chatId) === "100" && Number(topicID || 0) === 7,
      soundsTopic: () => ({ chatId: 100, topicId: 7 }),
    },
    uploadDir: "/tmp",
    attachmentSettings: {},
  })
  speech.drain = () => jobs.push(speech.queue.shift())
  assert.equal(await speech.handleMessage({ chat: { id: 100 }, message_thread_id: 7, text: "hello" }), false)
  assert.equal(await speech.handleMessage({ chat: { id: 100 }, message_thread_id: 7, photo: [{ file_id: "p1" }] }), false)
  assert.equal(await speech.handleMessage({ chat: { id: 100 }, message_thread_id: 7, voice: { file_id: "v1", file_unique_id: "uv1" } }), true)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].descriptors[0].kind, "voice")
  const regularTopicVoice = { chat: { id: 100 }, message_id: 44, message_thread_id: 8, voice: { file_id: "v2", file_unique_id: "uv2" } }
  assert.equal(await speech.handleMessage(regularTopicVoice), false)
  assert.equal(await speech.handleVoiceMessage(regularTopicVoice), true)
  assert.equal(jobs.length, 2)
  assert.equal(jobs[1].message.message_thread_id, 8)
  assert.equal(await speech.handleVoiceMessage({ ...regularTopicVoice, voice: undefined, audio: regularTopicVoice.voice }), false)
  assert.equal(speech.status().language, "ru")
  speech.config.models[0].language = null
  assert.equal(speech.status().language, "auto")
}

async function smokeSpeechModelMenu() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-speech-menu-smoke-"))
  const state = new StateStore(path.join(root, "state.json"))
  const sent = []
  const edited = []
  const pinned = []
  const answered = []
  let rejectNextEditAsUnchanged = false
  try {
    await state.load()
    await state.setSoundsTopic({ chatId: 100, topicId: 7, title: "AUDIO", setBy: 42 })
    const speech = new SpeechModule({
      config: normalizeSpeechConfig({
        enabled: true,
        openrouter: { apiKeyEnv: "OPENROUTER_API_KEY" },
        groq: { apiKeyEnv: "GROQ_API_KEY" },
        models: [
          { id: "openai/whisper-large-v3-turbo", apiProvider: "openrouter", label: "Whisper V3 Turbo", upstreamProvider: "Groq", price: "$0.04/hour" },
          { id: "groq/whisper-large-v3", apiProvider: "groq", apiModel: "whisper-large-v3", label: "Whisper V3", price: "Free tier" },
          { id: "groq/whisper-large-v3-turbo", apiProvider: "groq", apiModel: "whisper-large-v3-turbo", label: "Whisper V3 Turbo", price: "Free tier" },
        ],
      }, { OPENROUTER_API_KEY: "test-key", GROQ_API_KEY: "groq-key" }),
      telegram: {
        async sendMessage(message) { sent.push(message); return { message_id: sent.length + 10 } },
        async editMessageText(message) {
          if (rejectNextEditAsUnchanged) {
            rejectNextEditAsUnchanged = false
            throw new Error("Bad Request: message is not modified")
          }
          edited.push(message)
          return true
        },
        async pinChatMessage(message) { pinned.push(message); return true },
        async answerCallbackQuery(message) { answered.push(message); return true },
      },
      state,
      uploadDir: "/tmp",
      attachmentSettings: {},
    })
    await speech.createOrRefreshMenu()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].topicId, 7)
    assert.match(sent[0].text, /Whisper V3 Turbo/)
    assert.equal(sent[0].replyMarkup.inline_keyboard.length, 4)
    assert.deepEqual(pinned, [{ chatId: 100, messageId: 11, disableNotification: true }])
    assert.equal(state.soundsMenuMessageId(), 11)
    await speech.handleCallbackQuery({ id: "cb1", data: "sounds:model:groq%2Fwhisper-large-v3", message: { chat: { id: 100 }, message_thread_id: 7, message_id: 11 } })
    assert.equal(state.speechModelId(), "groq/whisper-large-v3")
    assert.match(edited.at(-1).text, /Whisper V3<\/code> · Groq/)
    assert.equal(edited.at(-1).replyMarkup.inline_keyboard[1][0].text.startsWith("✓ "), true)
    assert.match(answered.at(-1).text, /Whisper V3/)
    rejectNextEditAsUnchanged = true
    await speech.handleCallbackQuery({ id: "cb2", data: "sounds:refresh", message: { chat: { id: 100 }, message_thread_id: 7, message_id: 11 } })
    assert.match(answered.at(-1).text, /refreshed/)
    assert.equal(sent.length, 1)
    assert.equal(state.soundsMenuMessageId(), 11)
    const groqKey = speech.clients.groq.config.apiKey
    speech.clients.groq.config.apiKey = null
    assert.deepEqual(speech.models().map((model) => model.id), ["openai/whisper-large-v3-turbo"])
    speech.clients.groq.config.apiKey = groqKey
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function smokeSpeechTranscriptMessage() {
  const message = transcriptMessage("строка <admin> & /q", "model/test", 1234)
  assert.match(message, /^<code>[\s\S]+<\/code>\n\nmodel\/test · 1234ms$/)
  assert.equal(message.includes("<pre>"), false)
  const transcriptBlock = /^<code>([\s\S]+)<\/code>\n\n/.exec(message)?.[1]
  assert.equal(transcriptBlock, "строка &lt;admin&gt; &amp; /q")
  assert.equal(transcriptBlock.includes("model/test"), false)
  assert.ok(transcriptMessage("<".repeat(5000), "model/test", 1).length <= 4096)
}

function smokeSyntheticTextFilter() {
  const text = visibleTextFromParts([
    { type: "text", text: "Caption from Telegram." },
    { type: "text", text: "Synthetic file body must not mirror.", synthetic: true },
  ])
  assert.equal(text, "Caption from Telegram.")
}

async function smokeArtifactDropbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-dropbox-smoke-"))
  try {
    const posixServer = { id: "local", home: root, pathStyle: "posix", transfer: { type: "local" } }
    const windowsServer = { id: "winbox", home: "C:\\Users\\winbox", pathStyle: "windows", transfer: { type: "ssh", host: "winbox" } }
    const servers = new Map([[posixServer.id, posixServer], [windowsServer.id, windowsServer]])
    const opencode = {
      config: { opencode: { defaultServerId: "local" } },
      servers,
      server(id) {
        const server = servers.get(id)
        if (!server) throw new Error(`Unknown server: ${id}`)
        return server
      },
    }
    const artifactUploads = { enabled: true, root: "~/trash", defaultServerId: "local", dateFolders: true }
    const dropboxConfig = {
      paths: { uploadsDir: path.join(root, "uploads") },
      attachments: { enabled: true, maxFiles: 10, maxFileBytes: 20000000, maxTotalBytes: 60000000, maxInlineBytes: 20000000 },
      artifactUploads,
    }

    assert.equal(resolveUploadTarget({ caption: "", uploadConfig: artifactUploads, opencode }).server.id, "local")
    assert.equal(resolveUploadTarget({ caption: "winbox", uploadConfig: artifactUploads, opencode }).server.id, "winbox")
    assert.equal(resolveUploadTarget({ caption: "missing", uploadConfig: artifactUploads, opencode }).error, "unknown_server")

    const day = new Date(2026, 6, 2)
    assert.equal(
      artifactTargetPath({ config: dropboxConfig, server: posixServer, filename: "notes.txt", now: day }),
      path.join(root, "trash", "2026-07-02", "notes.txt"),
    )
    assert.equal(
      artifactTargetPath({ config: dropboxConfig, server: windowsServer, filename: "notes.txt", now: day }),
      "C:\\Users\\winbox\\trash\\2026-07-02\\notes.txt",
    )

    let downloadCalls = 0
    const sent = []
    const telegram = {
      async sendMessage(payload) {
        sent.push(payload)
      },
      async downloadFile() {
        downloadCalls += 1
        throw new Error("download should not run for unknown host")
      },
    }
    const unknown = await handleArtifactUploadMessage({
      telegram,
      config: dropboxConfig,
      opencode,
      message: { chat: { id: 1 }, message_thread_id: 2, caption: "missing" },
      files: [{ kind: "document", fileID: "file-1", filename: "skip.txt", size: 5 }],
    })
    assert.equal(unknown.status, "unknown_server")
    assert.equal(downloadCalls, 0)
    assert.match(sent.at(-1).text, /Unknown artifact upload server/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function smokeArtifactPluginBatchCaptions() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-plugin-smoke-"))
  const originalFetch = globalThis.fetch
  try {
    const first = path.join(root, "first.txt")
    const second = path.join(root, "second.txt")
    await writeFile(first, "first\n")
    await writeFile(second, "second\n")
    const metadata = []
    globalThis.fetch = async (url, options = {}) => {
      assert.match(String(url), /\/artifacts\/send-file$/)
      const encoded = options.headers?.["x-opencodebot-artifact-meta"]
      metadata.push(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")))
      for await (const _chunk of options.body) {}
      return { ok: true, status: 200, async json() { return { ok: true, messages: [{ method: "sendDocument", messageId: metadata.length }] } } }
    }
    const plugin = await OpencodebotArtifactsPlugin({}, { gatewayUrl: "http://opencodebot.local:8788", token: "test-token" })
    await plugin.tool.opencodebot_send_artifact.execute({ paths: [first, second], caption: "local/test/upload", mode: "document" }, { directory: root })
    assert.deepEqual(metadata.map((item) => item.captionPaths), [[first], [second]])
    assert.deepEqual(metadata.map((item) => item.file.filename), ["first.txt", "second.txt"])
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
}

async function smokeKillCommand() {
  assert.ok(telegramBotCommands.some((command) => command.command === "kill"))

  const binding = { serverID: "nuc", sessionID: "ses_kill", directory: "/home/bloob/politia/projects/tg/opencodebot" }
  const sent = []
  const aborted = []
  const discarded = []
  const promptQueue = new PromptQueue({
    onPrompt: async () => {},
    onQueued: async () => {},
    onQueueCleared: async () => {},
  })
  promptQueue.markBusy(binding)
  await promptQueue.enqueue(binding, "queued prompt")
  const handlers = createTelegramCommandHandlers({
    config: { chatTemplates: {} },
    state: {
      findBindingByTopic(chatId, threadId) {
        assert.equal(chatId, 123)
        assert.equal(threadId, 456)
        return binding
      },
    },
    telegram: {
      async sendMessage(message) {
        sent.push(message)
      },
    },
    opencode: {
      async abortSession(serverID, sessionID, options) {
        aborted.push({ serverID, sessionID, options })
      },
    },
    promptQueue,
    multipartPrompts: {
      discardKey(promptKey) {
        discarded.push(promptKey)
      },
    },
    createPendingTopic: async () => {},
  })

  const handled = await handlers.handle({ chat: { id: 123 }, message_thread_id: 456, message_id: 789 }, { name: "kill", args: "" }, "123:456")
  assert.equal(handled, true)
  assert.deepEqual(discarded, ["123:456"])
  assert.deepEqual(aborted, [{ serverID: "nuc", sessionID: "ses_kill", options: { directory: binding.directory } }])
  assert.equal(promptQueue.status(binding).length, 0)
  assert.equal(promptQueue.isBusy(binding), false)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, 123)
  assert.equal(sent[0].topicId, 456)
  assert.match(sent[0].text, /Stop signal sent/)
  assert.match(sent[0].text, /Cleared 1 queued prompt/)
}

async function smokeResetCommand() {
  assert.ok(telegramBotCommands.some((command) => command.command === "reset"))

  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-reset-smoke-"))
  const statePath = path.join(root, "state.json")
  const binding = {
    chatId: 123,
    topicId: 456,
    topicTitle: "Reusable topic",
    topicIconEmoji: "🧭",
    serverID: "nuc",
    sessionID: "ses_reset_old",
    directory: "/tmp/work",
    title: "Old session",
    titleSource: "opencode",
    chatTemplateName: "gpt",
    chatTemplate: { model: "openai/test" },
  }
  const sent = []
  const steps = []
  const preservedTopicTitle = "Current visible topic"
  const chatTemplates = {
    gpt: binding.chatTemplate,
    sol: { agent: "build", model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "xhigh" } },
    terra: { agent: "build", model: { providerID: "openai", modelID: "gpt-5.6-terra", variant: "xhigh" } },
  }
  const promptQueue = new PromptQueue({
    onPrompt: async () => {},
    onQueued: async () => {},
    onQueueCleared: async () => {},
  })
  try {
    const state = new StateStore(statePath)
    await state.load()
    await state.bindTopic(binding)
    await state.updateBindingTitle(binding.serverID, binding.sessionID, preservedTopicTitle)
    assert.equal(state.findBinding(binding.serverID, binding.sessionID).topicTitle, preservedTopicTitle)
    promptQueue.markBusy(binding)
    await promptQueue.enqueue(binding, "queued prompt")
    const handlers = createTelegramCommandHandlers({
      config: { chatTemplates, opencode: { servers: [{ id: "nuc", url: "http://127.0.0.1:4098" }] } },
      state,
      telegram: { async sendMessage(message) { sent.push(message) } },
      opencode: { async abortSession() { steps.push("abort") } },
      promptQueue,
      multipartPrompts: {
        async flushKey() {},
        discardKey() {
          steps.push("multipart")
          return true
        },
      },
      discardAttachmentBatch: async () => {
        steps.push("attachments")
        return 2
      },
      detachBinding: () => steps.push("detach"),
      createPendingTopic: async () => {},
    })

    await handlers.handle(
      { chat: { id: 123 }, message_thread_id: 456, message_id: 788 },
      { name: "reset", args: "unknown" },
      "123:456",
    )
    assert.deepEqual(steps, [])
    assert.equal(state.findBinding("nuc", "ses_reset_old").disabled, undefined)
    assert.match(sent.at(-1).text, /Unknown profile unknown/)

    const handled = await handlers.handle(
      { chat: { id: 123 }, message_thread_id: 456, message_id: 789 },
      { name: "reset", args: "sol" },
      "123:456",
    )
    assert.equal(handled, true)
    assert.deepEqual(steps, ["abort", "multipart", "attachments", "detach"])
    assert.equal(state.findBinding("nuc", "ses_reset_old"), undefined)
    assert.equal(state.findAnyBindingByTopic(123, 456).disabledReason, "topic-reset")
    assert.equal(state.pendingTopic(456).directory, binding.directory)
    assert.equal(state.pendingTopic(456).chatTemplateName, "sol")
    assert.deepEqual(state.pendingTopic(456).chatTemplate, chatTemplates.sol)
    assert.equal(state.pendingTopic(456).title, preservedTopicTitle)
    assert.equal(state.pendingTopic(456).titleSource, "user")
    assert.equal(promptQueue.status(binding).length, 0)
    assert.match(sent.at(-1).text, /Fresh session ready/)
    assert.match(sent.at(-1).text, /preserved in OpenCodez/)
    assert.match(sent.at(-1).text, /New session profile: <code>sol<\/code>/)
    assert.match(sent.at(-1).text, /topic name will be preserved/)

    await handlers.handle(
      { chat: { id: 123 }, message_thread_id: 456, message_id: 789 },
      { name: "session", args: "" },
      "123:456",
    )
    assert.match(sent.at(-1).text, /profile: <code>sol<\/code>/)

    steps.length = 0
    await handlers.handle(
      { chat: { id: 123 }, message_thread_id: 456, message_id: 790 },
      { name: "reset", args: "terra" },
      "123:456",
    )
    assert.deepEqual(steps, ["multipart", "attachments"])
    assert.match(sent.at(-1).text, /already waiting for its first prompt/)
    assert.match(sent.at(-1).text, /New session profile: <code>terra<\/code>/)
    assert.equal(state.pendingTopic(456).chatTemplateName, "terra")
    assert.deepEqual(state.pendingTopic(456).chatTemplate, chatTemplates.terra)

    const reloaded = new StateStore(statePath)
    await reloaded.load()
    assert.equal(reloaded.pendingTopic(456).topicTitle, preservedTopicTitle)
    assert.equal(reloaded.pendingTopic(456).titleSource, "user")
    assert.equal(reloaded.findAnyBindingByTopic(123, 456).disabled, true)
    reloaded.data.pendingTopics["456"].titleSource = "opencode"
    await reloaded.save()
    const migratedPending = new StateStore(statePath)
    await migratedPending.load()
    assert.equal(migratedPending.pendingTopic(456).titleSource, "user")

    const pending = migratedPending.pendingTopic(456)
    await migratedPending.bindTopic({ ...pending, chatId: 123, topicId: 456, sessionID: "ses_reset_new", title: "Generated session title" })
    assert.equal(migratedPending.findBindingByTopic(123, 456).titleSource, "user")
    assert.equal(migratedPending.findBindingByTopic(123, 456).topicTitle, preservedTopicTitle)
    migratedPending.findBindingByTopic(123, 456).titleSource = "opencode"
    await migratedPending.save()
    const migratedActive = new StateStore(statePath)
    await migratedActive.load()
    assert.equal(migratedActive.findBindingByTopic(123, 456).titleSource, "user")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function smokeQueuedAttachmentPayload() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-queued-attachment-"))
  const localPath = path.join(root, "queued.txt")
  await writeFile(localPath, "queued file")
  const binding = { serverID: "nuc", sessionID: "ses_queue", directory: root }
  const sent = []
  const dropped = []
  const queue = new PromptQueue(async (actualBinding, text, files, metadata) => {
    sent.push({ actualBinding, text, files, metadata })
  }, { onDrop: async (files) => dropped.push(...files.map((file) => file.filename)) })
  try {
    queue.markBusy(binding)
    await queue.enqueue(binding, "queued with attachment", [{ filename: "queued.txt", localPath }], { sourceMessageId: 123 })
    assert.equal(queue.status(binding)[0].fileCount, 1)
    assert.match(queue.status(binding)[0].summary, /\(\+1 file\)$/)
    const removed = queue.delete(binding, 1)
    assert.equal(removed.fileCount, 1)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(dropped, ["queued.txt"])

    await queue.enqueue(binding, "queued again", [{ filename: "queued.txt", localPath }], { sourceMessageId: 456 })
    assert.equal((await queue.markBackendIdle(binding)).status, "waiting")
    const flushed = await queue.markTerminalMirrored(binding)
    assert.equal(flushed.status, "sent")
    assert.equal(sent.length, 1)
    assert.equal(sent[0].text, "queued again")
    assert.equal(sent[0].files.length, 1)
    assert.equal(sent[0].metadata.sourceMessageId, 456)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function smokeQueuedMediaGroupAttachmentPayload() {
  const flushed = []
  const buffer = new AttachmentBuffer({
    settings: { mediaGroupIdleMs: 100, promptIdleMs: 1000 },
    uploadDir: "/tmp",
    flushPrompt: async () => { throw new Error("default flush should not run") },
    onExpire: async () => { throw new Error("media group should flush before prompt expiry") },
    onError: (error) => { throw error },
  })
  const context = { message: { chat: { id: 1 }, message_thread_id: 2, message_id: 10 }, binding: { serverID: "nuc", sessionID: "ses" } }
  await buffer.addFiles("1:2:3", context, [{ filename: "one.png" }], {
    text: "compare both screenshots",
    mediaGroupID: "album-1",
    flushPrompt: async (actualContext, text, files) => flushed.push({ actualContext, text, files }),
  })
  await buffer.addFiles("1:2:3", context, [{ filename: "two.png" }], { mediaGroupID: "album-1" })
  await new Promise((resolve) => setTimeout(resolve, 160))
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].text, "compare both screenshots")
  assert.deepEqual(flushed[0].files.map((file) => file.filename), ["one.png", "two.png"])
}

async function smokeAttachmentTextChunksWaitForIdle() {
  const flushed = []
  const expired = []
  const buffer = new AttachmentBuffer({
    settings: { mediaGroupIdleMs: 100, promptIdleMs: 1000 },
    uploadDir: "/tmp",
    flushPrompt: async (actualContext, text, files) => flushed.push({ actualContext, text, files }),
    onExpire: async (actualContext, files) => expired.push({ actualContext, files }),
    onError: (error) => { throw error },
  })
  const context = { message: { chat: { id: 1 }, message_thread_id: 2, message_id: 10 }, binding: { serverID: "nuc", sessionID: "ses" } }
  await buffer.addFiles("1:2:3", context, [{ filename: "screenshot.png" }])
  assert.equal(await buffer.addText("1:2:3", context, "first large prompt chunk"), true)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(flushed.length, 0)
  assert.equal(await buffer.addText("1:2:3", context, "second large prompt chunk"), true)
  await new Promise((resolve) => setTimeout(resolve, 130))
  assert.equal(expired.length, 0)
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].text, "first large prompt chunk\n\nsecond large prompt chunk")
  assert.deepEqual(flushed[0].files.map((file) => file.filename), ["screenshot.png"])
}

function smokeExpiredBindingReconcileRefresh() {
  const binding = {
    serverID: "dima",
    sessionID: "ses_expired",
    reconcileUntil: "2026-07-09T16:40:20.000Z",
  }
  const nowMs = Date.parse("2026-07-09T17:00:00.000Z")
  assert.equal(bindingSessionReconcileRefresh(binding, { time: { updated: Date.parse("2026-07-09T16:40:19.999Z") } }, nowMs, 2 * 60 * 60 * 1000), null)
  assert.equal(bindingSessionReconcileRefresh(binding, { time: { updated: Date.parse("2026-07-08T16:40:47.000Z") } }, nowMs, 2 * 60 * 60 * 1000), null)
  assert.deepEqual(bindingSessionReconcileRefresh(binding, { time: { updated: Date.parse("2026-07-09T16:40:47.000Z") } }, nowMs, 2 * 60 * 60 * 1000), {
    updatedMs: Date.parse("2026-07-09T16:40:47.000Z"),
    untilMs: Date.parse("2026-07-09T16:40:20.000Z"),
  })
}

function smokeCatchupAssistantGate() {
  assert.equal(shouldSkipAssistantForCatchup(false, false), false)
  assert.equal(shouldSkipAssistantForCatchup(true, false), true)
  assert.equal(shouldSkipAssistantForCatchup(true, true), false)
}

async function smokeActiveBindingLeavesUsersOnlyCatchup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-active-binding-"))
  try {
    const state = new StateStore(path.join(root, "state.json"))
    await state.load()
    await state.bindTopic({ chatId: 1, topicId: 2, serverID: "dima", sessionID: "ses_active", directory: "/tmp" })
    await state.extendBindingActivity("dima", "ses_active", {
      reconcileUntil: Date.now() + 60_000,
      reconcileUsersOnlyUntil: Date.now() + 60_000,
      reason: "startup-catchup",
    })
    assert.ok(state.findBinding("dima", "ses_active").reconcileUsersOnlyUntil)
    await state.activateBinding("dima", "ses_active", {
      reconcileAfter: Date.now() - 1000,
      reconcileUntil: Date.now() + 60_000,
      reason: "telegram-prompt",
    })
    assert.equal(state.findBinding("dima", "ses_active").reconcileUsersOnlyUntil, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function smokeTopicCreationSingleFlight() {
  const bindings = new Map()
  const operations = []
  let createCalls = 0
  let releaseTopic
  const topicGate = new Promise((resolve) => {
    releaseTopic = resolve
  })
  const lifecycle = createTopicLifecycle({
    config: { telegram: { chatId: -1001, randomTopicIcon: false } },
    state: {
      chatId: -1001,
      findBinding: (serverID, sessionID) => bindings.get(`${serverID}:${sessionID}`) || null,
      bindTopic: async (binding) => {
        operations.push("bind")
        bindings.set(`${binding.serverID}:${binding.sessionID}`, binding)
      },
      markSeenSession: async () => operations.push("seen"),
    },
    telegram: {
      createForumTopic: async () => {
        createCalls += 1
        if (createCalls === 1) throw new Error("temporary Telegram failure")
        await topicGate
        return { message_thread_id: 77 }
      },
    },
    opencode: { getSession: async () => assert.fail("concurrent web lookup should join the active topic creation") },
    activateBindingForPrompt: async () => operations.push("activate"),
    clearPromptFeedback: async () => {},
  })
  const session = { id: "ses_single_flight", title: "Single flight", directory: "/tmp/project" }

  await assert.rejects(lifecycle.createTopicForSession("nuc", session), /temporary Telegram failure/)
  assert.equal(bindings.size, 0)
  assert.deepEqual(operations, [])

  const fromReconcile = lifecycle.createTopicForSession("nuc", session)
  const fromEvent = lifecycle.createTopicForWebSession("nuc", session.id, "hello")
  releaseTopic()
  const [reconciledBinding, eventBinding] = await Promise.all([fromReconcile, fromEvent])

  assert.equal(createCalls, 2)
  assert.equal(reconciledBinding, eventBinding)
  assert.deepEqual(operations, ["bind", "seen", "activate"])
}

async function smokeReconcileTopicRetry() {
  const errors = []
  let listCalls = 0
  let seenCalls = 0
  let stopped = false
  const session = { id: "ses_topic_retry", title: "Retry topic", directory: "/tmp/project" }
  const reconciler = createSessionReconciler({
    config: {
      opencode: { servers: [{ id: "nuc" }] },
      reconcile: { enabled: true, intervalMs: 0, activeWindowMs: 60_000 },
      telegram: { chatId: -1001, autocreateTopics: true },
    },
    state: {
      chatId: -1001,
      data: { bindings: [] },
      seedSeenSessions: async () => 0,
      mirrorEnabled: () => true,
      findBinding: () => null,
      hasSeenSession: () => false,
      markSeenSession: async () => {
        seenCalls += 1
      },
    },
    telegram: {},
    opencode: {
      listSessions: async () => {
        listCalls += 1
        return listCalls === 1 ? [] : [session]
      },
    },
    renderer: {},
    promptQueue: {},
    questionManager: {},
    backendRequest: async (_serverID, _label, operation) => operation(),
    skippedBackendRequest: Symbol("skipped"),
    createTopicForSession: async () => {
      stopped = true
      throw new Error("temporary Telegram failure")
    },
    createTopicForWebSession: async () => null,
    isInternalSession: () => false,
    activateBindingForPrompt: async () => {},
    maybeExtendBindingActivity: async () => {},
    logError: (error) => errors.push(error),
    shouldStop: () => stopped,
  })

  await reconciler.reconcileLoop()
  assert.equal(seenCalls, 0)
  assert.equal(errors.length, 1)
}

async function smokeReconcileSingleFlight() {
  const now = Date.now()
  const binding = {
    serverID: "nuc",
    sessionID: "ses_reconcile_single_flight",
    directory: "/tmp/project",
    chatId: -1001,
    topicId: 88,
    reconcileAfter: new Date(now - 1000).toISOString(),
    reconcileUntil: new Date(now + 60_000).toISOString(),
  }
  let messageCalls = 0
  let releaseMessages
  let markStarted
  const messagesGate = new Promise((resolve) => {
    releaseMessages = resolve
  })
  const messagesStarted = new Promise((resolve) => {
    markStarted = resolve
  })
  const errors = []
  const reconciler = createSessionReconciler({
    config: { reconcile: { enabled: true } },
    state: { findBinding: () => binding, mirrorEnabled: () => true },
    telegram: {},
    opencode: {
      messages: async () => {
        messageCalls += 1
        markStarted()
        await messagesGate
        return []
      },
    },
    renderer: {},
    promptQueue: {},
    questionManager: {},
    backendRequest: async (_serverID, _label, operation) => operation(),
    skippedBackendRequest: Symbol("skipped"),
    createTopicForSession: async () => null,
    createTopicForWebSession: async () => null,
    isInternalSession: () => false,
    activateBindingForPrompt: async () => {},
    maybeExtendBindingActivity: async () => {},
    logError: (error) => errors.push(error),
    shouldStop: () => false,
  })

  reconciler.scheduleReconcile(binding, 0)
  let startTimeout
  await Promise.race([
    messagesStarted,
    new Promise((_, reject) => {
      startTimeout = setTimeout(() => reject(new Error("scheduled reconcile did not start")), 1000)
    }),
  ])
  clearTimeout(startTimeout)
  reconciler.scheduleReconcile(binding, 0)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(messageCalls, 1)

  let eventHandled = false
  const event = reconciler.handleOpenCodeEvent(
    { id: "nuc" },
    { type: "session.updated", properties: { sessionID: binding.sessionID } },
  ).then(() => {
    eventHandled = true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(eventHandled, false)

  releaseMessages()
  await event
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(messageCalls, 1)
  assert.equal(eventHandled, true)
  assert.deepEqual(errors, [])
}

async function smokeChunkedWebPromptMirror() {
  const raw = `${"alpha beta gamma ".repeat(40)}<unsafe>& tail`
  const messages = webPromptMessages(raw, 240)
  assert.ok(messages.length > 1)
  assert.equal(messages.some((message) => message.includes("truncated in Telegram mirror")), false)
  assert.ok(messages.every((message) => message.length <= 240))
  assert.match(messages[0], /^💬 Web prompt 1\/\d+\n\n/)
  assert.match(messages.at(-1), new RegExp(`^💬 Web prompt ${messages.length}\\/${messages.length}\\n\\n`))
  assert.ok(messages.join("\n").includes("&lt;unsafe&gt;&amp; tail"))

  const sent = []
  const renderer = new MirrorRenderer({
    config: { mirror: { maxTelegramChars: 240, pinUserPrompts: false } },
    telegram: {
      async sendMessage(message) {
        const sentMessage = { ...message, message_id: sent.length + 1 }
        sent.push(sentMessage)
        return sentMessage
      },
    },
  })
  const returned = await renderer.userPrompt({ chatId: 1, topicId: 2, serverID: "nuc", sessionID: "ses_chunk" }, raw, "web")
  assert.equal(sent.length, messages.length)
  assert.deepEqual(sent.map((message) => message.text), messages)
  assert.equal(returned.message_id, sent.length)
}

async function smokeKillCommandAbortFailure() {
  const binding = { serverID: "nuc", sessionID: "ses_kill", directory: "/home/bloob/politia/projects/tg/opencodebot" }
  const sent = []
  const promptQueue = new PromptQueue({
    onPrompt: async () => {},
    onQueued: async () => {},
    onQueueCleared: async () => {},
  })
  promptQueue.markBusy(binding)
  await promptQueue.enqueue(binding, "queued prompt")
  const handlers = createTelegramCommandHandlers({
    config: { chatTemplates: {} },
    state: { findBindingByTopic: () => binding },
    telegram: { async sendMessage(message) { sent.push(message) } },
    opencode: { async abortSession() { throw new Error("abort failed") } },
    promptQueue,
    multipartPrompts: { discardKey() {} },
    createPendingTopic: async () => {},
  })

  const handled = await handlers.handle({ chat: { id: 123 }, message_thread_id: 456 }, { name: "kill", args: "" }, "123:456")
  assert.equal(handled, true)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Failed to stop/)
  assert.match(sent[0].text, /abort failed/)
  assert.equal(promptQueue.status(binding).length, 1)
  assert.equal(promptQueue.isBusy(binding), true)
}

async function smokeKillSuppressesAbortFallout() {
  const binding = { chatId: 123, topicId: 456, serverID: "nuc", sessionID: "ses_kill", directory: "/tmp/work" }
  const sent = []
  const promptQueue = new PromptQueue(async () => {})
  const reconciler = createSessionReconciler({
    config: { telegram: { autocreateTopics: false }, reconcile: {} },
    state: {
      mirrorEnabled: () => true,
      findBinding: (serverID, sessionID) => (serverID === binding.serverID && sessionID === binding.sessionID ? binding : null),
      markAssistantMirrored: async () => {},
    },
    telegram: { async sendMessage(message) { sent.push(message) } },
    opencode: {},
    renderer: {},
    promptQueue,
    backendRequest: async () => {},
    skippedBackendRequest: async () => {},
    createTopicForSession: async () => null,
    createTopicForWebSession: async () => null,
    isInternalSession: () => false,
    activateBindingForPrompt: async () => {},
    maybeExtendBindingActivity: async () => {},
    logError: () => {},
    shouldStop: () => false,
  })

  promptQueue.markExpectedStop(binding)
  await reconciler.handleOpenCodeEvent({ id: "nuc" }, { type: "session.error", properties: { sessionID: "ses_kill", error: "aborted" } })
  assert.equal(sent.length, 0)
  await reconciler.handleOpenCodeEvent({ id: "nuc" }, { type: "session.error", properties: { sessionID: "ses_kill", error: "abort cleanup" } })
  assert.equal(sent.length, 0)

  promptQueue.clearExpectedStop(binding)
  await reconciler.handleOpenCodeEvent({ id: "nuc" }, { type: "session.error", properties: { sessionID: "ses_kill", error: "real failure" } })
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /OpenCodez session error/)
}

async function smokeQueueDrainsOnSessionIdle() {
  const binding = { chatId: 123, topicId: 456, serverID: "nuc", sessionID: "ses_queue_idle", directory: "/tmp/work" }
  const sent = []
  const rendered = []
  const mirrored = []
  const promptQueue = new PromptQueue(async (actualBinding, text) => sent.push({ actualBinding, text }))
  const reconciler = createSessionReconciler({
    config: { telegram: { autocreateTopics: false }, reconcile: {} },
    state: {
      mirrorEnabled: () => true,
      findBinding: (serverID, sessionID) => (serverID === binding.serverID && sessionID === binding.sessionID ? binding : null),
      isAssistantMirrored: (serverID, sessionID, messageID) => mirrored.some((item) => item.serverID === serverID && item.sessionID === sessionID && item.messageID === messageID),
      markAssistantMirrored: async (serverID, sessionID, messageID) => mirrored.push({ serverID, sessionID, messageID }),
    },
    telegram: { async sendMessage() {} },
    opencode: {},
    renderer: {
      finalAssistantMessageReady: async (actualBinding, messageID) => {
        rendered.push({ actualBinding, messageID })
        mirrored.push({ serverID: actualBinding.serverID, sessionID: actualBinding.sessionID, messageID })
        await promptQueue.markTerminalMirrored(actualBinding)
      },
    },
    promptQueue,
    backendRequest: async () => {},
    skippedBackendRequest: async () => {},
    createTopicForSession: async () => null,
    createTopicForWebSession: async () => null,
    isInternalSession: () => false,
    activateBindingForPrompt: async () => {},
    maybeExtendBindingActivity: async () => {},
    logError: () => {},
    shouldStop: () => false,
  })

  promptQueue.markBusy(binding)
  await promptQueue.enqueue(binding, "queued until idle")
  await reconciler.handleOpenCodeEvent({ id: "nuc" }, {
    type: "session.next.step.ended",
    properties: { sessionID: binding.sessionID, assistantMessageID: "msg_done", finish: "stop" },
  })
  assert.equal(sent.length, 0)
  assert.equal(promptQueue.status(binding).length, 1)
  assert.equal(promptQueue.isBusy(binding), true)
  assert.deepEqual(rendered.map((item) => item.messageID), ["msg_done"])
  assert.deepEqual(mirrored.map((item) => item.messageID), ["msg_done"])

  await reconciler.handleOpenCodeEvent({ id: "nuc" }, {
    type: "session.status",
    properties: { sessionID: binding.sessionID, status: { type: "idle" } },
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, "queued until idle")
  assert.equal(promptQueue.status(binding).length, 0)
  assert.equal(promptQueue.isBusy(binding), true)
}

async function smokeIncompleteRunNotice() {
  const binding = { chatId: 123, topicId: 456, serverID: "nuc", sessionID: "ses_incomplete", directory: "/tmp/work" }
  const userMessageID = "msg_incomplete_user"
  const notices = []
  const queued = []
  const mirroredUsers = new Set()
  const mirroredAssistants = new Set()
  const promptQueue = new PromptQueue(async (_binding, text) => queued.push(text))
  const reconciler = createSessionReconciler({
    config: { telegram: { autocreateTopics: false }, reconcile: {} },
    state: {
      mirrorEnabled: () => true,
      findBinding: (serverID, sessionID) => (serverID === binding.serverID && sessionID === binding.sessionID ? binding : null),
      isUserMirrored: (_serverID, _sessionID, messageID) => mirroredUsers.has(messageID),
      markUserMirrored: async (_serverID, _sessionID, messageID) => mirroredUsers.add(messageID),
      consumePendingPrompt: async () => null,
      isAssistantMirrored: (_serverID, _sessionID, messageID) => mirroredAssistants.has(messageID),
      markAssistantMirrored: async (_serverID, _sessionID, messageID) => mirroredAssistants.add(messageID),
    },
    telegram: { async sendMessage(message) { notices.push(message) } },
    opencode: {
      async request() { return {} },
      async messages() {
        return [{ info: { id: userMessageID, role: "user", time: { created: Date.now() } }, parts: [{ type: "text", text: "start" }] }]
      },
    },
    renderer: {
      async userPrompt() {},
      async compactTools() {},
      async assistantMessage() {},
      shouldMirrorTool: () => false,
      shouldPinUserPrompts: () => false,
    },
    promptQueue,
    backendRequest: async (_serverID, _label, request) => request(),
    skippedBackendRequest: Symbol("skipped"),
    createTopicForSession: async () => null,
    createTopicForWebSession: async () => null,
    isInternalSession: () => false,
    activateBindingForPrompt: async () => {},
    maybeExtendBindingActivity: async () => {},
    logError: (error) => { throw error },
    shouldStop: () => false,
    incompleteRunGraceMs: 0,
  })

  await reconciler.handleOpenCodeEvent({ id: "nuc" }, {
    type: "session.next.prompted",
    properties: { sessionID: binding.sessionID, messageID: userMessageID, text: "start" },
  })
  await promptQueue.enqueue(binding, "continue after notice")
  await reconciler.handleOpenCodeEvent({ id: "nuc" }, {
    type: "session.idle",
    properties: { sessionID: binding.sessionID },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /ended without a final answer/)
  assert.deepEqual(queued, ["continue after notice"])
}

async function smokeOpenCodeAbortClient() {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options })
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      async json() {
        return true
      },
      async text() {
        return "true"
      },
    }
  }
  try {
    const client = new OpenCodeClient({ opencode: { password: "", servers: [{ id: "nuc", url: "http://127.0.0.1:4096" }] } })
    const result = await client.abortSession("nuc", "ses kill", { directory: "/tmp/work dir" })
    assert.equal(result, true)
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(requests.length, 1)
  assert.equal(requests[0].options.method, "POST")
  assert.equal(requests[0].url, "http://127.0.0.1:4096/session/ses%20kill/abort?directory=%2Ftmp%2Fwork+dir")
}

async function smokeRuntimeHealth(runtimeConfig, { explicit }) {
  try {
    assertRuntimeConfig(runtimeConfig)
  } catch (error) {
    console.log(`runtime: skipped (${compactError(error)})`)
    if (explicit) throw error
    return
  }

  console.log(`config: ${runtimeConfig.sourcePath}`)
  console.log(`servers: ${runtimeConfig.opencode.servers.map((server) => server.id).join(", ")}`)
  console.log(`templates: ${Object.keys(runtimeConfig.chatTemplates || {}).join(", ") || "none"}`)

  const telegram = new TelegramClient(runtimeConfig.telegram.token, runtimeConfig.telegram.botApi)
  const opencode = new OpenCodeClient(runtimeConfig)
  const me = await telegram.getMe()
  console.log(`telegram: @${me.username || me.first_name || me.id}`)

  for (const server of runtimeConfig.opencode.servers) {
    try {
      const sessions = await opencode.listSessions(server.id)
      const count = Array.isArray(sessions) ? sessions.length : "ok"
      console.log(`${server.id}: reachable (${count})`)
    } catch (error) {
      console.log(`${server.id}: offline (${compactError(error)})`)
    }
  }
  if (explicit) await smokeArtifactRootWritable(runtimeConfig, opencode)
}

async function smokeArtifactRootWritable(runtimeConfig, opencode) {
  if (!runtimeConfig.artifactUploads?.enabled) return
  const serverID = runtimeConfig.artifactUploads.defaultServerId || runtimeConfig.defaultPrompt?.serverID
  if (!serverID) return
  let server
  try {
    server = opencode.server(serverID)
  } catch {
    return
  }
  if (server.transfer?.type !== "local") return
  const filename = `.opencodebot-smoke-${Date.now()}.txt`
  const targetPath = artifactTargetPath({ config: runtimeConfig, server, filename })
  const targetDir = server.pathStyle === "windows" ? path.win32.dirname(targetPath) : path.posix.dirname(targetPath)
  await mkdir(targetDir, { recursive: true })
  await writeFile(targetPath, "opencodebot smoke\n")
  await rm(targetPath, { force: true })
  console.log(`artifact uploads: writable (${targetDir})`)
}

function compactError(error) {
  return (error?.message || String(error)).replace(/\s+/g, " ").slice(0, 220)
}
