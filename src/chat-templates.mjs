export function parseNewTopicArgs(args, { servers, defaultServerID, chatTemplates }) {
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean)
  const templates = chatTemplates || {}
  const serverID = parts[0] && servers.has(parts[0]) ? parts.shift() : defaultServerID
  const chatTemplateName = parts[0] && templates[parts[0]] ? parts.shift() : ""
  const customTitle = parts.join(" ")
  const title = customTitle || chatTemplateName || `OpenCodez ${serverID}`
  const titleSource = customTitle ? "user" : "auto"
  return { serverID, title, titleSource, chatTemplateName, chatTemplate: chatTemplateName ? templates[chatTemplateName] : null }
}

export async function applyChatTemplate(opencode, serverID, sessionID, chatTemplate) {
  if (!chatTemplate?.opencodezTemplate) return
  await opencode.selectPromptTemplate(serverID, sessionID, chatTemplate.opencodezTemplate, chatTemplate.model)
}
