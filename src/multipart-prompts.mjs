export class MultipartPromptBuffer {
  constructor(settings, flushPrompt, onError = (error) => console.error(error)) {
    this.settings = normalizeSettings(settings)
    this.flushPrompt = flushPrompt
    this.onError = onError
    this.pending = new Map()
  }

  async push(key, text, context) {
    const value = String(text || "").trim()
    if (!value) return "empty"
    if (!this.settings.enabled) {
      await this.flushPrompt(context, value)
      return "sent"
    }

    const existing = this.pending.get(key)
    if (!existing && value.length < this.settings.minChars) {
      await this.flushPrompt(context, value)
      return "sent"
    }

    const entry = existing || { parts: [], context, timer: null }
    entry.parts.push(value)
    if (!existing) this.pending.set(key, entry)
    this.schedule(key, entry)

    if (entry.parts.length >= this.settings.maxParts || joinedLength(entry.parts) >= this.settings.maxChars) {
      await this.flushKey(key)
      return "flushed"
    }
    return "queued"
  }

  async flushKey(key) {
    const entry = this.pending.get(key)
    if (!entry) return false
    if (entry.timer) clearTimeout(entry.timer)
    this.pending.delete(key)
    await this.flushPrompt(entry.context, entry.parts.join("\n\n"))
    return true
  }

  discardKey(key) {
    const entry = this.pending.get(key)
    if (!entry) return false
    if (entry.timer) clearTimeout(entry.timer)
    this.pending.delete(key)
    return true
  }

  has(key) {
    return this.pending.has(key)
  }

  schedule(key, entry) {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      this.flushKey(key).catch(this.onError)
    }, this.settings.idleMs)
    entry.timer.unref?.()
  }
}

function normalizeSettings(settings = {}) {
  return {
    enabled: settings.enabled !== false,
    minChars: numberAtLeast(settings.minChars, 3600, 1),
    idleMs: numberAtLeast(settings.idleMs, 2000, 100),
    maxParts: numberAtLeast(settings.maxParts, 20, 2),
    maxChars: numberAtLeast(settings.maxChars, 120000, 4096),
  }
}

function numberAtLeast(value, fallback, min) {
  const number = Number(value)
  return Number.isFinite(number) && number >= min ? Math.floor(number) : fallback
}

function joinedLength(parts) {
  if (!parts.length) return 0
  return parts.reduce((total, part) => total + part.length, 0) + (parts.length - 1) * 2
}
