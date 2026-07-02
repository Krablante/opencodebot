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
const telegramCloudRootUrl = "https://api.telegram.org"
const telegramLocalRootUrl = "http://telegram-bot-api:8081"
const telegramLocalFilesRoot = "/var/lib/telegram-bot-api"
const telegramLocalSpoolDir = path.join(telegramLocalFilesRoot, "opencodebot-spool")
const telegramLocalMaxFileBytes = 2_000_000_000
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
  maxInlineBytes: 20000000,
  cleanupAfterMs: 86400000,
}
const defaultArtifactUploads = {
  enabled: true,
  root: "~/trash",
  defaultServerId: "",
  dateFolders: true,
  mediaGroupIdleMs: 1200,
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
  const telegramBotApi = normalizeTelegramBotApi(config.telegram?.botApi, mergedEnv)
  const attachmentConfig = config.attachments ?? config.telegram?.attachments

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
      botApi: telegramBotApi,
    },
    opencode: {
      ...normalizeOpencode(config.opencode),
      password: openCodePassword,
      servers,
    },
    defaultPrompt: config.defaultPrompt || {},
    mirror: { ...defaultMirror },
    multipartPrompts: { ...defaultMultipartPrompts },
    reconcile: { ...defaultReconcile },
    promptFeedback: { ...defaultPromptFeedback },
    finalNotifications: normalizeFinalNotifications(config.finalNotifications),
    artifacts: normalizeArtifacts(config.artifacts, artifactToken, telegramBotApi),
    artifactUploads: normalizeArtifactUploads(config.artifactUploads, config.opencode?.defaultServerId || config.defaultPrompt?.serverID),
    attachments: normalizeAttachments(attachmentConfig, telegramBotApi),
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
  if (config.telegram.botApi.mode === "local") {
    if (!config.telegram.botApi.apiIdPresent) errors.push("TELEGRAM_API_ID is required for local Telegram Bot API mode")
    if (!config.telegram.botApi.apiHashPresent) errors.push("TELEGRAM_API_HASH is required for local Telegram Bot API mode")
    if (!path.isAbsolute(config.telegram.botApi.localFilesRoot)) errors.push("telegram.botApi.localFilesRoot must be an absolute path")
    if (!path.isAbsolute(config.telegram.botApi.spoolDir)) errors.push("telegram.botApi.spoolDir must be an absolute path")
  }
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
    .map(normalizeServer)
}

function normalizeServer(server) {
  const home = server.home ? String(server.home) : undefined
  const uploadRoot = server.uploadRoot ? String(server.uploadRoot) : defaultUploadRoot(home)
  const pathStyle = normalizePathStyle(server.pathStyle || server.transfer?.pathStyle || inferPathStyle(uploadRoot || home))
  return {
    id: String(server.id),
    url: String(server.url).replace(/\/$/, ""),
    home,
    uploadRoot,
    artifactUploadRoot: server.artifactUploadRoot ? String(server.artifactUploadRoot) : undefined,
    pathStyle,
    transfer: normalizeTransfer(server.transfer, pathStyle),
    label: server.label ? String(server.label) : String(server.id),
    offlineOk: Boolean(server.offline_ok),
  }
}

function normalizeTransfer(value = {}, pathStyle = "posix") {
  const type = value.type === "ssh" ? "ssh" : "local"
  const transfer = { ...value, type, pathStyle }
  if (type === "ssh") {
    if (value.host) transfer.host = String(value.host)
    if (value.user) transfer.user = String(value.user)
    if (value.port) transfer.port = Number(value.port)
    if (value.identityFile) transfer.identityFile = String(value.identityFile)
  }
  return transfer
}

function defaultUploadRoot(home) {
  if (!home) return undefined
  const style = inferPathStyle(home)
  const separator = style === "windows" ? "\\" : "/"
  return `${String(home).replace(/[\\/]+$/, "")}${separator}.opencodebot${separator}uploads`
}

function inferPathStyle(value = "") {
  const text = String(value)
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\")) return "windows"
  return "posix"
}

function normalizePathStyle(value) {
  return value === "windows" ? "windows" : "posix"
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

function normalizeOpencode(value = {}) {
  const mirrorScope = value.mirrorScope === "serverHome" || value.mirrorScope === "global"
    ? value.mirrorScope
    : value.useServerHomeAsDirectory === true
      ? "serverHome"
      : "global"
  const newSessionDefaultDirectory = value.newSessionDefaultDirectory === "none" ? "none" : "serverHome"
  return {
    ...value,
    mirrorScope,
    newSessionDefaultDirectory,
  }
}

function normalizeFinalNotifications(value = {}) {
  return {
    enabled: value.enabled !== false,
    userIds: uniqueNumbers(value.userIds || []),
    maxSentMarkers: defaultFinalNotifications.maxSentMarkers,
  }
}

function normalizeTelegramBotApi(value = {}, env = {}) {
  const mode = value?.mode === "local" ? "local" : "cloud"
  const rootUrl = trimTrailingSlash(value?.rootUrl || value?.apiBaseUrl || env.TELEGRAM_BOT_API_ROOT_URL || (mode === "local" ? telegramLocalRootUrl : telegramCloudRootUrl))
  const fileRootUrl = trimTrailingSlash(value?.fileRootUrl || env.TELEGRAM_BOT_API_FILE_ROOT_URL || rootUrl)
  const localFilesRoot = normalizeAbsolute(value?.localFilesRoot || env.TELEGRAM_BOT_API_LOCAL_FILES_ROOT || telegramLocalFilesRoot)
  const spoolDir = normalizeAbsolute(value?.spoolDir || env.OPENCODEBOT_ARTIFACT_SPOOL_DIR || (mode === "local" ? telegramLocalSpoolDir : path.join(projectRoot, "state", "artifacts")))
  return {
    mode,
    rootUrl,
    fileRootUrl,
    localFilesRoot,
    spoolDir,
    local: mode === "local",
    apiIdPresent: Boolean(env.TELEGRAM_API_ID),
    apiHashPresent: Boolean(env.TELEGRAM_API_HASH),
  }
}

function normalizeArtifacts(value = {}, token, botApi = { local: false }) {
  const maxFileBytes = botApi.local ? telegramLocalMaxFileBytes : defaultArtifacts.maxFileBytes
  return {
    enabled: value.enabled === true,
    listenHost: value.listenHost ? String(value.listenHost) : defaultArtifacts.listenHost,
    port: numberAtLeast(value.port, defaultArtifacts.port, 1),
    token,
    tokenEnvNames: normalizeStringList(value.tokenEnvNames, defaultArtifacts.tokenEnvNames),
    maxPayloadBytes: defaultArtifacts.maxPayloadBytes,
    maxFileBytes,
    maxTextChars: defaultArtifacts.maxTextChars,
    maxCaptionChars: defaultArtifacts.maxCaptionChars,
  }
}

function normalizeAttachments(value = {}, botApi = { local: false }) {
  const fileLimit = botApi.local ? telegramLocalMaxFileBytes : defaultAttachments.maxFileBytes
  const maxFileBytes = Math.min(numberAtLeast(value.maxFileBytes, botApi.local ? telegramLocalMaxFileBytes : defaultAttachments.maxFileBytes, 1), fileLimit)
  const maxTotalBytes = Math.min(numberAtLeast(value.maxTotalBytes, botApi.local ? telegramLocalMaxFileBytes : defaultAttachments.maxTotalBytes, 1), telegramLocalMaxFileBytes)
  return {
    ...defaultAttachments,
    ...value,
    enabled: value.enabled !== false,
    mediaGroupIdleMs: numberAtLeast(value.mediaGroupIdleMs, defaultAttachments.mediaGroupIdleMs, 100),
    promptIdleMs: numberAtLeast(value.promptIdleMs, defaultAttachments.promptIdleMs, 1000),
    maxFiles: numberAtLeast(value.maxFiles, defaultAttachments.maxFiles, 1),
    maxFileBytes,
    maxTotalBytes,
    maxInlineBytes: numberAtLeast(value.maxInlineBytes, defaultAttachments.maxInlineBytes, 1),
  }
}

function normalizeArtifactUploads(value = {}, opencodeDefaultServerId = "") {
  return {
    ...defaultArtifactUploads,
    ...value,
    enabled: value.enabled !== false,
    root: String(value.root || defaultArtifactUploads.root),
    defaultServerId: value.defaultServerId ? String(value.defaultServerId) : String(opencodeDefaultServerId || defaultArtifactUploads.defaultServerId),
    dateFolders: value.dateFolders !== false,
    mediaGroupIdleMs: numberAtLeast(value.mediaGroupIdleMs, defaultArtifactUploads.mediaGroupIdleMs, 250),
  }
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

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "")
}

function normalizeAbsolute(value) {
  return path.resolve(String(value || "."))
}
