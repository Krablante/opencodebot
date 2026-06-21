export function createBackendRequester({ logger = console } = {}) {
  const skipped = Symbol("skipped backend request")
  const backoffs = new Map()

  return {
    skipped,
    async request(serverID, operation, request) {
      if (!canTryBackend(backoffs, serverID)) return skipped
      try {
        const result = await request()
        markBackendSuccess(backoffs, serverID, logger)
        return result
      } catch (error) {
        markBackendFailure(backoffs, serverID, operation, error, logger)
        return skipped
      }
    },
  }
}

export function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

function canTryBackend(backoffs, serverID) {
  const backoff = backoffs.get(serverID)
  return !backoff || Date.now() >= backoff.nextRetryAt
}

function markBackendSuccess(backoffs, serverID, logger) {
  const backoff = backoffs.get(serverID)
  if (!backoff) return
  if (backoff.offlineSince) logger.info(`[opencodebot] ${serverID} backend recovered`)
  backoffs.delete(serverID)
}

function markBackendFailure(backoffs, serverID, operation, error, logger) {
  const backoff = backendBackoff(backoffs, serverID)
  const now = Date.now()
  if (!backoff.offlineSince) backoff.offlineSince = now
  if (!backoff.lastLogAt || now - backoff.lastLogAt >= 600_000) {
    const state = backoff.lastLogAt ? `still offline after ${formatDuration(now - backoff.offlineSince)}` : "offline"
    logger.warn(`[opencodebot] ${serverID} backend ${state} during ${operation}: ${error.message}; retrying in ${formatDuration(backoff.delayMs)}`)
    backoff.lastLogAt = now
  }
  backoff.nextRetryAt = now + backoff.delayMs
  backoff.delayMs = Math.min(backoff.delayMs * 2, 120_000)
}

function backendBackoff(backoffs, serverID) {
  let backoff = backoffs.get(serverID)
  if (!backoff) {
    backoff = { delayMs: 15_000, nextRetryAt: 0, offlineSince: 0, lastLogAt: 0 }
    backoffs.set(serverID, backoff)
  }
  return backoff
}
