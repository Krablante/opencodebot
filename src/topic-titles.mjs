const TELEGRAM_TOPIC_TITLE_MAX = 128

export function managedTopicTitle(baseTitle, serverID, servers) {
  const base = cleanTopicTitle(baseTitle)
  if (serverCount(servers) < 2) {
    return { topicBaseTitle: base, topicTitle: base, topicServerSuffixManaged: false }
  }
  const suffix = ` (${String(serverID || "server").trim() || "server"})`
  const maxBaseLength = Math.max(1, TELEGRAM_TOPIC_TITLE_MAX - suffix.length)
  return {
    topicBaseTitle: base.slice(0, maxBaseLength).trim() || "OpenCodez session",
    topicTitle: `${base.slice(0, maxBaseLength).trim() || "OpenCodez session"}${suffix}`,
    topicServerSuffixManaged: true,
  }
}

export function topicBaseTitle(record) {
  return cleanTopicTitle(record?.topicBaseTitle || record?.topicTitle || record?.title || "OpenCodez session")
}

export function baseTitleFromTelegramTitle(title, serverID, servers) {
  const current = cleanTopicTitle(title)
  if (serverCount(servers) < 2) return current
  const suffix = ` (${String(serverID || "").trim()})`
  return suffix.trim() && current.endsWith(suffix) ? cleanTopicTitle(current.slice(0, -suffix.length)) : current
}

function cleanTopicTitle(value) {
  return String(value || "OpenCodez session").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, TELEGRAM_TOPIC_TITLE_MAX) || "OpenCodez session"
}

function serverCount(servers) {
  if (Number.isFinite(servers?.size)) return servers.size
  if (Array.isArray(servers)) return servers.length
  return 0
}
