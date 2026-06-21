import assert from "node:assert/strict"

import { AttachmentBuffer } from "../src/attachments.mjs"
import { parseNewTopicArgs } from "../src/chat-templates.mjs"
import { loadConfig } from "../src/config.mjs"
import { MultipartPromptBuffer } from "../src/multipart-prompts.mjs"
import { OpenCodeClient } from "../src/opencode.mjs"
import { PromptQueue } from "../src/prompt-queue.mjs"
import { TelegramClient } from "../src/telegram.mjs"
import { formatToolLine } from "../src/tool-formatting.mjs"

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
  smokeToolFormatting()
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
}

function smokeToolFormatting() {
  assert.equal(formatToolLine("tool", { filePath: "/tmp/project/main.mjs", offset: 3 }, true), "✅ Read main.mjs offset=3")
  assert.match(formatToolLine("tool", { patchText: "*** Begin Patch\n*** Update File: src/main.mjs\n*** End Patch" }, false), /^❌ Patch files/)
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
