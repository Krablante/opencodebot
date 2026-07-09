import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { artifactTargetPath, handleArtifactUploadMessage, resolveUploadTarget } from "../src/artifact-uploads.mjs"
import { AttachmentBuffer } from "../src/attachments.mjs"
import { createTelegramCommandHandlers, telegramBotCommands } from "../src/commands.mjs"
import { assertRuntimeConfig, loadConfig } from "../src/config.mjs"
import { finalNotificationMarkdown, toolSummaryBeforeAssistant } from "../src/final-notifications.mjs"
import { OpenCodeClient, visibleTextFromParts } from "../src/opencode.mjs"
import { PromptQueue } from "../src/prompt-queue.mjs"
import { MirrorRenderer, webPromptMessages } from "../src/render.mjs"
import { bindingSessionReconcileRefresh, createSessionReconciler, shouldSkipAssistantForCatchup } from "../src/session-reconcile.mjs"
import { normalizeSpeechConfig } from "../src/config/speech.mjs"
import { SpeechModule, transcriptMessage } from "../src/speech/index.mjs"
import { OpenRouterSpeechClient, audioFormat } from "../src/speech/openrouter-client.mjs"
import { StateStore } from "../src/state.mjs"
import { TelegramClient } from "../src/telegram.mjs"
import { OpencodebotArtifactsPlugin } from "../plugins/opencodebot-artifacts/src/index.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, "..")
const explicitConfigPath = process.argv[2]
const config = loadConfig(explicitConfigPath)

await smokeLocalInvariants()
await smokeRuntimeHealth(config, { explicit: Boolean(explicitConfigPath) })

async function smokeLocalInvariants() {
  smokeConfigExample()
  smokeSyntheticTextFilter()
  await smokeArtifactDropbox()
  await smokeArtifactPluginBatchCaptions()
  await smokeSpeechOpenRouterRequest()
  await smokeSpeechTopicRouting()
  smokeSpeechTranscriptMessage()
  await smokeOpenCodeAbortClient()
  await smokeQueuedAttachmentPayload()
  await smokeQueuedMediaGroupAttachmentPayload()
  await smokeAttachmentTextChunksWaitForIdle()
  smokeExpiredBindingReconcileRefresh()
  smokeCatchupAssistantGate()
  await smokeMirrorModeCommands()
  await smokeMirrorModeRendering()
  smokeFinalToolSummary()
  await smokeChunkedWebPromptMirror()
  await smokeKillCommand()
  await smokeKillCommandAbortFailure()
  await smokeKillSuppressesAbortFallout()
  await smokeQueueDrainsOnSessionIdle()
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
  mode = "economy"
  await renderer.toolCalled(binding, { callID: "read-economy", tool: "read", input: { filePath: "/tmp/b" } })
  await renderer.toolResult(binding, { callID: "read-economy", tool: "read", output: "ok", ok: true })
  assert.equal(sent.length, 2)
  await renderer.toolCalled(binding, { callID: "task-economy", tool: "task", input: { subagent_type: "general", prompt: "inspect" } })
  await renderer.toolResult(binding, { callID: "task-economy", tool: "task", output: "done", ok: true })
  assert.equal(sent.length, 3)
  assert.equal(sent.at(-1).text, "🤖 Subagent spawned: <code>general</code>")
  await renderer.compactTools(binding, ["📄 Read /tmp/c"])
  assert.equal(sent.length, 3)
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
  assert.match(notification, /Tools:.*Read × 2; Patch × 1; Edit × 1; Write × 1/)
  assert.ok(notification.includes("Patched:* a\\.mjs; moved\\.mjs; new\\.mjs; edit\\.mjs"))
  assert.doesNotMatch(notification, /\/home\/bloob|C:\\repo|old\.txt|failed\.mjs|Explore|Todo/)
}

function smokeConfigExample() {
  const example = loadConfig(path.join(projectRoot, "config.example.json"))
  assert.equal(example.artifactUploads.enabled, true)
  assert.equal(example.artifactUploads.root, "~/trash")
  assert.equal(example.attachments.maxFileBytes, 20000000)
  assert.equal(example.attachments.maxTotalBytes, 60000000)
  assert.equal(example.speech.enabled, false)
  assert.equal(example.speech.openrouter.model, "openai/whisper-large-v3-turbo")
  assert.equal(example.speech.openrouter.language, "ru")
  assert.ok(example.opencode.servers.length > 0)
}

async function smokeSpeechOpenRouterRequest() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencodebot-speech-smoke-"))
  const audioPath = path.join(root, "voice.oga")
  await writeFile(audioPath, "fake audio bytes")
  const requests = []
  const normalized = normalizeSpeechConfig({ enabled: true }, { OPENROUTER_API_KEY: "test-key" })
  assert.equal(normalized.openrouter.apiKey, "test-key")
  assert.equal(normalized.openrouter.language, "ru")
  assert.equal(normalizeSpeechConfig({ enabled: true, openrouter: { language: "EN" } }).openrouter.language, "en")
  assert.equal(normalizeSpeechConfig({ enabled: true, language: "uk" }).openrouter.language, "uk")
  assert.equal(normalizeSpeechConfig({ enabled: true, openrouter: { language: null } }).openrouter.language, null)
  assert.equal(normalizeSpeechConfig({ enabled: true, openrouter: { language: "auto" } }).openrouter.language, null)
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
    const client = new OpenRouterSpeechClient({
      apiKeyEnv: "OPENROUTER_API_KEY",
      url: "https://openrouter.ai/api/v1/audio/transcriptions",
      model: "openai/whisper-large-v3-turbo",
      language: "ru",
      temperature: 0,
      responseFormat: "json",
      prompt: "short prompt",
      referer: "https://example.test/opencodebot",
      title: "opencodebot smoke",
      timeoutMs: 5000,
    }, { OPENROUTER_API_KEY: "test-key" }, fetchImpl)
    const result = await client.transcribeFile({ localPath: audioPath, filename: "voice.oga", mime: "audio/ogg" })
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
    const autoBody = new OpenRouterSpeechClient({ ...client.config, language: null }, {}, fetchImpl).requestBody(Buffer.from("audio"), "ogg")
    assert.equal(Object.hasOwn(autoBody, "language"), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function smokeSpeechTopicRouting() {
  const jobs = []
  const speech = new SpeechModule({
    config: {
      enabled: true,
      maxFileBytes: 25_000_000,
      queueConcurrency: 1,
      statusMessage: "Transcribing voice...",
      openrouter: {
        apiKeyEnv: "OPENROUTER_API_KEY",
        apiKey: "test-key",
        model: "openai/whisper-large-v3-turbo",
        language: "ru",
        temperature: 0,
        responseFormat: "json",
        prompt: "",
        timeoutMs: 5000,
      },
    },
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
  assert.equal(speech.status().language, "ru")
  speech.config.openrouter.language = null
  assert.equal(speech.status().language, "auto")
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
    const flushed = await queue.complete(binding)
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
      markAssistantMirrored: async (serverID, sessionID, messageID) => mirrored.push({ serverID, sessionID, messageID }),
    },
    telegram: { async sendMessage() {} },
    opencode: {},
    renderer: {
      finalAssistantMessageReady: async (actualBinding, messageID) => rendered.push({ actualBinding, messageID }),
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
