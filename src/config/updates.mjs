import path from "node:path"

const DEFAULT_REPOSITORY = "Krablante/opencodebot"
const DEFAULT_BRANCH = "main"

export function normalizeUpdatesConfig(value = {}, { statePath, env = process.env } = {}) {
  const source = value && typeof value === "object" ? value : {}
  const enabled = source.enabled === true
  const repository = String(source.repository || DEFAULT_REPOSITORY).trim()
  const branch = String(source.branch || DEFAULT_BRANCH).trim()
  const checkAt = String(source.checkAt || "").trim()
  const timeZone = String(source.timeZone || "").trim()
  const currentRevision = normalizeRevision(env.OPENCODEBOT_BUILD_SHA)
  const runtimeDir = path.resolve(String(
    env.OPENCODEBOT_UPDATE_RUNTIME_DIR
      || source.runtimeDir
      || path.join(path.dirname(statePath), "updates"),
  ))

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("updates.repository must use the GitHub owner/repository form")
  }
  if (!branch || [" ", "~", "^", ":", "?", "*", "[", "\\"].some((character) => branch.includes(character))) {
    throw new Error("updates.branch is not a valid Git branch name")
  }
  const schedule = enabled ? parseCheckAt(checkAt) : { hour: null, minute: null }
  if (enabled) assertTimeZone(timeZone)

  return {
    enabled,
    repository,
    branch,
    checkAt,
    checkHour: schedule.hour,
    checkMinute: schedule.minute,
    timeZone,
    currentRevision,
    runtimeDir,
  }
}

function parseCheckAt(value) {
  if (!value) throw new Error("updates.checkAt is required when update checks are enabled")
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error("updates.checkAt must use 24-hour HH:MM format")
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new Error("updates.checkAt must be a valid time")
  return { hour, minute }
}

function assertTimeZone(timeZone) {
  if (!timeZone) throw new Error("updates.timeZone is required when update checks are enabled")
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone }).format(new Date())
  } catch {
    throw new Error(`updates.timeZone is not a valid IANA time zone: ${timeZone}`)
  }
}

function normalizeRevision(value) {
  const revision = String(value || "").trim().toLowerCase()
  return /^[0-9a-f]{40}$/.test(revision) ? revision : "unknown"
}
