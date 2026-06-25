import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, "..")
const defaultConfigPath = path.join(projectRoot, "config.local.json")
const exampleConfigPath = path.join(projectRoot, "config.example.json")
const defaultHiddenTools = ["todo", "todowrite", "todo_write"]
const defaultMirror = { showReasoningSummaries: false, deletePinServiceMessages: true, pinUserPrompts: true, hiddenTools: defaultHiddenTools, toolBatchMaxLines: 12, editDebounceMs: 1200, maxTelegramChars: 3900 }
const defaultMultipartPrompts = { enabled: true, minChars: 3600, idleMs: 2000, maxParts: 20, maxChars: 120000 }
const defaultReconcile = { enabled: true, intervalMs: 15000, activeWindowMs: 2 * 60 * 60 * 1000, lookbackMs: 30000 }
const defaultPromptFeedback = { enabled: true, accepted: true, queued: true, errors: true }
const defaultFinalNotifications = { enabled: true, userIds: [], maxSentMarkers: 1000 }
const defaultArtifacts = {
  enabled: false,
  listenHost: "0.0.0.0",
  port: 8788,
  tokenEnvNames: ["OPENCODEBOT_ARTIFACT_TOKEN"],
  maxPayloadBytes: 75 * 1024 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
  maxTextChars: 3400,
  maxCaptionChars: 900,
}
const defaultAttachments = {
  enabled: true,
  mediaGroupIdleMs: 2000,
  promptIdleMs: 60000,
  maxFiles: 10,
  maxFileBytes: 20000000,
  maxTotalBytes: 60000000,
  cleanupAfterMs: 86400000,
}
const defaultChatTemplates = {
  d4flash: {
    agent: "build",
    model: { providerID: "deepseek", modelID: "deepseek-v4-flash", variant: "max" },
    opencodezTemplate: "gpt55",
  },
  d4pro: {
    agent: "build",
    model: { providerID: "deepseek", modelID: "deepseek-v4-pro", variant: "max" },
    opencodezTemplate: "gpt55",
  },
  gpt55p: {
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.5", variant: "xhigh" },
    opencodezTemplate: "gpt55",
  },
}

export function loadConfig(configPath = process.env.OPENCODEBOT_CONFIG || defaultConfigPath) {
  const requestedPath = path.resolve(configPath || defaultConfigPath)
  const sourcePath = fs.existsSync(requestedPath) ? requestedPath : exampleConfigPath
  const configDir = path.dirname(sourcePath)
  const config = readJson(sourcePath)
  const tokenEnvPath = resolveConfigPath(config.paths?.tokenEnv || "token.env", configDir)
  const serversJsonPath = resolveConfigPath(config.paths?.serversJson || "servers.example.json", configDir)
  const statePath = resolveConfigPath(config.paths?.statePath || path.join("state", "state.json"), configDir)
  const uploadsDir = resolveConfigPath(config.paths?.uploadsDir || path.join(path.dirname(statePath), "uploads"), configDir)
  const wireguardStateDir = resolveConfigPath(config.wireguard?.stateDir || path.join(path.dirname(statePath), "wireguard"), configDir)
  const env = loadEnvFile(tokenEnvPath)
  const mergedEnv = { ...env, ...process.env }
  const telegramToken = pickToken(mergedEnv, config.telegram?.tokenEnvNames || [])
  const allowedUserIds = uniqueNumbers([
    ...(config.telegram?.allowedUserIds || []),
    ...readNumberList(mergedEnv, config.telegram?.allowedUserEnvNames || []),
  ])
  const openCodePassword = pickValue(mergedEnv, config.opencode?.passwordEnvNames || [])
  const artifactToken = pickValue(mergedEnv, config.artifacts?.tokenEnvNames || defaultArtifacts.tokenEnvNames) || config.artifacts?.token
  const chatId = config.telegram?.chatId ?? readFirstNumber(mergedEnv, ["OPENCODEBOT_CHAT_ID", "TELEGRAM_CHAT_ID"])
  const servers = readServers(serversJsonPath)

  return {
    sourcePath,
    projectRoot,
    paths: {
      ...config.paths,
      tokenEnv: tokenEnvPath,
      serversJson: serversJsonPath,
      statePath,
      uploadsDir,
    },
    telegram: {
      chatId,
      allowChatBootstrap: config.telegram?.allowChatBootstrap === true,
      autocreateTopics: true,
      mirrorEnabled: true,
      randomTopicIcon: true,
      botUsername: config.telegram?.botUsername,
      token: telegramToken,
      allowedUserIds,
    },
    opencode: {
      ...config.opencode,
      password: openCodePassword,
      servers,
    },
    defaultPrompt: config.defaultPrompt || {},
    mirror: { ...defaultMirror },
    multipartPrompts: { ...defaultMultipartPrompts },
    reconcile: { ...defaultReconcile },
    promptFeedback: { ...defaultPromptFeedback },
    finalNotifications: normalizeFinalNotifications(config.finalNotifications),
    artifacts: normalizeArtifacts(config.artifacts, artifactToken),
    attachments: normalizeAttachments(config.attachments),
    chatTemplates: normalizeChatTemplates(config.chatTemplates),
    web: config.web || {},
    wireguard: {
      ...config.wireguard,
      stateDir: wireguardStateDir,
    },
  }
}

function resolveConfigPath(filePath, baseDir) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)
}

export function assertRuntimeConfig(config) {
  const errors = []
  if (!config.telegram.token) errors.push("Telegram bot token is missing")
  if (!config.telegram.allowedUserIds.length) errors.push("Allowed Telegram user id is missing")
  if (!config.opencode.servers.length) errors.push("OpenCodez servers list is empty")
  if (config.artifacts.enabled && !config.artifacts.token) errors.push("Artifact gateway token is missing")
  if (errors.length) throw new Error(errors.join("; "))
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function readServers(filePath) {
  const raw = readJson(filePath)
  const servers = Array.isArray(raw) ? raw : raw.servers
  if (!Array.isArray(servers)) return []
  return servers
    .filter((server) => server && server.id && server.url)
    .map((server) => ({
      id: String(server.id),
      url: String(server.url).replace(/\/$/, ""),
      home: server.home ? String(server.home) : undefined,
      label: server.label ? String(server.label) : String(server.id),
      offlineOk: Boolean(server.offline_ok),
    }))
}

function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {}
  const env = {}
  const text = fs.readFileSync(filePath, "utf8")
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const index = trimmed.indexOf("=")
    if (index === -1) continue
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function pickValue(env, names) {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && String(value).trim()) return String(value).trim()
  }
  return undefined
}

function pickToken(env, names) {
  const explicit = pickValue(env, names)
  if (explicit) return explicit
  for (const value of Object.values(env)) {
    const text = String(value).trim()
    if (/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(text)) return text
  }
  return undefined
}

function readNumberList(env, names) {
  const values = []
  for (const name of names) {
    const value = env[name]
    if (!value) continue
    for (const item of String(value).split(/[\s,]+/)) {
      if (/^-?\d+$/.test(item)) values.push(Number(item))
    }
  }
  if (!values.length) {
    for (const [key, value] of Object.entries(env)) {
      if (!/(USER|ALLOWED|OWNER).*ID/i.test(key)) continue
      if (/^-?\d+$/.test(String(value).trim())) values.push(Number(value))
    }
  }
  return values
}

function readFirstNumber(env, names) {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && /^-?\d+$/.test(String(value).trim())) return Number(value)
  }
  return null
}

function uniqueNumbers(values) {
  return [...new Set(values.map(Number).filter(Number.isSafeInteger))]
}

function normalizeStringList(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback
  return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))]
}

function normalizeFinalNotifications(value = {}) {
  return {
    enabled: value.enabled !== false,
    userIds: uniqueNumbers(value.userIds || []),
    maxSentMarkers: defaultFinalNotifications.maxSentMarkers,
  }
}

function normalizeArtifacts(value = {}, token) {
  return {
    enabled: value.enabled === true,
    listenHost: value.listenHost ? String(value.listenHost) : defaultArtifacts.listenHost,
    port: numberAtLeast(value.port, defaultArtifacts.port, 1),
    token,
    tokenEnvNames: normalizeStringList(value.tokenEnvNames, defaultArtifacts.tokenEnvNames),
    maxPayloadBytes: defaultArtifacts.maxPayloadBytes,
    maxFileBytes: defaultArtifacts.maxFileBytes,
    maxTextChars: defaultArtifacts.maxTextChars,
    maxCaptionChars: defaultArtifacts.maxCaptionChars,
  }
}

function normalizeAttachments() {
  return { ...defaultAttachments }
}

function normalizeChatTemplates(value = {}) {
  const merged = { ...defaultChatTemplates, ...(value || {}) }
  return Object.fromEntries(
    Object.entries(merged)
      .map(([name, template]) => [String(name).trim(), normalizeChatTemplate(template)])
      .filter(([name, template]) => name && template),
  )
}

function normalizeChatTemplate(template = {}) {
  const model = normalizeModel(template.model)
  if (!template.agent && !model && !template.opencodezTemplate) return null
  return {
    agent: template.agent ? String(template.agent) : undefined,
    model,
    opencodezTemplate: template.opencodezTemplate ? String(template.opencodezTemplate) : undefined,
  }
}

function normalizeModel(model) {
  if (!model) return undefined
  if (typeof model === "string") return { modelID: model }
  const providerID = model.providerID !== undefined ? String(model.providerID) : undefined
  const modelID = model.modelID !== undefined ? String(model.modelID) : undefined
  if (!modelID) return undefined
  const normalized = { providerID, modelID }
  if (model.variant) normalized.variant = String(model.variant)
  return normalized
}

function numberAtLeast(value, fallback, min) {
  const number = Number(value)
  return Number.isFinite(number) && number >= min ? Math.floor(number) : fallback
}
