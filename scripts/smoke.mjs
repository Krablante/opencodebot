import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { artifactFileCaptionHtml, artifactPathLines, startArtifactGateway } from "../src/artifacts-gateway.mjs"
import { AttachmentBuffer } from "../src/attachments.mjs"
import { parseNewTopicArgs } from "../src/chat-templates.mjs"
import { loadConfig } from "../src/config.mjs"
import { completedTodosBeforeAssistant, createFinalNotifier, finalNotificationMarkdown, finalNotificationTopicSource, formatCompletedTodoMarkdown } from "../src/final-notifications.mjs"
import { MultipartPromptBuffer } from "../src/multipart-prompts.mjs"
import { OpenCodeClient, promptPayload } from "../src/opencode.mjs"
import { PromptQueue } from "../src/prompt-queue.mjs"
import { StateStore } from "../src/state.mjs"
import { TelegramClient } from "../src/telegram.mjs"
import { formatToolLine } from "../src/tool-formatting.mjs"
import { prepareSavedFilesForServer, targetUploadPath } from "../src/upload-transfer.mjs"
import { OpencodebotArtifactsPlugin } from "../plugins/opencodebot-artifacts/src/index.js"

const config = loadConfig(process.argv[2])
const client = new OpenCodeClient(config)
const telegram = new TelegramClient(config.telegram.token)
let failed = false

await smokeLocalLogic()

console.log(`config: ${config.sourcePath}`)
console.log(`servers: ${config.opencode.servers.map((server) => server.id).join(", ")}`)
console.log(`templates: ${Object.keys(config.chatTemplates || {}).join(", ") || "none"}`)

try {
  const me = await telegram.getMe()
  console.log(`telegram: @${me.username || me.first_name || me.id}`)
} catch (error) {
  failed = true
  console.log(`telegram: failed (${compactError(error)})`)
}

for (const server of config.opencode.servers) {
  try {
    const sessions = await client.listSessions(server.id)
    const count = Array.isArray(sessions) ? sessions.length : "ok"
    console.log(`${server.id}: reachable (${count})`)
  } catch (error) {
    console.log(`${server.id}: offline (${compactError(error)})`)
  }
}

await smokeTemplateSelection()

if (failed) process.exitCode = 1

async function smokeLocalLogic() {
  smokeNewParser()
  smokeOpenCodeDirectories()
  smokeToolFormatting()
  await smokeFinalNotificationTodos()
  smokeArtifactCaptionPaths()
  await smokeStateSeenSessionSeeding()
  await smokeUploadTransfer()
  await smokeArtifactPluginFileUrls()
  await smokeArtifactGatewayStream()
  await smokeLocalTelegramConfig()
  await smokeTelegramClientLocalFiles()
  smokeSavedAttachmentPrompt()
  await smokePromptQueue()
  await smokeMultipartPrompts()
  await smokeAttachmentBuffer()
  console.log("local-logic: ok")
}

function smokeNewParser() {
  const templates = { d4flash: { opencodezTemplate: "dev-fast", model: "openai/gpt-4.1" } }
  const parsed = parseNewTopicArgs("home d4flash Shipping fix", {
    servers: new Set(["home", "work"]),
    defaultServerID: "home",
    chatTemplates: templates,
  })
  assert.equal(parsed.serverID, "home")
  assert.equal(parsed.chatTemplateName, "d4flash")
  assert.equal(parsed.title, "Shipping fix")
  assert.equal(parsed.titleSource, "user")
  assert.equal(parsed.chatTemplate, templates.d4flash)

  const fallback = parseNewTopicArgs("d4flash", { servers: new Set(["home"]), defaultServerID: "home", chatTemplates: templates })
  assert.equal(fallback.serverID, "home")
  assert.equal(fallback.title, "d4flash")
  assert.equal(fallback.titleSource, "auto")

  const posixPath = parseNewTopicArgs("nuc gpt55p dir:/home/bloob/politia/projects/tg/opencodebot Artifact gateway", {
    servers: new Set(["nuc"]),
    defaultServerID: "nuc",
    chatTemplates: { gpt55p: { opencodezTemplate: "gpt55" } },
  })
  assert.equal(posixPath.serverID, "nuc")
  assert.equal(posixPath.chatTemplateName, "gpt55p")
  assert.equal(posixPath.directory, "/home/bloob/politia/projects/tg/opencodebot")
  assert.equal(posixPath.title, "Artifact gateway")

  const windowsPath = parseNewTopicArgs('dima d4flash dir:"C:\\Users\\dima\\My Projects\\voltaren" voltaren', {
    servers: new Set(["dima"]),
    defaultServerID: "dima",
    chatTemplates: templates,
  })
  assert.equal(windowsPath.directory, "C:\\Users\\dima\\My Projects\\voltaren")
  assert.equal(windowsPath.title, "voltaren")
}

function smokeOpenCodeDirectories() {
  const scopedClient = new OpenCodeClient({
    opencode: {
      password: "test",
      mirrorScope: "serverHome",
      newSessionDefaultDirectory: "serverHome",
      servers: [{ id: "home", url: "http://opencode.test", home: "C:\\Users\\dima" }],
    },
  })
  const globalClient = new OpenCodeClient({
    opencode: {
      password: "test",
      mirrorScope: "global",
      newSessionDefaultDirectory: "serverHome",
      servers: [{ id: "home", url: "http://opencode.test", home: "C:\\Users\\dima" }],
    },
  })
  assert.equal(scopedClient.url(scopedClient.server("home"), "/session", scopedClient.requestOptions(scopedClient.server("home"), { mirror: true })).searchParams.get("directory"), "C:\\Users\\dima")
  assert.equal(globalClient.url(globalClient.server("home"), "/session", globalClient.requestOptions(globalClient.server("home"), { mirror: true })).searchParams.get("directory"), null)
  assert.equal(globalClient.defaultNewSessionDirectory("home"), "C:\\Users\\dima")
  assert.equal(globalClient.url(globalClient.server("home"), "/session", { directory: "C:\\Users\\dima\\My Projects\\voltaren" }).searchParams.get("directory"), "C:\\Users\\dima\\My Projects\\voltaren")
}

function smokeToolFormatting() {
  assert.equal(formatToolLine("tool", { filePath: "/tmp/project/main.mjs", offset: 3 }, true), "✅ Read main.mjs offset=3")
  assert.match(formatToolLine("tool", { patchText: "*** Begin Patch\n*** Update File: src/main.mjs\n*** End Patch" }, false), /^❌ Patch files/)
}

function smokeArtifactCaptionPaths() {
  assert.deepEqual(artifactPathLines(["/tmp/report.txt"]), ["/tmp/report.txt"])
  assert.deepEqual(artifactPathLines(["/tmp/a/report.txt", "/tmp/a/screenshot.png"]), ["/tmp/a", "report.txt, screenshot.png"])
  assert.deepEqual(artifactPathLines(["/tmp/a/report.txt", "/var/log/app.log"]), ["/tmp/a/report.txt", "/var/log/app.log"])
  assert.deepEqual(artifactPathLines([String.raw`C:\Users\friend\Desktop\report.txt`]), [String.raw`C:\Users\friend\Desktop\report.txt`])
  assert.deepEqual(
    artifactPathLines([String.raw`C:\Users\friend\Desktop\report.txt`, String.raw`C:\Users\friend\Desktop\screenshot.png`]),
    [String.raw`C:\Users\friend\Desktop`, "report.txt, screenshot.png"],
  )
  assert.deepEqual(
    artifactPathLines(["C:/Users/friend/Desktop/report.txt", String.raw`C:\Users\friend\Desktop\screenshot.png`]),
    ["C:/Users/friend/Desktop", "report.txt, screenshot.png"],
  )
  assert.deepEqual(
    artifactPathLines([String.raw`\\nas\share\report.txt`, String.raw`\\nas\share\screenshot.png`]),
    [String.raw`\\nas\share`, "report.txt, screenshot.png"],
  )
  assert.deepEqual(
    artifactPathLines(["file:///C:/Users/friend/Desktop/report.txt", "file:///C:/Users/friend/Desktop/screenshot.png"]),
    ["C:/Users/friend/Desktop", "report.txt, screenshot.png"],
  )
  assert.equal(
    artifactFileCaptionHtml("nuc/app/report/final", ["/tmp/a/report.txt", "/tmp/a/screenshot.png"]),
    "nuc/app/report/final\n\n<blockquote>/tmp/a\nreport.txt, screenshot.png</blockquote>",
  )
  assert.equal(
    artifactFileCaptionHtml("win/app/report/final", [String.raw`C:\Users\friend\Desktop\report.txt`, String.raw`C:\Users\friend\Desktop\screenshot.png`]),
    String.raw`win/app/report/final

<blockquote>C:\Users\friend\Desktop
report.txt, screenshot.png</blockquote>`,
  )
}

async function smokeStateSeenSessionSeeding() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencodebot-state-"))
  try {
    const state = new StateStore(path.join(dir, "state.json"))
    await state.load()
    assert.equal(await state.seedSeenSessions([["nuc", "old-home"]]), 1)
    assert.equal(await state.seedSeenSessions([["nuc", "old-home"], ["dima", "already-existing-politia"]]), 1)
    assert.equal(state.hasSeenSession("nuc", "old-home"), true)
    assert.equal(state.hasSeenSession("dima", "already-existing-politia"), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function smokeUploadTransfer() {
  const posixPath = targetUploadPath({
    server: { uploadRoot: "/home/dima/.opencodebot/uploads", pathStyle: "posix" },
    sessionID: "ses_test/unsafe",
    filename: "big file.txt",
    uniqueID: "uuid-1",
  })
  assert.equal(posixPath, "/home/dima/.opencodebot/uploads/ses_test-unsafe/uuid-1/big file.txt")

  const windowsPath = targetUploadPath({
    server: { uploadRoot: "C:\\Users\\Alice\\.opencodebot\\uploads", pathStyle: "windows" },
    sessionID: "ses_test",
    filename: "report/final.md",
    uniqueID: "uuid-2",
  })
  assert.equal(windowsPath, "C:\\Users\\Alice\\.opencodebot\\uploads\\ses_test\\uuid-2\\report-final.md")

  const dir = await mkdtemp(path.join(os.tmpdir(), "opencodebot-upload-"))
  try {
    const source = path.join(dir, "source.txt")
    const uploadRoot = path.join(dir, "target")
    await writeFile(source, "upload test")
    const [prepared] = await prepareSavedFilesForServer([
      { type: "saved_file", filename: "source.txt", path: source, size: 11, mime: "text/plain" },
    ], {
      server: { id: "local", uploadRoot, pathStyle: "posix", transfer: { type: "local" } },
      sessionID: "ses_local",
    })
    assert.equal(prepared.transferred, true)
    assert.match(prepared.path, /\/ses_local\/[A-Za-z0-9._-]+\/source\.txt$/)
    assert.equal(await readFile(prepared.path, "utf8"), "upload test")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function smokeArtifactPluginFileUrls() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencodebot-artifacts-"))
  const filePath = path.join(dir, "report.txt")
  await writeFile(filePath, "hello from file url\n")
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    const chunks = []
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk))
    calls.push({ url, options, body: Buffer.concat(chunks).toString("utf8") })
    return new Response(JSON.stringify({ ok: true, messages: [{ method: "sendDocument", messageId: 123 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  try {
    const plugin = await OpencodebotArtifactsPlugin(undefined, { gatewayUrl: "http://opencodebot.test", token: "token" })
    const result = await plugin.tool.opencodebot_send_artifact.execute({ path: pathToFileURL(filePath).href, caption: "smoke/file-url" }, { directory: dir })
    assert.match(result, /message_id=123/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "http://opencodebot.test/artifacts/send-file")
    assert.equal(calls[0].options.method, "POST")
    assert.equal(calls[0].options.duplex, "half")
    assert.equal(calls[0].body, "hello from file url\n")
    const metadata = JSON.parse(Buffer.from(calls[0].options.headers["x-opencodebot-artifact-meta"], "base64url").toString("utf8"))
    assert.deepEqual(metadata.captionPaths, [filePath])
    assert.equal(metadata.file.filename, "report.txt")
  } finally {
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
}

async function smokeArtifactGatewayStream() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencodebot-gateway-stream-"))
  const spoolDir = path.join(dir, "spool")
  let sentPath = ""
  const server = startArtifactGateway({
    config: {
      artifacts: { enabled: true, listenHost: "127.0.0.1", port: 0, token: "token", maxPayloadBytes: 1024, maxFileBytes: 1024 * 1024, maxTextChars: 1000, maxCaptionChars: 1000 },
      telegram: { botApi: { mode: "local", spoolDir } },
    },
    state: { artifactsTopic: () => ({ chatId: 42, topicId: 7 }) },
    telegram: {
      local: true,
      sendDocument: async ({ file }) => {
        sentPath = file.localPath
        assert.equal(await readFile(file.localPath, "utf8"), "streamed file body")
        return { method: "sendDocument", message_id: 777, chat: { id: 42 }, message_thread_id: 7 }
      },
    },
  })
  try {
    if (!server.listening) await once(server, "listening")
    const port = server.address().port
    const metadata = Buffer.from(JSON.stringify({ caption: "stream", file: { filename: "stream.txt", contentType: "text/plain" } })).toString("base64url")
    const response = await fetch(`http://127.0.0.1:${port}/artifacts/send-file`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "text/plain", "x-opencodebot-artifact-meta": metadata },
      body: "streamed file body",
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(path.basename(sentPath), "stream.txt")
    await assert.rejects(readFile(sentPath), /ENOENT/)
    await assert.rejects(readFile(path.dirname(sentPath)), /ENOENT/)
    const legacyResponse = await fetch(`http://127.0.0.1:${port}/artifacts/send`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ caption: "legacy", file: { filename: "legacy.txt", contentType: "text/plain", dataBase64: Buffer.from("legacy").toString("base64") } }),
    })
    assert.equal(legacyResponse.status, 400)
    const legacyBody = await legacyResponse.json()
    assert.equal(legacyBody.error, "stream_required")
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
}

async function smokeLocalTelegramConfig() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencodebot-config-"))
  try {
    const tokenPath = path.join(dir, "token.env")
    const serversPath = path.join(dir, "servers.json")
    const configPath = path.join(dir, "config.json")
    await writeFile(tokenPath, "TELEGRAM_BOT_TOKEN=test-token\nTELEGRAM_API_ID=123\nTELEGRAM_API_HASH=hash\nOPENCODEBOT_ARTIFACT_TOKEN=artifact\n")
    await writeFile(serversPath, JSON.stringify({ servers: [{ id: "local", url: "http://127.0.0.1:4096" }] }))
    await writeFile(configPath, JSON.stringify({
      telegram: { botApi: { mode: "local", rootUrl: "http://telegram-bot-api:8081", localFilesRoot: "/var/lib/telegram-bot-api" } },
      paths: { tokenEnv: tokenPath, serversJson: serversPath },
    }))
    const localConfig = loadConfig(configPath)
    assert.equal(localConfig.telegram.botApi.mode, "local")
    assert.equal(localConfig.telegram.botApi.apiIdPresent, true)
    assert.equal(localConfig.telegram.botApi.apiHashPresent, true)
    assert.equal(localConfig.artifacts.maxFileBytes, 2_000_000_000)
    assert.equal(localConfig.attachments.maxInlineBytes, 20_000_000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function smokeTelegramClientLocalFiles() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencodebot-local-file-"))
  const source = path.join(dir, "telegram", "documents", "big.bin")
  const destination = path.join(dir, "downloaded.bin")
  const originalFetch = globalThis.fetch
  try {
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, "local telegram bytes")
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "http://telegram-bot-api:8081/botTOKEN/getFile")
      return new Response(JSON.stringify({ ok: true, result: { file_id: "file", file_path: source, file_size: 20 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    const telegram = new TelegramClient("TOKEN", { mode: "local", rootUrl: "http://telegram-bot-api:8081", localFilesRoot: path.join(dir, "telegram") })
    await telegram.downloadFile({ fileId: "file", destination, maxBytes: 1000 })
    assert.equal(await readFile(destination, "utf8"), "local telegram bytes")
  } finally {
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
}

function smokeSavedAttachmentPrompt() {
  const payload = promptPayload("please inspect", {}, [{ type: "saved_file", filename: "large.mov", mime: "video/quicktime", path: "/app/state/uploads/large.mov", size: 75_000_000 }])
  assert.equal(payload.parts.length, 1)
  assert.match(payload.parts[0].text, /Saved Telegram attachment/)
  assert.match(payload.parts[0].text, /large\.mov/)
}

async function smokeFinalNotificationTodos() {
  const messages = [
    { info: { id: "user-1", role: "user" }, parts: [{ type: "text", text: "ship it" }] },
    {
      info: { id: "assistant-1", role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "todowrite",
          state: {
            status: "completed",
            input: {
              todos: [
                { content: "Inspect final DM", status: "completed", priority: "high" },
                { content: "Add todo section", status: "completed", priority: "high" },
              ],
            },
          },
        },
      ],
    },
    { info: { id: "assistant-final", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
  ]

  assert.deepEqual(completedTodosBeforeAssistant(messages, "assistant-final"), ["Inspect final DM", "Add todo section"])
  assert.deepEqual(formatCompletedTodoMarkdown(["Inspect final DM"]), [">📋 Tasks \\[1/1\\]:", ">✅ 1\\. Inspect final DM||"])
  const notification = finalNotificationMarkdown({
    topicSource: { title: "Actual Topic", iconCustomEmojiId: "5368324170671202286" },
    serverID: "ser",
    promptText: "ship it",
    completedTodos: ["Inspect final DM"],
  })
  assert.equal(notification.includes(String.fromCodePoint(0x1f9f5)), false)
  assert.match(notification, /💬 \*Topic:\* !\[💬\]\(tg:\/\/emoji\?id=5368324170671202286\) Actual Topic/)
  assert.deepEqual(finalNotificationTopicSource({ title: "Session Title", topicTitle: "Telegram Topic", topicId: 4690 }), {
    title: "Telegram Topic",
    iconCustomEmojiId: "",
    iconEmoji: "",
  })
  assert.deepEqual(finalNotificationTopicSource({ title: "Session Title", topicId: 4690 }), {
    title: "Topic 4690",
    iconCustomEmojiId: "",
    iconEmoji: "",
  })
  assert.deepEqual(finalNotificationTopicSource({ topicTitle: "Telegram Topic", topicIconCustomEmojiId: "5350713563512052787", topicIconEmoji: "📉" }), {
    title: "Telegram Topic",
    iconCustomEmojiId: "5350713563512052787",
    iconEmoji: "📉",
  })

  const activeMessages = [
    ...messages,
    {
      info: { id: "assistant-2", role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "todowrite",
          state: {
            status: "completed",
            input: JSON.stringify({ todos: [{ content: "Still working", status: "in_progress", priority: "high" }] }),
          },
        },
      ],
    },
  ]
  assert.deepEqual(completedTodosBeforeAssistant(activeMessages, null), [])

  const many = Array.from({ length: 18 }, (_, index) => `Task ${index + 1}`)
  const formatted = formatCompletedTodoMarkdown(many, { maxItems: 2, maxItemChars: 20 })
  assert.deepEqual(formatted, [">📋 Tasks \\[2/18\\]:", ">✅ 1\\. Task 1", ">✅ 2\\. Task 2", ">✅ 3\\. and 16 more||"])

  const longNotification = finalNotificationMarkdown({
    topicSource: { title: "Long Topic" },
    serverID: "nuc",
    promptText: "x".repeat(12_000),
    completedTodos: Array.from({ length: 40 }, (_, index) => `Long task ${index + 1} ${"y".repeat(200)}`),
  })
  assert.ok(longNotification.length < 4096, `final notification too long: ${longNotification.length}`)
  assert.match(longNotification, /trimmed|too long/)

  const marked = []
  const sends = []
  const notifier = createFinalNotifier({
    telegram: {
      sendMessage: async (payload) => {
        sends.push(payload)
        if (payload.format === "markdownv2") throw new Error("Bad Request: message is too long")
      },
    },
    state: {
      finalNotificationUserIds: () => [42],
      finalNotificationSent: () => false,
      markFinalNotificationSent: async (...args) => marked.push(args),
    },
    opencode: {
      messages: async () => messages,
    },
    config: { finalNotifications: { userIds: [42], maxSentMarkers: 100 } },
  })
  await notifier.notifyFinalAnswerReady({ serverID: "nuc", sessionID: "session", topicId: 7, topicTitle: "Topic" }, {
    assistantMessageID: "assistant-final",
    messageId: 123,
  })
  assert.equal(sends.length, 2)
  assert.equal(sends[0].format, "markdownv2")
  assert.equal(sends[1].format, undefined)
  assert.equal(marked.length, 1)
}

async function smokePromptQueue() {
  const sent = []
  const binding = { serverID: "local", sessionID: "session" }
  const queue = new PromptQueue(async (_binding, text) => sent.push(text))

  assert.deepEqual(await queue.enqueue(binding, "first prompt"), { status: "sent" })
  assert.deepEqual(sent, ["first prompt"])
  assert.deepEqual(await queue.enqueue(binding, "second prompt"), { status: "queued", position: 1 })
  assert.equal(queue.status(binding)[0].summary, "second prompt")
  assert.equal(queue.delete(binding, 1).text, "second prompt")
  assert.deepEqual(await queue.enqueue(binding, "third prompt should be cleared after terminal failure"), { status: "queued", position: 1 })
  const queuedAt = queue.status(binding)[0]?.createdAt
  assert.deepEqual(queue.clear(binding), [
    {
      index: 1,
      text: "third prompt should be cleared after terminal failure",
      summary: "third prompt should be cleared after terminal failure",
      createdAt: queuedAt,
    },
  ])
  assert.deepEqual(await queue.enqueue(binding, "after clear"), { status: "sent" })
  assert.deepEqual(await queue.complete(binding), { status: "idle" })
}

async function smokeMultipartPrompts() {
  const flushed = []
  const buffer = new MultipartPromptBuffer({ enabled: true, minChars: 5, idleMs: 60_000, maxParts: 3, maxChars: 200 }, async (context, text) => flushed.push({ context, text }))
  assert.equal(await buffer.push("k", "hello", { id: 1 }), "queued")
  assert.equal(await buffer.push("k", "world", { id: 1 }), "queued")
  assert.equal(await buffer.flushKey("k"), true)
  assert.deepEqual(flushed, [{ context: { id: 1 }, text: "hello\n\nworld" }])
}

async function smokeAttachmentBuffer() {
  const flushed = []
  const buffer = new AttachmentBuffer({
    settings: { enabled: true, promptIdleMs: 60_000, maxFiles: 4 },
    uploadDir: "/tmp/opencodebot-smoke",
    flushPrompt: async (context, text, files) => flushed.push({ context, text, files }),
    onExpire: () => {},
  })
  assert.deepEqual(await buffer.addFiles("k", { id: 1 }, [{ filename: "a.txt", mime: "text/plain", localPath: "/tmp/a.txt" }]), { status: "waiting_for_text", files: 1 })
  assert.equal(await buffer.addText("k", { id: 1 }, "use this"), true)
  assert.equal(flushed[0].text, "use this")
  assert.equal(flushed[0].files[0].filename, "a.txt")
}

async function smokeTemplateSelection() {
  const serverID = config.defaultPrompt.serverID || config.opencode.defaultServerId || config.opencode.servers[0]?.id
  const templateName = config.chatTemplates.gpt55p ? "gpt55p" : Object.keys(config.chatTemplates || {})[0]
  const template = templateName ? config.chatTemplates[templateName] : null
  if (!serverID || !template?.opencodezTemplate) {
    console.log("template-select: skipped")
    return
  }
  const server = config.opencode.servers.find((item) => item.id === serverID)
  if (server?.offlineOk) {
    console.log(`template-select: skipped (${serverID} is offline_ok)`)
    return
  }
  let session
  try {
    session = await client.createSession(serverID)
    await client.selectPromptTemplate(serverID, session.id, template.opencodezTemplate, template.model)
    const selected = await client.getSession(serverID, session.id)
    const selection = selected.metadata?.opencodez?.selection || {}
    if (!selection.system || !selection.tone || !selection.systemManual || !selection.toneManual) {
      throw new Error("template metadata was not applied")
    }
    console.log(`template-select: ${templateName} -> ${selection.system} / ${selection.tone}`)
  } catch (error) {
    failed = true
    console.log(`template-select: failed (${compactError(error)})`)
  } finally {
    if (session?.id) {
      await client.request(client.server(serverID), `/session/${encodeURIComponent(session.id)}`, { method: "DELETE" }).catch(() => {})
    }
  }
}

function compactError(error) {
  return String(error?.message || error || "error").replace(/\s+/g, " ").slice(0, 180)
}
