export class PromptQueue {
  constructor(sendPrompt) {
    this.sendPrompt = sendPrompt
    this.sessions = new Map()
  }

  markBusy(binding) {
    this.state(binding).busy = true
  }

  markIdle(binding) {
    this.state(binding).busy = false
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

  consumeExpectedStop(binding) {
    const state = this.state(binding)
    const until = state.expectedStopUntil
    delete state.expectedStopUntil
    return Number.isFinite(until) && until >= Date.now()
  }

  async enqueue(binding, text, metadata = {}) {
    const value = String(text || "").trim()
    if (!value) return { status: "empty" }
    const state = this.state(binding)
    if (!state.busy) {
      await this.sendNow(binding, value, metadata)
      return { status: "sent" }
    }
    state.items.push({ text: value, createdAt: Date.now(), sourceMessageId: metadata?.sourceMessageId })
    return { status: "queued", position: state.items.length }
  }

  status(binding) {
    return this.state(binding).items.map((item, index) => ({
      index: index + 1,
      text: item.text,
      summary: summarizeWords(item.text, 10),
      createdAt: item.createdAt,
    }))
  }

  delete(binding, index) {
    const state = this.state(binding)
    const offset = Number(index) - 1
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= state.items.length) return null
    const [removed] = state.items.splice(offset, 1)
    return { index: offset + 1, text: removed.text, summary: summarizeWords(removed.text, 10) }
  }

  clear(binding) {
    const state = this.state(binding)
    const cleared = state.items.map((item, index) => ({
      index: index + 1,
      text: item.text,
      summary: summarizeWords(item.text, 10),
      createdAt: item.createdAt,
    }))
    state.busy = false
    state.items = []
    return cleared
  }

  async complete(binding) {
    const state = this.state(binding)
    state.busy = false
    return this.drain(binding)
  }

  async drain(binding) {
    const state = this.state(binding)
    if (state.busy || !state.items.length) return { status: "idle" }
    const item = state.items.shift()
    await this.sendNow(binding, item.text, item)
    return { status: "sent", text: item.text }
  }

  async sendNow(binding, text, metadata = {}) {
    const state = this.state(binding)
    state.busy = true
    try {
      await this.sendPrompt(binding, text, [], metadata)
    } catch (error) {
      state.busy = false
      throw error
    }
  }

  state(binding) {
    const key = queueKey(binding)
    let state = this.sessions.get(key)
    if (!state) {
      state = { busy: false, items: [] }
      this.sessions.set(key, state)
    }
    return state
  }
}

export function summarizeWords(text, maxWords = 10) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean)
  if (words.length <= maxWords) return words.join(" ")
  return `${words.slice(0, maxWords).join(" ")}...`
}

function queueKey(binding) {
  return `${binding.serverID}:${binding.sessionID}`
}
