import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { defaultArtifacts, normalizeArtifactUploads, normalizeArtifacts, normalizeAttachments } from "./config/artifacts.mjs"
import { normalizeChatTemplates } from "./config/chat-templates.mjs"
import { loadEnvFile, pickToken, pickValue, readFirstNumber, readNumberList, uniqueNumbers } from "./config/common.mjs"
import { readServers } from "./config/servers.mjs"
import { normalizeSpeechConfig } from "./config/speech.mjs"
import { normalizeTelegramBotApi } from "./config/telegram.mjs"

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
  const telegramBotApi = normalizeTelegramBotApi(config.telegram?.botApi, mergedEnv, projectRoot)
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
    speech: normalizeSpeechConfig(config.speech, env),
    chatTemplates: normalizeChatTemplates(config.chatTemplates),
    web: config.web || {},
    wireguard: {
      ...config.wireguard,
      stateDir: wireguardStateDir,
    },
  }
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

function resolveConfigPath(filePath, baseDir) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
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
