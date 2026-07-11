export class PromptQueue {
  constructor(sendPrompt, { onDrop } = {}) {
    this.sendPrompt = sendPrompt
    this.onDrop = onDrop || (async () => {})
    this.sessions = new Map()
  }

  markBusy(binding) {
    beginRun(this.state(binding))
  }

  markSendFailed(binding) {
    const state = this.state(binding)
    state.busy = false
    state.idle = true
    state.terminalMirrored = true
  }

  isBusy(binding) {
    return this.state(binding).busy
  }

  markExpectedStop(binding, ttlMs = 15000) {
    this.state(binding).expectedStopUntil = Date.now() + ttlMs
  }

  clearExpectedStop(binding) {
    delete this.state(binding).expectedStopUntil
  }

  hasExpectedStop(binding) {
    const state = this.state(binding)
    const until = state.expectedStopUntil
    if (!Number.isFinite(until)) return false
    if (until >= Date.now()) return true
    delete state.expectedStopUntil
    return false
  }

  async enqueue(binding, text, files = [], metadata = {}) {
    if (!Array.isArray(files)) {
      metadata = files || {}
      files = []
    }
    const value = String(text || "").trim()
    if (!value) return { status: "empty" }
    const state = this.state(binding)
    if (!state.busy) {
      await this.sendNow(binding, value, files, metadata)
      return { status: "sent" }
    }
    state.items.push({ text: value, files, createdAt: Date.now(), sourceMessageId: metadata?.sourceMessageId })
    return { status: "queued", position: state.items.length }
  }

  status(binding) {
    return this.state(binding).items.map((item, index) => ({
      index: index + 1,
      text: item.text,
      summary: summarizeQueueItem(item),
      fileCount: item.files?.length || 0,
      createdAt: item.createdAt,
    }))
  }

  delete(binding, index) {
    const state = this.state(binding)
    const offset = Number(index) - 1
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= state.items.length) return null
    const [removed] = state.items.splice(offset, 1)
    this.dropItem(removed)
    return { index: offset + 1, text: removed.text, summary: summarizeQueueItem(removed), fileCount: removed.files?.length || 0 }
  }

  clear(binding) {
    const state = this.state(binding)
    const items = state.items
    const cleared = state.items.map((item, index) => ({
      index: index + 1,
      text: item.text,
      summary: summarizeQueueItem(item),
      fileCount: item.files?.length || 0,
      createdAt: item.createdAt,
    }))
    state.busy = false
    state.idle = true
    state.terminalMirrored = true
    state.items = []
    items.forEach((item) => this.dropItem(item))
    return cleared
  }

  async markBackendIdle(binding) {
    const state = this.state(binding)
    state.idle = true
    return this.drainIfReady(binding, state)
  }

  async markTerminalMirrored(binding) {
    const state = this.state(binding)
    state.terminalMirrored = true
    return this.drainIfReady(binding, state)
  }

  async drainIfReady(binding, state) {
    if (!state.idle || !state.terminalMirrored) return { status: "waiting" }
    state.busy = false
    if (!state.items.length) return { status: "idle" }
    const item = state.items.shift()
    await this.sendNow(binding, item.text, item.files || [], item)
    return { status: "sent", text: item.text }
  }

  async sendNow(binding, text, files = [], metadata = {}) {
    const state = this.state(binding)
    beginRun(state)
    try {
      await this.sendPrompt(binding, text, files, metadata)
    } catch (error) {
      this.markSendFailed(binding)
      throw error
    }
  }

  state(binding) {
    const key = queueKey(binding)
    let state = this.sessions.get(key)
    if (!state) {
      state = { busy: false, idle: true, terminalMirrored: true, items: [] }
      this.sessions.set(key, state)
    }
    return state
  }

  dropItem(item) {
    if (!item?.files?.length) return
    Promise.resolve(this.onDrop(item.files)).catch(() => {})
  }
}

function beginRun(state) {
  state.busy = true
  state.idle = false
  state.terminalMirrored = false
}

export function summarizeWords(text, maxWords = 10) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean)
  if (words.length <= maxWords) return words.join(" ")
  return `${words.slice(0, maxWords).join(" ")}...`
}

export function summarizeQueueItem(item, maxWords = 10) {
  const text = typeof item === "string" ? item : item?.text
  const summary = summarizeWords(text, maxWords)
  const fileCount = typeof item === "string" ? 0 : item?.files?.length || 0
  return fileCount ? `${summary} (+${fileCount} file${fileCount === 1 ? "" : "s"})` : summary
}

function queueKey(binding) {
  return `${binding.serverID}:${binding.sessionID}`
}
