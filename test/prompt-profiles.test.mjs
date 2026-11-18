import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { applyPromptProfile, parseNewTopicArgs, parseResetArgs, parseResetProfileArg } from "../src/prompt-profiles.mjs"
import { normalizePromptProfiles } from "../src/config/prompt-profiles.mjs"
import { OpenCodeClient, profileFromMessages } from "../src/opencode.mjs"
import { LaunchMenu } from "../src/launch-menu.mjs"
import { StateStore } from "../src/state.mjs"
import { baseTitleFromTelegramTitle, managedTopicTitle } from "../src/topic-titles.mjs"
import { UserSettings } from "../src/user-settings.mjs"

test("built-in prompt profiles use current models, variants, and System prompts", () => {
  const profiles = normalizePromptProfiles()

  assert.deepEqual(Object.keys(profiles).sort(), ["d4flash", "sol", "solm", "solx"])
  assert.deepEqual(profiles.d4flash, {
    agent: "build",
    model: { providerID: "deepseek", modelID: "deepseek-flash", variant: "max" },
    opencodezSystem: "default",
  })
  for (const [name, variant] of [["solm", "medium"], ["sol", "high"], ["solx", "xhigh"]]) {
    assert.deepEqual(profiles[name], {
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-6.2-sol", variant },
      opencodezSystem: "codex_gpt_6_2_sol",
    })
  }
  assert.deepEqual(profileFromMessages([{ info: { role: "user", agent: "build", model: profiles.sol.model } }]), {
    agent: "build",
    model: profiles.sol.model,
  })
})

test("startup upgrades saved built-ins once and preserves custom profiles and topic snapshots", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencodebot-profiles-"))
  context.after(() => rm(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, "state.json")
  const state = new StateStore(filePath)
  await state.load()
  const previous = (modelID, variant, opencodezSystem) => ({ agent: "build", model: { providerID: "openai", modelID, variant }, opencodezSystem })
  const sol = previous("gpt-6.1-sol", "high", "codex_gpt_6_1_sol")
  const solm = previous("gpt-6.1-sol", "medium", "file:my-sol")
  const solx = previous("gpt-6.1-sol", "low", "codex_gpt_6_1_sol")
  await state.update((data) => {
    data.preferences = {
      version: 1,
      profiles: { sol, solm, solx, copy: sol, gpt6m: previous("gpt-6-astra", "medium", "codex_gpt_6_astra") },
      deletedProfiles: {
        solmax: previous("gpt-6.1-sol", "max", "builtin:codex_gpt_6_1_sol"),
        terra: previous("gpt-5.6-terra", "xhigh", "codex_gpt_5_6_luna_terra"),
      },
      defaultProfile: "sol",
      defaultLaunch: { agent: "build" },
      recentProfiles: ["solx", "sol"],
    }
  })
  await state.bindTopic({ chatId: -1001, topicId: 12, serverID: "local", sessionID: "ses_test", promptProfileName: "sol", promptProfile: sol })
  await state.addPendingTopic(13, { chatId: -1001, serverID: "local", promptProfileName: "sol", promptProfile: sol })
  const start = async () => {
    const loaded = new StateStore(filePath)
    await loaded.load()
    const config = { promptProfiles: normalizePromptProfiles(), defaultPrompt: { serverID: "local" }, artifacts: {}, finalNotifications: { userIds: [1] } }
    const settings = new UserSettings({ config, state: loaded })
    await settings.initialize()
    return settings
  }
  const settings = await start()
  assert.deepEqual(settings.data.profiles.sol, normalizePromptProfiles().sol)
  assert.equal(settings.config.defaultPrompt.model.modelID, "gpt-6.2-sol")
  assert.deepEqual(settings.data.profiles.gpt6m, previous("gpt-6.2-astra", "medium", "codex_gpt_6_2_astra"))
  assert.deepEqual(settings.data.profiles.solm, solm)
  assert.deepEqual(settings.data.profiles.solx, solx)
  assert.deepEqual(settings.data.profiles.copy, sol)
  assert.deepEqual(settings.data.recentProfiles, ["solx", "sol"])
  assert.deepEqual(settings.state.data.bindings[0].promptProfile, sol)
  assert.deepEqual(settings.state.pendingTopic(13, -1001).promptProfile, sol)
  assert.deepEqual(settings.data.deletedProfiles.terra, previous("gpt-6.1-terra", "xhigh", "codex_gpt_6_1_terra"))
  assert.equal(settings.data.profiles.solmax, undefined)
  await settings.restoreProfile("solmax")
  assert.deepEqual(settings.data.profiles.solmax, previous("gpt-6.2-sol", "max", "builtin:codex_gpt_6_2_sol"))

  await settings.saveProfile("sol", sol, "sol")
  assert.deepEqual((await start()).data.profiles.sol, sol)
})

test("launch System names resolve to catalog IDs while missing prompts remain blocked", async () => {
  const profiles = normalizePromptProfiles()
  const catalog = {
    models: [{ providerID: "openai", id: "gpt-6.2-sol", variants: ["low", "medium", "high", "xhigh", "max"] }],
    entries: [
      { id: "builtin:codex_gpt_6_2_sol", name: "Codex · GPT-6.2 Sol" },
      { id: "builtin:review", name: "Builtin review" },
      { id: "file:review", name: "My review" },
      { id: "saved:review", name: "Saved review" },
    ],
  }
  const menu = new LaunchMenu({ settings: { catalog: async () => catalog } })
  for (const [name, expected] of [
    ["codex_gpt_6_2_sol", "builtin:codex_gpt_6_2_sol"],
    ["builtin:codex_gpt_6_2_sol", "builtin:codex_gpt_6_2_sol"],
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
    ["system", "nuc", "ses_test", "codex_gpt_6_2_sol", {}],
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
  await client.selectSystemPrompt("test", "ses_test", "codex_gpt_6_2_sol")

  assert.deepEqual(received, {
    method: "POST",
    url: "/opencodez/prompts/select",
    body: { sessionID: "ses_test", name: "codex_gpt_6_2_sol" },
  })
})
