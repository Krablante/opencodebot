import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import { applyChatTemplate, parseNewTopicArgs, parseResetArgs, parseResetProfileArg } from "../src/chat-templates.mjs"
import { normalizeChatTemplates } from "../src/config/chat-templates.mjs"
import { OpenCodeClient, profileFromMessages } from "../src/opencode.mjs"
import { baseTitleFromTelegramTitle, managedTopicTitle } from "../src/topic-titles.mjs"

test("built-in chat profiles use current models, variants, and System prompts", () => {
  const profiles = normalizeChatTemplates()

  assert.deepEqual(Object.keys(profiles).sort(), ["d4flash", "d4pro", "luna", "sol", "solh", "solm", "solmax", "terra"])
  assert.deepEqual(profiles.sol, {
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "xhigh" },
    opencodezSystem: "codex_gpt_5_6_sol",
  })
  assert.equal(profiles.luna.opencodezSystem, "codex_gpt_5_6_luna_terra")
  assert.equal(profiles.terra.opencodezSystem, "codex_gpt_5_6_luna_terra")
  assert.equal(profiles.d4flash.opencodezSystem, "default")
  assert.equal(profiles.d4pro.opencodezSystem, "default")
  for (const [name, variant] of [["solm", "medium"], ["solh", "high"], ["sol", "xhigh"], ["solmax", "max"]]) {
    assert.deepEqual(profiles[name], {
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6-sol", variant },
      opencodezSystem: "codex_gpt_5_6_sol",
    })
  }
  assert.deepEqual(profileFromMessages([{ info: { role: "user", agent: "build", model: profiles.sol.model } }]), {
    agent: "build",
    model: profiles.sol.model,
  })
})

test("/new resolves a profile and rejects the retired gpt55p alias", async () => {
  const profiles = normalizeChatTemplates()
  const options = { servers: new Map([["nuc", {}]]), defaultServerID: "nuc", chatTemplates: profiles }
  const parsed = parseNewTopicArgs("nuc sol opencodebot-first", options)

  assert.equal(parsed.chatTemplateName, "sol")
  assert.equal(parsed.title, "opencodebot-first")
  assert.equal(parseNewTopicArgs("solm medium-work", options).chatTemplate.model.variant, "medium")
  assert.equal(parseNewTopicArgs("solh high-work", options).chatTemplate.model.variant, "high")
  assert.equal(parseNewTopicArgs("solmax max-work", options).chatTemplate.model.variant, "max")

  const calls = []
  await applyChatTemplate({
    switchSessionModel: (...args) => calls.push(["model", ...args]),
    selectSystemPrompt: (...args) => calls.push(["system", ...args]),
  }, "nuc", "ses_test", parsed.chatTemplate)
  assert.deepEqual(calls, [
    ["model", "nuc", "ses_test", profiles.sol.model, {}],
    ["system", "nuc", "ses_test", "codex_gpt_5_6_sol", {}],
  ])
  assert.throws(() => parseNewTopicArgs("nuc gpt55p old-chat", options), /Profile gpt55p was removed/)
})

test("/reset accepts exactly one configured profile", () => {
  const profiles = normalizeChatTemplates()
  assert.equal(parseResetProfileArg("", { chatTemplates: profiles }), null)
  assert.deepEqual(parseResetProfileArg("sol", { chatTemplates: profiles }), {
    chatTemplateName: "sol",
    chatTemplate: profiles.sol,
  })
  assert.equal(parseResetProfileArg("solm", { chatTemplates: profiles }).chatTemplate.model.variant, "medium")
  assert.equal(parseResetProfileArg("solh", { chatTemplates: profiles }).chatTemplate.model.variant, "high")
  assert.equal(parseResetProfileArg("solmax", { chatTemplates: profiles }).chatTemplate.model.variant, "max")
  assert.throws(() => parseResetProfileArg("unknown", { chatTemplates: profiles }), /Unknown profile unknown/)
  assert.throws(() => parseResetProfileArg("sol extra", { chatTemplates: profiles }), /Usage: \/reset \[profile\]/)
  assert.throws(() => parseResetProfileArg("gpt55p", { chatTemplates: profiles }), /Profile gpt55p was removed/)
})

test("/reset resolves optional profile and server overrides", () => {
  const profiles = normalizeChatTemplates()
  const servers = new Map([["nuc", { id: "nuc" }], ["dima", { id: "dima" }]])
  const options = { chatTemplates: profiles, servers }
  assert.deepEqual(parseResetArgs("", options), { chatTemplateName: null, chatTemplate: null, serverID: null })
  assert.deepEqual(parseResetArgs("dima", options), { chatTemplateName: null, chatTemplate: null, serverID: "dima" })
  assert.equal(parseResetArgs("solh", options).chatTemplate.model.variant, "high")
  assert.deepEqual(parseResetArgs("solh dima", options), { chatTemplateName: "solh", chatTemplate: profiles.solh, serverID: "dima" })
  assert.throws(() => parseResetArgs("solh unknown", options), /Unknown OpenCodez server: unknown/)
  assert.throws(() => parseResetArgs("unknown", options), /Unknown reset profile or server: unknown/)
  assert.throws(() => parseResetArgs("solh dima extra", options), /Usage: \/reset \[profile\] \[server\]/)
  assert.throws(() => parseResetArgs("solh", { chatTemplates: profiles, servers: new Map([["solh", { id: "solh" }]]) }), /ambiguous/)
})

test("managed topic titles add server suffix only for multi-server deployments", () => {
  const oneServer = new Map([["nuc", { id: "nuc" }]])
  const twoServers = new Map([["nuc", { id: "nuc" }], ["dima", { id: "dima" }]])
  assert.deepEqual(managedTopicTitle("opencodebot_t2", "nuc", oneServer), {
    topicBaseTitle: "opencodebot_t2",
    topicTitle: "opencodebot_t2",
    topicServerSuffixManaged: false,
  })
  assert.equal(managedTopicTitle("opencodebot_t2", "nuc", twoServers).topicTitle, "opencodebot_t2 (nuc)")
  assert.equal(managedTopicTitle("x".repeat(128), "dima", twoServers).topicTitle.length, 128)
  assert.equal(baseTitleFromTelegramTitle("opencodebot_t2 (dima)", "dima", twoServers), "opencodebot_t2")
})

test("OpenCodez System selection sends the current minimal payload", async (context) => {
  let received
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received = { method: request.method, url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ ok: true }))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))

  const address = server.address()
  const client = new OpenCodeClient({ opencode: { servers: [{ id: "test", url: `http://127.0.0.1:${address.port}` }], password: "test" } })
  await client.selectSystemPrompt("test", "ses_test", "codex_gpt_5_6_sol")

  assert.deepEqual(received, {
    method: "POST",
    url: "/opencodez/prompts/select",
    body: { sessionID: "ses_test", name: "codex_gpt_5_6_sol" },
  })
})
