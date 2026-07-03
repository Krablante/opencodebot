import { normalizeStringList, numberAtLeast } from "./common.mjs"
import { telegramLocalMaxFileBytes } from "./telegram.mjs"

export const defaultArtifacts = {
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

export function normalizeArtifacts(value = {}, token, botApi = { local: false }) {
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

export function normalizeAttachments(value = {}, botApi = { local: false }) {
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

export function normalizeArtifactUploads(value = {}, opencodeDefaultServerId = "") {
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
