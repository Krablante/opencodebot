import fs from "node:fs/promises"
import path from "node:path"

// One writer, one append journal. Receipt is durable before getUpdates acknowledges
// it; completion is durable before a lane advances. No per-message state.json save.
export class TelegramInbox {
  constructor(statePath, legacyOffset) {
    this.filePath = `${statePath}.telegram-inbox.ndjson`
    this.offset = legacyOffset || undefined
    this.pending = new Map()
    this.pendingBytes = 0
    this.journalBytes = 0
    this.writes = Promise.resolve()
  }

  async open() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    let data
    try {
      data = await fs.readFile(this.filePath)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      await this.checkpoint()
      return
    }
    let start = 0
    while (start < data.length) {
      const end = data.indexOf(10, start)
      if (end < 0) break // A torn record authorizes neither receipt nor completion.
      let record
      try {
        record = JSON.parse(data.toString("utf8", start, end))
        if (start === 0 && record.type !== "checkpoint") throw new Error("missing checkpoint")
        this.replay(record)
      } catch {
        throw new Error(`Telegram inbox is corrupt at byte ${start}; preserve it and repair before restarting`)
      }
      start = end + 1
    }
    if (!start) throw new Error("Telegram inbox has no complete checkpoint; refusing to reset its cursor")
    // Atomic replacement removes both completed payloads and a torn final append.
    await this.checkpoint()
  }

  replay(record) {
    if (record.type === "checkpoint" || record.type === "receive") {
      if (!Array.isArray(record.updates) || (record.offset !== null && !Number.isSafeInteger(record.offset))) {
        throw new Error("invalid receipt")
      }
      if (record.type === "checkpoint") {
        this.pending.clear()
        this.pendingBytes = 0
      }
      this.offset = record.offset || undefined
      for (const update of record.updates) {
        if (!Number.isSafeInteger(update?.update_id)) throw new Error("invalid update id")
        if (this.pending.has(update.update_id)) continue
        const bytes = Buffer.byteLength(JSON.stringify(update))
        this.pending.set(update.update_id, { update, bytes })
        this.pendingBytes += bytes
      }
    } else if (record.type === "complete" && Number.isSafeInteger(record.id)) {
      this.remove(record.id)
    } else {
      throw new Error("unknown inbox record")
    }
  }

  remove(id) {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pendingBytes -= entry.bytes
    this.pending.delete(id)
  }

  // Keep a failed write chain failed. Continuing after uncertain disk writes
  // could acknowledge work that cannot be recovered; the owner stops the bot.
  serialize(operation) {
    this.writes = this.writes.then(operation)
    return this.writes
  }

  receive(updates, offset) {
    return this.serialize(async () => {
      const fresh = updates.filter((update) => !this.pending.has(update.update_id))
      const record = { type: "receive", offset, updates: fresh }
      await this.append(record)
      this.replay(record)
      await this.compactIfNeeded()
      return fresh
    })
  }

  complete(id) {
    return this.serialize(async () => {
      if (!this.pending.has(id)) return
      if (this.pending.size === 1) {
        // Empty inbox: retire the last payload directly, without a tombstone
        // followed by a second fsync. The cursor survives in the checkpoint.
        await this.checkpoint([])
        this.remove(id)
      } else {
        await this.append({ type: "complete", id })
        this.remove(id)
        await this.compactIfNeeded()
      }
    })
  }

  async append(record) {
    const line = `${JSON.stringify(record)}\n`
    const handle = await fs.open(this.filePath, "a", 0o600)
    try {
      await handle.writeFile(line)
      await handle.sync()
    } finally {
      await handle.close()
    }
    this.journalBytes += Buffer.byteLength(line)
  }

  async compactIfNeeded() {
    if (this.journalBytes > Math.max(1024 * 1024, this.pendingBytes * 2)) await this.checkpoint()
  }

  async checkpoint(updates = [...this.pending.values()].map((entry) => entry.update)) {
    const line = `${JSON.stringify({ type: "checkpoint", offset: this.offset ?? null, updates })}\n`
    const temporary = `${this.filePath}.tmp`
    const handle = await fs.open(temporary, "w", 0o600)
    try {
      await handle.writeFile(line)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, this.filePath)
    // Persist directory entries as well as file contents on POSIX. Windows does
    // not expose directory fsync through Node; file sync + rename still applies.
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(this.filePath), "r")
      try { await directory.sync() } finally { await directory.close() }
    }
    this.journalBytes = Buffer.byteLength(line)
  }
}
