export function parseNewTopicArgs(args, { servers, defaultServerID, promptProfiles }) {
  const parts = tokenizeNewTopicArgs(args)
  const profiles = promptProfiles || {}
  const serverID = parts[0] && servers.has(parts[0]) ? parts.shift() : defaultServerID
  const promptProfileName = parts[0] && profiles[parts[0]] ? parts.shift() : ""
  let directory = ""
  const titleParts = []
  for (const part of parts) {
    const directoryValue = directoryFromArg(part)
    if (directoryValue !== null && !directory) {
      directory = directoryValue
      continue
    }
    titleParts.push(part)
  }
  const customTitle = titleParts.join(" ")
  const title = customTitle || promptProfileName || `OpenCodez ${serverID}`
  const titleSource = customTitle ? "user" : "auto"
  return { serverID, title, titleSource, promptProfileName, promptProfile: promptProfileName ? profiles[promptProfileName] : null, directory }
}

export function parseResetProfileArg(args, { promptProfiles }) {
  const input = String(args || "").trim()
  if (!input) return null
  const parts = input.split(/\s+/)
  if (parts.length !== 1) throw new Error(t("profiles.resetUsageOne"))
  const profile = parts[0]
  const profiles = promptProfiles || {}
  if (!profiles[profile]) {
    const available = Object.keys(profiles).sort().join(", ") || "none"
    throw new Error(t("profiles.unknown", { profile, available }))
  }
  return { promptProfileName: profile, promptProfile: profiles[profile] }
}

export function parseResetArgs(args, { promptProfiles, servers }) {
  const profiles = promptProfiles || {}
  const serverIds = new Set(servers instanceof Map ? servers.keys() : (servers || []).map((server) => server.id))
  const tokens = String(args || "").trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return { promptProfileName: null, promptProfile: null, serverID: null }
  if (tokens.length > 2) throw new Error(t("profiles.resetUsage"))

  if (tokens.length === 1) {
    const [token] = tokens
    const profileMatch = Boolean(profiles[token])
    const serverMatch = serverIds.has(token)
    if (profileMatch && serverMatch) throw new Error(t("profiles.ambiguous", { token }))
    if (profileMatch) return { promptProfileName: token, promptProfile: profiles[token], serverID: null }
    if (serverMatch) return { promptProfileName: null, promptProfile: null, serverID: token }
    throw new Error(t("profiles.unknownTarget", { token }))
  }

  const [profileName, serverID] = tokens
  if (!profiles[profileName]) throw new Error(t("profiles.unknown", { profile: profileName, available: Object.keys(profiles).sort().join(", ") || "none" }))
  if (!serverIds.has(serverID)) throw new Error(t("profiles.unknownServer", { server: serverID }))
  return { promptProfileName: profileName, promptProfile: profiles[profileName], serverID }
}

export async function applyPromptProfile(opencode, serverID, sessionID, promptProfile, options = {}) {
  if (promptProfile?.model) await opencode.switchSessionModel(serverID, sessionID, promptProfile.model, options)
  if (promptProfile?.opencodezSystem) await opencode.selectSystemPrompt(serverID, sessionID, promptProfile.opencodezSystem, options)
}

function tokenizeNewTopicArgs(args) {
  const input = String(args || "").trim()
  if (!input) return []
  const parts = []
  let current = ""
  let quote = ""
  for (const char of input) {
    if (quote) {
      if (char === quote) {
        quote = ""
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) parts.push(current)
  return parts
}

function directoryFromArg(value) {
  const match = String(value || "").match(/^(?:dir|directory):(.+)$/i)
  if (!match) return null
  return match[1].replace(/[\u0000-\u001f\u007f]/g, "").trim()
}
import { t } from "./i18n/index.mjs"
