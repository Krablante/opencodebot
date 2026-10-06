const MAX_QUEUED_PER_SESSION = 20
const MAX_QUEUED_TOTAL = 100
const MAX_QUEUED_BYTES = 64 * 1024 * 1024

export class PromptQueue {
  constructor(sendPrompt, { onDrop, sessionStatus, onQueued } = {}) {
    this.sendPrompt = sendPrompt
    this.onDrop = onDrop || (async () => {})
    this.sessions = new Map()
    this.sessionStatus = sessionStatus
    this.onQueued = onQueued
  }

  setCompacting(binding, operation) {
    const state = this.state(binding)
    state.compacting = operation || null
    if (operation) beginRun(state)
  }

  isCompacting(binding) {
    return Boolean(this.state(binding).compacting)
  }

  cancelCompaction(binding) {
    const state = this.state(binding)
    if (state.compacting) state.compacting.cancelled = true
    state.compacting = null
  }

  markBusy(binding, userMessageID, { submitted = false } = {}) {
    const state = this.state(binding)
    if (!userMessageID) {
      beginRun(state)
      state.awaitingUser ||= submitted
      return
    }
    // OpenCodez's canonical message IDs are ordered by creation. A recovered
    // old prompt must not reset the gates of a newer dispatch.
    if (state.messageFloor && userMessageID <= state.messageFloor) return
    if (!state.awaitingUser) beginRun(state)
    state.messageFloor = userMessageID
    state.awaitingUser = false
    state.idle = false
    state.terminalMirrored = false
  }

  observeUserMessage(binding, userMessageID, { submitted = false } = {}) {
    if (!userMessageID) return
    if (this.state(binding).awaitingUser && !submitted) return
    this.markBusy(binding, userMessageID)
  }

  generation(binding) {
    return this.state(binding).generation
  }

  markSendFailed(binding) {
    const state = this.state(binding)
    state.busy = false
    state.idle = true
    state.terminalMirrored = true
    state.awaitingUser = false
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

  async waitForExpectedStop(binding, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    while (this.hasExpectedStop(binding)) {
      if (Date.now() >= deadline) throw new Error("OpenCodez idle event did not arrive after stopping the run")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async enqueue(binding, text, files = [], metadata = {}) {
    if (!Array.isArray(files)) {
      metadata = files || {}
      files = []
    }
    const value = String(text || "").trim()
    if (!value) return { status: "empty" }
    const state = this.state(binding)
    const epoch = state.epoch
    const generation = state.generation
    if (!state.compacting && this.sessionStatus) {
      let status
      try { status = await this.sessionStatus(binding) }
      catch (error) {
        await this.onDrop(files)
        if (state.epoch !== epoch) return { status: "cancelled" }
        throw error
      }
      // Clear/rewind can cancel admission while the status request is pending.
      if (state.epoch !== epoch) {
        await this.onDrop(files)
        return { status: "cancelled" }
      }
      // Another admission may have started a run after this lookup began.
      if (state.generation === generation) {
        if (status.type !== "idle") {
          if (!state.busy) beginRun(state)
          state.idle = false
        } else state.idle = true
      }
    }
    if (!state.busy && !state.compacting) {
      await this.sendNow(binding, value, files, metadata)
      return { status: "sent" }
    }
    const bytes = Buffer.byteLength(value) + files.reduce((total, file) => total + (file.inlinePending
      ? Math.ceil((file.size || 0) / 3) * 4 : Buffer.byteLength(file.url || "")), 0)
    let count = 0, retainedBytes = 0
    for (const session of this.sessions.values()) for (const item of session.items) { count++; retainedBytes += item.bytes || 0 }
    if (state.items.length >= MAX_QUEUED_PER_SESSION || count >= MAX_QUEUED_TOTAL || retainedBytes + bytes > MAX_QUEUED_BYTES) {
      await this.onDrop(files)
      return { status: "full" }
    }
    const position = state.items.push({ text: value, files, bytes, createdAt: Date.now(), sourceMessageId: metadata?.sourceMessageId })
    await this.onQueued?.(binding)
    if (state.epoch !== epoch) return { status: "cancelled" }
    return { status: "queued", position }
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
    state.epoch += 1
    state.generation += 1
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
    state.awaitingUser = false
    this.cancelCompaction(binding)
    state.items = []
    items.forEach((item) => this.dropItem(item))
    return cleared
  }

  discardPending(binding) {
    const state = this.state(binding)
    state.epoch += 1
    const items = state.items.splice(0)
    items.forEach((item) => this.dropItem(item))
    return items.length
  }

  async markBackendIdle(binding, { generation } = {}) {
    const state = this.state(binding)
    if (generation !== undefined && generation !== state.generation) return { status: "waiting" }
    state.idle = true
    return this.drainIfReady(binding, state)
  }

  markBackendBusy(binding, { generation } = {}) {
    const state = this.state(binding)
    if (generation !== undefined && generation !== state.generation) return
    state.busy = true
    state.idle = false
  }

  async markTerminalMirrored(binding, { backendIdle = false, messageID, generation } = {}) {
    const state = this.state(binding)
    if (generation !== undefined && generation !== state.generation) return { status: "waiting" }
    if (messageID) {
      if (state.awaitingUser || (state.messageFloor && messageID < state.messageFloor)) return { status: "waiting" }
      if (messageID === state.messageFloor && !state.terminalMirrored && !backendIdle) return { status: "waiting" }
      state.messageFloor = messageID
    }
    if (backendIdle) state.idle = true
    state.terminalMirrored = true
    return this.drainIfReady(binding, state)
  }

  async drainIfReady(binding, state) {
    if (state.compacting || !state.idle || !state.terminalMirrored) return { status: "waiting" }
    state.busy = false
    if (!state.items.length) return { status: "idle" }
    const item = state.items.shift()
    await this.sendNow(binding, item.text, item.files || [], item)
    return { status: "sent", text: item.text }
  }

  async sendNow(binding, text, files = [], metadata = {}) {
    const state = this.state(binding)
    beginRun(state)
    state.awaitingUser = true
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
      state = { busy: false, idle: true, terminalMirrored: true, items: [], epoch: 0, generation: 0 }
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
  state.generation += 1
  state.busy = true
  state.idle = false
  state.terminalMirrored = false
}

export function summarizeWords(text, maxWords = 10) {
  const words = String(text || "").trim().split(/\s+/, maxWords + 1).filter(Boolean)
  const summary = words.slice(0, maxWords).join(" ")
  if (summary.length <= 160 && words.length <= maxWords) return summary
  return `${summary.slice(0, 157).replace(/[\uD800-\uDBFF]$/, "")}...`
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
