export function parseNewTopicArgs(args, { servers, defaultServerID, chatTemplates }) {
  const parts = tokenizeNewTopicArgs(args)
  const templates = chatTemplates || {}
  const serverID = parts[0] && servers.has(parts[0]) ? parts.shift() : defaultServerID
  if (parts[0] === "gpt55p") throw new Error("Profile gpt55p was removed. Use luna, terra, or sol.")
  const chatTemplateName = parts[0] && templates[parts[0]] ? parts.shift() : ""
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
  const title = customTitle || chatTemplateName || `OpenCodez ${serverID}`
  const titleSource = customTitle ? "user" : "auto"
  return { serverID, title, titleSource, chatTemplateName, chatTemplate: chatTemplateName ? templates[chatTemplateName] : null, directory }
}

export function parseResetProfileArg(args, { chatTemplates }) {
  const input = String(args || "").trim()
  if (!input) return null
  const parts = input.split(/\s+/)
  if (parts.length !== 1) throw new Error("Usage: /reset [profile]")
  const profile = parts[0]
  if (profile === "gpt55p") throw new Error("Profile gpt55p was removed. Use luna, terra, or sol.")
  const templates = chatTemplates || {}
  if (!templates[profile]) {
    const available = Object.keys(templates).sort().join(", ") || "none"
    throw new Error(`Unknown profile ${profile}. Available profiles: ${available}.`)
  }
  return { chatTemplateName: profile, chatTemplate: templates[profile] }
}

export function parseResetArgs(args, { chatTemplates, servers }) {
  const templates = chatTemplates || {}
  const serverIds = new Set(servers instanceof Map ? servers.keys() : (servers || []).map((server) => server.id))
  const tokens = String(args || "").trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return { chatTemplateName: null, chatTemplate: null, serverID: null }
  if (tokens.length > 2) throw new Error("Usage: /reset [profile] [server]")

  if (tokens.length === 1) {
    const [token] = tokens
    if (token === "gpt55p") throw new Error("Profile gpt55p was removed. Use luna, terra, or sol.")
    const profileMatch = Boolean(templates[token])
    const serverMatch = serverIds.has(token)
    if (profileMatch && serverMatch) throw new Error(`Reset target ${token} is ambiguous. Use /reset <profile> <server>.`)
    if (profileMatch) return { chatTemplateName: token, chatTemplate: templates[token], serverID: null }
    if (serverMatch) return { chatTemplateName: null, chatTemplate: null, serverID: token }
    throw new Error(`Unknown reset profile or server: ${token}`)
  }

  const [profileName, serverID] = tokens
  if (profileName === "gpt55p") throw new Error("Profile gpt55p was removed. Use luna, terra, or sol.")
  if (!templates[profileName]) throw new Error(`Unknown chat profile: ${profileName}`)
  if (!serverIds.has(serverID)) throw new Error(`Unknown OpenCodez server: ${serverID}`)
  return { chatTemplateName: profileName, chatTemplate: templates[profileName], serverID }
}

export async function applyChatTemplate(opencode, serverID, sessionID, chatTemplate, options = {}) {
  if (chatTemplate?.model) await opencode.switchSessionModel(serverID, sessionID, chatTemplate.model, options)
  if (chatTemplate?.opencodezSystem) await opencode.selectSystemPrompt(serverID, sessionID, chatTemplate.opencodezSystem, options)
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
