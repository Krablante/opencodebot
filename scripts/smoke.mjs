import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { artifactTargetPath, handleArtifactUploadMessage, resolveUploadTarget } from "../src/artifact-uploads.mjs"
import { assertRuntimeConfig, loadConfig } from "../src/config.mjs"
import { OpenCodeClient, visibleTextFromParts } from "../src/opencode.mjs"
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
