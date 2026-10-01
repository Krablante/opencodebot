import fs from "node:fs/promises"
import path from "node:path"
import { withRequestTimeout } from "./request-timeout.mjs"
import { randomBytes } from "node:crypto"

// Telegram owns preferences after the one-time import. Configuration stays an installation seed.
export class UserSettings {
  constructor({ config, state, opencode }) {
    this.config = config
    this.state = state
    this.opencode = opencode
    this.catalogs = new Map()
    this.secretPath = path.join(path.dirname(state.filePath), "provider-secrets.json")
  }

  async initialize() {
    if (!this.state.data.preferences) {
      const existing = Boolean(this.state.data.bindings?.length || this.state.controlMenuMessage())
      const profiles = { ...(existing ? migratedDefaults() : {}), ...this.config.promptProfiles }
      const defaultName = Object.entries(profiles).find(([, p]) => JSON.stringify(p.model) === JSON.stringify(this.config.defaultPrompt.model))?.[0]
      await this.state.update((data) => {
        data.preferences = { version: 1, profiles, deletedProfiles: {}, defaultProfile: defaultName || (existing ? null : "sol"), defaultLaunch: structuredClone(this.config.defaultPrompt), recentProfiles: [] }
        for (const binding of data.bindings || []) {
          if (binding.promptProfileName && !binding.promptProfile) binding.promptProfile = structuredClone(profiles[binding.promptProfileName] || { agent: binding.agent, model: binding.model })
        }
      })
    }
    this.apply()
    this.secrets = {}
    try {
      const text = await fs.readFile(this.secretPath, "utf8")
      try { this.secrets = JSON.parse(text) } catch { throw new Error("Invalid provider-secrets.json document") }
      if (!this.secrets || typeof this.secrets !== "object" || Array.isArray(this.secrets)) throw new Error("Invalid provider-secrets.json document")
    } catch (error) { if (error.code !== "ENOENT") throw error }
    if (this.secrets.groq) this.applyGroqKey(this.secrets.groq)
    if (this.secrets.artifactToken) this.config.artifacts.token = this.secrets.artifactToken
    if (this.data.artifactsEnabled) this.config.artifacts.enabled = true
    if (this.data.gatewayUrl) this.config.artifacts.gatewayUrl = this.data.gatewayUrl
    // One operator id is enough: notifications no longer have a second recipient configuration.
    if (!this.config.finalNotifications.userIds.length) this.config.finalNotifications.userIds = [...this.config.telegram.allowedUserIds]
  }

  get data() { return this.state.data.preferences }

  apply() {
    // Profile names are data, including valid names such as constructor/toString.
    // Normalize both dictionaries after JSON load so inherited properties never
    // become launch profiles or archived entries.
    Object.setPrototypeOf(this.data.profiles, null)
    Object.setPrototypeOf(this.data.deletedProfiles, null)
    this.config.promptProfiles = this.data.profiles
    const selected = this.data.profiles[this.data.defaultProfile]
    if (selected) this.config.defaultPrompt = { ...this.config.defaultPrompt, ...selected, profileName: this.data.defaultProfile }
    else this.config.defaultPrompt = { ...(this.data.defaultLaunch || { agent: "build" }), serverID: this.config.defaultPrompt.serverID }
  }

  async saveProfile(name, profile, previousName, restoring = false) {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u.test(name)) throw Object.assign(new Error("Use 1–40 letters, digits, _ or - for the profile name."), { code: "PROFILE_NAME" })
    if (name !== previousName && this.data.profiles[name]) throw Object.assign(new Error("A profile with this name already exists."), { code: "PROFILE_EXISTS" })
    if (!restoring && this.data.deletedProfiles[name]) throw Object.assign(new Error("This name is in Deleted. Restore it first or choose another name."), { code: "PROFILE_ARCHIVED" })
    await this.state.update((data) => {
      data.preferences.profiles[name] = structuredClone(profile)
      delete data.preferences.deletedProfiles[name]
      if (previousName && previousName !== name) {
        delete data.preferences.profiles[previousName]
        if (data.preferences.defaultProfile === previousName) data.preferences.defaultProfile = name
        data.preferences.recentProfiles = data.preferences.recentProfiles.map((id) => id === previousName ? name : id)
        for (const topic of [...(data.bindings || []), ...Object.values(data.pendingTopics || {})]) {
          if (topic.promptProfileName === previousName) topic.promptProfileName = name
        }
      }
    })
    this.apply()
  }

  async deleteProfile(name) {
    if (!this.data.profiles[name]) return
    await this.state.update((data) => {
      data.preferences.deletedProfiles[name] = data.preferences.profiles[name]
      delete data.preferences.profiles[name]
      if (data.preferences.defaultProfile === name) {
        data.preferences.defaultProfile = Object.keys(data.preferences.profiles)[0] || null
        if (!data.preferences.defaultProfile) data.preferences.defaultLaunch = { agent: "build" }
      }
      data.preferences.recentProfiles = data.preferences.recentProfiles.filter((id) => id !== name)
    })
    this.apply()
  }

  async restoreProfile(name) {
    const profile = this.data.deletedProfiles[name]
    if (profile) await this.saveProfile(name, profile, undefined, true)
  }

  async setDefault(name) {
    if (!this.data.profiles[name]) throw new Error("Profile is unavailable")
    await this.state.update((data) => { data.preferences.defaultProfile = name })
    this.apply()
  }

  async used(name) {
    if (!name || !this.data.profiles[name] || this.data.recentProfiles[0] === name) return
    await this.state.updateDeferred((data) => { data.preferences.recentProfiles = [name, ...data.preferences.recentProfiles.filter((id) => id !== name)].slice(0, 8) })
  }

  profiles() {
    const recent = this.data.recentProfiles
    return Object.entries(this.data.profiles).sort(([a], [b]) => {
      const ai = recent.indexOf(a), bi = recent.indexOf(b)
      return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi) || a.localeCompare(b)
    })
  }

  launchProfileName() {
    const savedModel = this.data.defaultLaunch?.model
    const matching = savedModel?.modelID && Object.entries(this.data.profiles)
      .find(([, profile]) => JSON.stringify(profile.model) === JSON.stringify(savedModel))?.[0]
    const candidates = [this.data.defaultProfile, matching, ...this.data.recentProfiles, "sol", ...Object.keys(this.data.profiles)]
    return candidates.find((name) => this.data.profiles[name]?.model?.providerID && this.data.profiles[name]?.model?.modelID) || null
  }

  async catalog(serverID, directory = "", refresh = false) {
    const key = `${serverID}:${directory}`
    const existing = this.catalogs.get(key)
    if (!refresh && existing && Date.now() - existing.at < 60_000) return existing.promise
    const promise = this.opencode.request(this.opencode.server(serverID), "/opencodez/library", { directory, timeoutMs: 15_000 })
      .then((result) => ({ ...result, models: result.models || [] }))
      .catch((error) => { if (this.catalogs.get(key)?.promise === promise) this.catalogs.delete(key); throw error })
    this.catalogs.set(key, { at: Date.now(), promise })
    if (this.catalogs.size > 16) this.catalogs.delete(this.catalogs.keys().next().value)
    return promise
  }

  async storeGroqKey(key) {
    const valid = await withRequestTimeout({ timeoutMs: 15_000 }, async (signal) => {
      const response = await fetch("https://api.groq.com/openai/v1/models", { signal, headers: { authorization: `Bearer ${key}` } })
      if (!response.ok) return false
      const body = await response.json()
      return body.data?.some((model) => model.id === "whisper-large-v3-turbo")
    }, "Groq key check")
    if (!valid) throw new Error("Groq rejected the key or Whisper V3 Turbo is unavailable.")
    await this.saveSecrets({ groq: key })
    this.applyGroqKey(key)
  }

  saveSecrets(patch) {
    const operation = (this.secretOperation || Promise.resolve()).then(async () => {
      const next = { ...this.secrets, ...patch }
      await fs.mkdir(path.dirname(this.secretPath), { recursive: true, mode: 0o700 })
      const temp = `${this.secretPath}.${process.pid}.tmp`
      await fs.writeFile(temp, JSON.stringify(next) + "\n", { mode: 0o600, flush: true })
      await fs.rename(temp, this.secretPath)
      this.secrets = next
    })
    this.secretOperation = operation.catch(() => {})
    return operation
  }

  async enableArtifacts() {
    if (!this.config.artifacts.token) {
      const token = randomBytes(32).toString("hex")
      await this.saveSecrets({ artifactToken: token })
      this.config.artifacts.token = token
    }
    await this.state.update((data) => { data.preferences.artifactsEnabled = true })
    this.config.artifacts.enabled = true
  }

  async setGatewayUrl(value) {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTP(S) gateway origin without credentials, query or fragment.")
    await this.state.update((data) => { data.preferences.gatewayUrl = value.replace(/\/$/, "") })
    this.config.artifacts.gatewayUrl = this.data.gatewayUrl
  }

  applyGroqKey(key) {
    this.config.speech.enabled = true
    this.config.speech.defaultModel = "groq/whisper-large-v3-turbo"
    this.config.speech.providers.groq.apiKey = key
    if (!this.config.speech.models.some((m) => m.id === "groq/whisper-large-v3-turbo")) {
      const inherited = this.config.speech.models[0] || {}
      this.config.speech.models.push({ id: "groq/whisper-large-v3-turbo", apiProvider: "groq", apiModel: "whisper-large-v3-turbo",
        label: "Whisper Large V3 Turbo", provider: "Groq", language: inherited.language ?? null, temperature: inherited.temperature ?? 0, responseFormat: inherited.responseFormat || "json", prompt: inherited.prompt || "" })
    }
  }
}

function migratedDefaults() {
  const model = (id, variant, system) => ({ agent: "build", model: { providerID: "openai", modelID: id, variant }, opencodezSystem: system })
  return {
    d4pro: { agent: "build", model: { providerID: "deepseek", modelID: "deepseek-v4-pro", variant: "max" }, opencodezSystem: "default" },
    luna: model("gpt-6-luna", "xhigh", "codex_gpt_6_luna"), lunah: model("gpt-6-luna", "high", "codex_gpt_6_luna"), lunamax: model("gpt-6-luna", "max", "codex_gpt_6_luna"),
    terra: model("gpt-5.6-terra", "xhigh", "codex_gpt_5_6_luna_terra"),
    gpt6: model("gpt-6-astra", "high", "codex_gpt_6_astra"), gpt6m: model("gpt-6-astra", "medium", "codex_gpt_6_astra"),
    solh: model("gpt-6.1-sol", "high", "codex_gpt_6_1_sol"), solmax: model("gpt-6.1-sol", "max", "codex_gpt_6_1_sol"),
  }
}
