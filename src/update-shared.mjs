const CHANGE_TYPES = {
  feat: { key: "features", title: "New", icon: "✨" },
  fix: { key: "fixes", title: "Fixed", icon: "🛠" },
  perf: { key: "performance", title: "Performance", icon: "⚡" },
}

const MAINTENANCE_TYPES = new Set(["build", "chore", "docs", "refactor", "test"])

export function isGitRevision(value) {
  return /^[0-9a-f]{40}$/.test(String(value || "").trim().toLowerCase())
}

export function shortRevision(value) {
  const revision = String(value || "unknown").trim()
  return isGitRevision(revision) ? revision.slice(0, 7) : "unknown"
}

export function summarizeUpdateCommits(commits = [], { maxItems = 8 } = {}) {
  const groups = {
    features: [],
    fixes: [],
    performance: [],
    other: [],
  }
  let maintenanceCount = 0

  for (const commit of commits) {
    const subject = firstLine(commit?.commit?.message || commit?.message || commit?.subject)
    if (!subject || /^Merge\b/i.test(subject)) continue
    const parsed = parseCommitSubject(subject)
    if (parsed.type && MAINTENANCE_TYPES.has(parsed.type)) {
      maintenanceCount += 1
      continue
    }
    const group = CHANGE_TYPES[parsed.type]?.key || "other"
    groups[group].push(truncate(parsed.text, 180))
  }

  const sections = []
  let remaining = Math.max(1, Number(maxItems) || 8)
  let omittedCount = 0
  for (const definition of [...Object.values(CHANGE_TYPES), { key: "other", title: "Other", icon: "•" }]) {
    const items = groups[definition.key]
    if (!items.length) continue
    const visible = items.slice(0, remaining)
    omittedCount += items.length - visible.length
    if (visible.length) sections.push({ title: definition.title, icon: definition.icon, items: visible })
    remaining -= visible.length
  }

  return {
    sections,
    maintenanceCount,
    omittedCount,
    totalCount: commits.length,
  }
}

export function classifyChangedPaths(paths = []) {
  const normalized = paths.map((value) => String(value || "").replaceAll("\\", "/").replace(/^\.\//, ""))
  return {
    plugin: normalized.some((value) => value.startsWith("plugins/opencodebot-artifacts/")),
    skill: normalized.some((value) => value.startsWith("skills/telegram-artifact-send/")),
  }
}

export function zonedScheduleParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]))
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  }
}

export function scheduledCheckDue({ now = new Date(), timeZone, hour, minute, lastScheduledDate }) {
  const local = zonedScheduleParts(now, timeZone)
  return {
    ...local,
    due: local.date !== lastScheduledDate && local.minuteOfDay >= Number(hour) * 60 + Number(minute),
  }
}

function parseCommitSubject(subject) {
  const match = /^(feat|fix|perf|refactor|docs|test|build|chore)(?:\([^)]+\))?!?:\s*(.+)$/i.exec(subject)
  if (!match) return { type: "", text: subject }
  return { type: match[1].toLowerCase(), text: match[2] }
}

function firstLine(value) {
  return String(value || "").split("\n", 1)[0].trim()
}

function truncate(value, limit) {
  const text = String(value || "").trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`
}
