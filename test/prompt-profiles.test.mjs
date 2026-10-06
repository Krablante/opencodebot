import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import { applyPromptProfile, parseNewTopicArgs, parseResetArgs, parseResetProfileArg } from "../src/prompt-profiles.mjs"
import { normalizePromptProfiles } from "../src/config/prompt-profiles.mjs"
import { OpenCodeClient, profileFromMessages } from "../src/opencode.mjs"
import { LaunchMenu } from "../src/launch-menu.mjs"
import { baseTitleFromTelegramTitle, managedTopicTitle } from "../src/topic-titles.mjs"

test("built-in prompt profiles use current models, variants, and System prompts", () => {
  const profiles = normalizePromptProfiles()

  assert.deepEqual(Object.keys(profiles).sort(), ["d4flash", "sol", "solm", "solx"])
  assert.deepEqual(profiles.sol, {
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-6.1-sol", variant: "high" },
    opencodezSystem: "codex_gpt_6_1_sol",
  })
  assert.deepEqual(profiles.d4flash, {
    agent: "build",
    model: { providerID: "deepseek", modelID: "deepseek-flash", variant: "max" },
    opencodezSystem: "default",
  })
  for (const [name, variant] of [["solm", "medium"], ["sol", "high"], ["solx", "xhigh"]]) {
    assert.deepEqual(profiles[name], {
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-6.1-sol", variant },
      opencodezSystem: "codex_gpt_6_1_sol",
    })
  }
  assert.deepEqual(profileFromMessages([{ info: { role: "user", agent: "build", model: profiles.sol.model } }]), {
    agent: "build",
    model: profiles.sol.model,
  })
})

test("launch System names resolve to catalog IDs while missing prompts remain blocked", async () => {
  const profiles = normalizePromptProfiles()
  const catalog = {
    models: [{ providerID: "openai", id: "gpt-6.1-sol", variants: ["medium", "high", "xhigh"] }],
    entries: [
      { id: "builtin:codex_gpt_6_1_sol", name: "Codex · GPT-6.1 Sol" },
      { id: "builtin:review", name: "Builtin review" },
      { id: "file:review", name: "My review" },
      { id: "saved:review", name: "Saved review" },
    ],
  }
  const menu = new LaunchMenu({ settings: { catalog: async () => catalog } })
  for (const [name, expected] of [
    ["codex_gpt_6_1_sol", "builtin:codex_gpt_6_1_sol"],
    ["builtin:codex_gpt_6_1_sol", "builtin:codex_gpt_6_1_sol"],
    ["review", "file:review"],
    ["builtin:review", "builtin:review"],
    ["saved:review", "saved:review"],
    ["Saved review", "saved:review"],
    ["default", "default"],
    ["none", "none"],
  ]) {
    const profile = { ...structuredClone(profiles.sol), opencodezSystem: name }
    await menu.validate({ serverID: "local" }, profile)
    assert.equal(profile.opencodezSystem, expected)
  }
  await assert.rejects(menu.validate({ serverID: "local" }, {
    ...structuredClone(profiles.sol), opencodezSystem: "missing-prompt",
  }), /System prompt/)
})

test("/new resolves a profile and preserves an unknown token as title text", async () => {
  const profiles = normalizePromptProfiles()
  const options = { servers: new Map([["nuc", {}]]), defaultServerID: "nuc", promptProfiles: profiles }
  const parsed = parseNewTopicArgs("nuc sol opencodebot-first", options)

  assert.equal(parsed.promptProfileName, "sol")
  assert.equal(parsed.title, "opencodebot-first")
  assert.equal(parseNewTopicArgs("solm medium-work", options).promptProfile.model.variant, "medium")
  assert.equal(parseNewTopicArgs("sol high-work", options).promptProfile.model.variant, "high")
  assert.equal(parseNewTopicArgs("solx xhigh-work", options).promptProfile.model.variant, "xhigh")

  const calls = []
  await applyPromptProfile({
    switchSessionModel: (...args) => calls.push(["model", ...args]),
    selectSystemPrompt: (...args) => calls.push(["system", ...args]),
  }, "nuc", "ses_test", parsed.promptProfile)
  assert.deepEqual(calls, [
    ["model", "nuc", "ses_test", profiles.sol.model, {}],
    ["system", "nuc", "ses_test", "codex_gpt_6_1_sol", {}],
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
  assert.equal(parseResetProfileArg("sol", { promptProfiles: profiles }).promptProfile.model.variant, "high")
  assert.equal(parseResetProfileArg("solx", { promptProfiles: profiles }).promptProfile.model.variant, "xhigh")
  assert.throws(() => parseResetProfileArg("unknown", { promptProfiles: profiles }), /Unknown profile unknown/)
  assert.throws(() => parseResetProfileArg("sol extra", { promptProfiles: profiles }), /Usage: \/reset \[profile\]/)
})

test("/reset resolves optional profile and server overrides", () => {
  const profiles = normalizePromptProfiles()
  const servers = new Map([["nuc", { id: "nuc" }], ["dima", { id: "dima" }]])
  const options = { promptProfiles: profiles, servers }
  assert.deepEqual(parseResetArgs("", options), { promptProfileName: null, promptProfile: null, serverID: null })
  assert.deepEqual(parseResetArgs("dima", options), { promptProfileName: null, promptProfile: null, serverID: "dima" })
  assert.equal(parseResetArgs("sol", options).promptProfile.model.variant, "high")
  assert.deepEqual(parseResetArgs("sol dima", options), { promptProfileName: "sol", promptProfile: profiles.sol, serverID: "dima" })
  assert.throws(() => parseResetArgs("sol unknown", options), /Unknown OpenCodez server: unknown/)
  assert.throws(() => parseResetArgs("unknown", options), /Unknown reset profile or server: unknown/)
  assert.throws(() => parseResetArgs("sol dima extra", options), /Usage: \/reset \[profile\] \[server\]/)
  assert.throws(() => parseResetArgs("sol", { promptProfiles: profiles, servers: new Map([["sol", { id: "sol" }]]) }), /ambiguous/)
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
  await client.selectSystemPrompt("test", "ses_test", "codex_gpt_6_1_sol")

  assert.deepEqual(received, {
    method: "POST",
    url: "/opencodez/prompts/select",
    body: { sessionID: "ses_test", name: "codex_gpt_6_1_sol" },
  })
})
