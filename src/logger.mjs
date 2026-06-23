const SLOW_MS = Number(process.env.OPENCODEBOT_LOG_SLOW_MS || 1000)

export function logInfo(event, fields = {}) {
  console.log(formatLog(event, fields))
}

export function logWarn(event, fields = {}) {
  console.warn(formatLog(event, fields))
}

export function logErrorEvent(event, error, fields = {}) {
  console.error(formatLog(event, { ...fields, error: errorSummary(error) }))
}

export function shouldLogSlow(durationMs, thresholdMs = SLOW_MS) {
  return durationMs >= thresholdMs
}

export function durationMs(startedAt = Date.now()) {
  return Date.now() - startedAt
}

export function errorSummary(error) {
  if (!error) return undefined
  return {
    name: error.name,
    message: error.message,
  }
}

function formatLog(event, fields) {
  const safeFields = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${formatValue(value)}`)
  return [`[opencodebot] ${event}`, ...safeFields].join(" ")
}

function formatValue(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "object") return JSON.stringify(value)
  return JSON.stringify(String(value))
}
