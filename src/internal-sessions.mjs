const IGNORED_SESSION_TITLES = new Set([
  "opencode-see delegate",
])

export function isIgnoredSession(session) {
  return isIgnoredSessionTitle(session?.title)
}

export function isIgnoredSessionTitle(title) {
  return IGNORED_SESSION_TITLES.has(String(title || "").trim().toLowerCase())
}

export function isInternalSession(session) {
  return Boolean(session?.parentID || /\(@.+ subagent\)/i.test(session?.title || "") || isIgnoredSession(session))
}
