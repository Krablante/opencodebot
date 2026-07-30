import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import { applyPromptProfile, parseNewTopicArgs, parseResetArgs, parseResetProfileArg } from "../src/prompt-profiles.mjs"
import { normalizePromptProfiles } from "../src/config/prompt-profiles.mjs"
import { OpenCodeClient, profileFromMessages } from "../src/opencode.mjs"
import { baseTitleFromTelegramTitle, managedTopicTitle } from "../src/topic-titles.mjs"

test("built-in prompt profiles use current models, variants, and System prompts", () => {
  const profiles = normalizePromptProfiles()

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

test("/new resolves a profile and preserves an unknown token as title text", async () => {
  const profiles = normalizePromptProfiles()
  const options = { servers: new Map([["nuc", {}]]), defaultServerID: "nuc", promptProfiles: profiles }
  const parsed = parseNewTopicArgs("nuc sol opencodebot-first", options)

  assert.equal(parsed.promptProfileName, "sol")
  assert.equal(parsed.title, "opencodebot-first")
  assert.equal(parseNewTopicArgs("solm medium-work", options).promptProfile.model.variant, "medium")
  assert.equal(parseNewTopicArgs("solh high-work", options).promptProfile.model.variant, "high")
  assert.equal(parseNewTopicArgs("solmax max-work", options).promptProfile.model.variant, "max")

  const calls = []
  await applyPromptProfile({
    switchSessionModel: (...args) => calls.push(["model", ...args]),
    selectSystemPrompt: (...args) => calls.push(["system", ...args]),
  }, "nuc", "ses_test", parsed.promptProfile)
  assert.deepEqual(calls, [
    ["model", "nuc", "ses_test", profiles.sol.model, {}],
    ["system", "nuc", "ses_test", "codex_gpt_5_6_sol", {}],
  ])
  assert.equal(parseNewTopicArgs("nuc custom-token old-chat", options).title, "custom-token old-chat")
})

test("/reset accepts exactly one configured profile", () => {
  const profiles = normalizePromptProfiles()
  assert.equal(parseResetProfileArg("", { promptProfiles: profiles }), null)
  assert.deepEqual(parseResetProfileArg("sol", { promptProfiles: profiles }), {
    promptProfileName: "sol",
    promptProfile: profiles.sol,
  })
  assert.equal(parseResetProfileArg("solm", { promptProfiles: profiles }).promptProfile.model.variant, "medium")
  assert.equal(parseResetProfileArg("solh", { promptProfiles: profiles }).promptProfile.model.variant, "high")
  assert.equal(parseResetProfileArg("solmax", { promptProfiles: profiles }).promptProfile.model.variant, "max")
  assert.throws(() => parseResetProfileArg("unknown", { promptProfiles: profiles }), /Unknown profile unknown/)
  assert.throws(() => parseResetProfileArg("sol extra", { promptProfiles: profiles }), /Usage: \/reset \[profile\]/)
})

test("/reset resolves optional profile and server overrides", () => {
  const profiles = normalizePromptProfiles()
  const servers = new Map([["nuc", { id: "nuc" }], ["dima", { id: "dima" }]])
  const options = { promptProfiles: profiles, servers }
  assert.deepEqual(parseResetArgs("", options), { promptProfileName: null, promptProfile: null, serverID: null })
  assert.deepEqual(parseResetArgs("dima", options), { promptProfileName: null, promptProfile: null, serverID: "dima" })
  assert.equal(parseResetArgs("solh", options).promptProfile.model.variant, "high")
  assert.deepEqual(parseResetArgs("solh dima", options), { promptProfileName: "solh", promptProfile: profiles.solh, serverID: "dima" })
  assert.throws(() => parseResetArgs("solh unknown", options), /Unknown OpenCodez server: unknown/)
  assert.throws(() => parseResetArgs("unknown", options), /Unknown reset profile or server: unknown/)
  assert.throws(() => parseResetArgs("solh dima extra", options), /Usage: \/reset \[profile\] \[server\]/)
  assert.throws(() => parseResetArgs("solh", { promptProfiles: profiles, servers: new Map([["solh", { id: "solh" }]]) }), /ambiguous/)
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

test("OpenCodez client sends the configured Basic Auth username", async (context) => {
  let authorization
  const server = createServer((request, response) => {
    authorization = request.headers.authorization
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify([]))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))

  const address = server.address()
  const client = new OpenCodeClient({
    opencode: {
      servers: [{ id: "test", url: `http://127.0.0.1:${address.port}` }],
      username: "atlas",
      password: "secret",
    },
  })
  await client.listSessions("test")

  assert.equal(authorization, `Basic ${Buffer.from("atlas:secret").toString("base64")}`)
})
