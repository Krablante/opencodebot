import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import { applyChatTemplate, parseNewTopicArgs, parseResetProfileArg } from "../src/chat-templates.mjs"
import { normalizeChatTemplates } from "../src/config/chat-templates.mjs"
import { OpenCodeClient, profileFromMessages } from "../src/opencode.mjs"

test("built-in chat profiles use current models, variants, and System prompts", () => {
  const profiles = normalizeChatTemplates()

  assert.deepEqual(Object.keys(profiles).sort(), ["d4flash", "d4pro", "luna", "sol", "terra"])
  assert.deepEqual(profiles.sol, {
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "xhigh" },
    opencodezSystem: "codex_gpt_5_6_sol",
  })
  assert.equal(profiles.luna.opencodezSystem, "codex_gpt_5_6_luna_terra")
  assert.equal(profiles.terra.opencodezSystem, "codex_gpt_5_6_luna_terra")
  assert.equal(profiles.d4flash.opencodezSystem, "default")
  assert.equal(profiles.d4pro.opencodezSystem, "default")
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
  assert.throws(() => parseResetProfileArg("unknown", { chatTemplates: profiles }), /Unknown profile unknown/)
  assert.throws(() => parseResetProfileArg("sol extra", { chatTemplates: profiles }), /Usage: \/reset \[profile\]/)
  assert.throws(() => parseResetProfileArg("gpt55p", { chatTemplates: profiles }), /Profile gpt55p was removed/)
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
