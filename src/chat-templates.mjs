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

export async function applyChatTemplate(opencode, serverID, sessionID, chatTemplate, options = {}) {
  if (!chatTemplate?.opencodezSystem) return
  await opencode.selectSystemPrompt(serverID, sessionID, chatTemplate.opencodezSystem, options)
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
