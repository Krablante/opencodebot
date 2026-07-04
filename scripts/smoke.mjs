import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { artifactTargetPath, handleArtifactUploadMessage, resolveUploadTarget } from "../src/artifact-uploads.mjs"
import { createTelegramCommandHandlers, telegramBotCommands } from "../src/commands.mjs"
import { assertRuntimeConfig, loadConfig } from "../src/config.mjs"
import { OpenCodeClient, visibleTextFromParts } from "../src/opencode.mjs"
import { PromptQueue } from "../src/prompt-queue.mjs"
import { createSessionReconciler } from "../src/session-reconcile.mjs"
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
  await smokeOpenCodeAbortClient()
  await smokeKillCommand()
  await smokeKillCommandAbortFailure()
  await smokeKillSuppressesAbortFallout()
}

function smokeConfigExample() {
  const example = loadConfig(path.join(projectRoot, "config.example.json"))
  assert.equal(example.artifactUploads.enabled, true)
  assert.equal(example.artifactUploads.root, "~/trash")
  assert.equal(example.attachments.maxFileBytes, 20000000)
  assert.equal(example.attachments.maxTotalBytes, 60000000)
  assert.ok(example.opencode.servers.length > 0)
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

  await reconciler.handleOpenCodeEvent({ id: "nuc" }, { type: "session.error", properties: { sessionID: "ses_kill", error: "real failure" } })
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /OpenCodez session error/)
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
