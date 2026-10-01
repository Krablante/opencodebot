import { t } from "./i18n/index.mjs"
import { isInternalUserMessage, logicalTurnRootID, reminderReference } from "./logical-turn.mjs"
import { logInfo, logWarn } from "./logger.mjs"

const REMINDER_HEADER = "REMINDER: The original request for the current run is repeated below in full. Continue from your current progress, preserve later user corrections, and do not repeat completed work."
const ADMISSION_GRACE_MS = 120_000

// Only identifiers and delivery state are persisted. Prompt/media bytes stay in OpenCodez.
export function createCompactionReminders({ state, opencode, telegram, backendRequest, skippedBackendRequest, activeBinding, scheduleReconcile, startedAt = Date.now() }) {
  async function completed(binding, info, marker, messages, { newlyNotified }) {
    const part = marker.parts?.find((item) => item.type === "compaction")
    let record = state.compactionReminder(binding.serverID, binding.sessionID, info.parentID)
    if (!record) {
      if (!newlyNotified || info.time.completed < startedAt) return
      record = await state.updateCompactionReminder({
        serverID: binding.serverID,
        sessionID: binding.sessionID,
        compactionID: info.parentID,
        completedAt: info.time.completed,
        status: state.reminderEnabled() && part?.auto === true ? "pending" : "skipped",
      })
    }
    if (record.status === "sent" || record.status === "skipped") return
    await deliver(binding, record, { marker, messages })
  }

  async function observe(binding, messages) {
    for (const message of messages) {
      const reference = reminderReference(message)
      if (reference && message.parts.length >= (reference.partCount || 1)) await confirm(binding, reference, message.info?.id)
    }
  }

  async function observePart(binding, part) {
    const reference = reminderReference({ parts: [part] })
    if (reference || (part?.type === "compaction" && part.auto === true && part.replay_id)) scheduleReconcile(binding, 1000)
  }

  async function confirm(binding, reference, messageID) {
    if (!messageID) return
    const record = state.compactionReminder(binding.serverID, binding.sessionID, reference.compactionID)
    if (!record || record.status === "skipped") return
    if (record.status !== "sent" || !record.messageID) {
      await state.updateCompactionReminder({ ...record, turnID: reference.turnID, messageID, status: "sent" })
    }
    const current = state.compactionReminder(binding.serverID, binding.sessionID, reference.compactionID)
    if (current.notified || !activeBinding(binding) || !state.reminderEnabled()) return
    await telegram.sendMessage({ chatId: binding.chatId, topicId: binding.topicId, text: t("reminder.sent"), format: "plain" })
    await state.updateCompactionReminder({ ...current, notified: true })
    logInfo("reminder.confirmed", { serverID: binding.serverID, sessionID: binding.sessionID, compactionID: reference.compactionID, messageID })
  }

  async function recover(binding, messages = []) {
    const records = (state.data?.compactionReminders || []).filter((item) => item.serverID === binding.serverID && item.sessionID === binding.sessionID && item.status !== "skipped" && (item.status !== "sent" || !item.notified))
    if (!records.length) return
    await observe(binding, messages)
    for (const saved of records) {
      const record = state.compactionReminder(binding.serverID, binding.sessionID, saved.compactionID)
      if (record.status === "sent") {
        await confirm(binding, record, record.messageID)
        continue
      }
      await deliver(binding, record)
    }
  }

  async function historySinceMarker(binding, compactionID, initial = []) {
    let messages = initial
    const cursors = new Set()
    let before
    while (!messages.some((message) => message.info?.id === compactionID)) {
      const page = await backendRequest(binding.serverID, "reminder history", () => opencode.messagePage(binding.serverID, binding.sessionID, { directory: binding.directory, limit: 20, before }))
      if (page === skippedBackendRequest) return null
      messages = [...page.messages, ...messages]
      if (!page.before || cursors.has(page.before)) break
      cursors.add(page.before)
      before = page.before
    }
    return messages
  }

  async function originalPrompt(binding, marker, messages) {
    const part = marker.parts.find((item) => item.type === "compaction")
    let id = part.turn_id
    const visited = new Set()
    if (!id) {
      let history = messages.filter((message) => message.info.time.created <= marker.info.time.created)
      let before
      let anchor
      while (!id) {
        const user = history.findLast((message) => message.info.role === "user" && message.info.id !== marker.info.id && !message.parts.some((item) => item.type === "compaction"))
        if (user) {
          anchor = user.info.time.created
          id = reminderReference(user)?.turnID || logicalTurnRootID(history, user.info.id)
          if (id) break
        }
        const oldest = history[0]?.info.id
        if (!oldest || oldest === before) break
        before = oldest
        const page = await backendRequest(binding.serverID, "reminder original turn", () => opencode.messagePage(binding.serverID, binding.sessionID, { directory: binding.directory, limit: 20, before }))
        if (page === skippedBackendRequest) return skippedBackendRequest
        if (!page.messages.length) break
        history = [...page.messages, ...history]
      }
      // Local compaction has no phase field. Require actual assistant work in this turn.
      if (!id || !history.some((message) => message.info.role === "assistant" && message.info.summary !== true && message.info.time.created >= anchor)) return null
    }
    while (id && !visited.has(id)) {
      visited.add(id)
      const message = messages.find((item) => item.info.id === id) || await backendRequest(binding.serverID, "reminder original prompt", () => opencode.message(binding.serverID, binding.sessionID, id, { directory: binding.directory }))
      if (message === skippedBackendRequest) return skippedBackendRequest
      if (!message || message.info?.role !== "user") return null
      const reference = reminderReference(message)
      const markerRoot = message.parts?.find((item) => item.type === "compaction")?.turn_id
      if (reference || markerRoot) {
        id = reference?.turnID || markerRoot
        continue
      }
      return isInternalUserMessage(message) ? null : message
    }
    return null
  }

  async function deliver(binding, record, { marker, messages = [] } = {}) {
    if (!activeBinding(binding) || !state.reminderEnabled()) {
      await state.updateCompactionReminder({ ...record, status: "skipped" })
      return
    }
    try {
      // On an ambiguous HTTP failure/restart, inspect durable metadata before retrying.
      if (record.attemptedAt) {
        messages = await historySinceMarker(binding, record.compactionID)
        if (!messages) return scheduleReconcile(binding, 5000)
        await observe(binding, messages)
        record = state.compactionReminder(binding.serverID, binding.sessionID, record.compactionID)
        if (record.status === "sent") return
        const remaining = record.attemptedAt + ADMISSION_GRACE_MS - Date.now()
        if (remaining > 0) return scheduleReconcile(binding, remaining)
      }
      if (!marker) {
        marker = await backendRequest(binding.serverID, "reminder compaction marker", () => opencode.message(binding.serverID, binding.sessionID, record.compactionID, { directory: binding.directory }))
        if (marker === skippedBackendRequest) return scheduleReconcile(binding, 5000)
      }
      const part = marker.parts?.find((item) => item.type === "compaction")
      if (part?.auto !== true) {
        await state.updateCompactionReminder({ ...record, status: "skipped" })
        return
      }
      // OpenCodez writes replay_id after persisting the repeated input and its parts.
      // Confirm that replay instead of injecting a second copy of the same request.
      if (part.replay_id || part.phase === "pre-turn") {
        if (part.replay_id && part.turn_id) {
          const replay = messages.find((message) => message.info?.id === part.replay_id)
            || await backendRequest(binding.serverID, "compaction replay", () => opencode.message(binding.serverID, binding.sessionID, part.replay_id, { directory: binding.directory }))
          if (replay === skippedBackendRequest) return scheduleReconcile(binding, 5000)
          if (replay?.info?.role === "user" && replay.parts?.some((item) => item.type === "text" || item.type === "file")) {
            await confirm(binding, { compactionID: record.compactionID, turnID: part.turn_id }, replay.info.id)
            return
          }
        }
        const status = await backendRequest(binding.serverID, "compaction replay status", () => opencode.sessionStatus(binding.serverID, binding.sessionID, { directory: binding.directory }))
        if (status === skippedBackendRequest || status?.type === "busy" || status?.type === "retry") return scheduleReconcile(binding, 1000)
        await state.updateCompactionReminder({ ...record, status: "skipped" })
        return
      }
      if (!part.turn_id) {
        messages = await historySinceMarker(binding, record.compactionID, messages)
        if (!messages) return scheduleReconcile(binding, 5000)
      }
      const source = await originalPrompt(binding, marker, messages)
      if (source === skippedBackendRequest) return scheduleReconcile(binding, 5000)
      const finished = messages.some((message) => message.info?.role === "assistant" && message.info.summary !== true && message.info.finish === "stop" && message.info.time?.completed >= record.completedAt && !message.parts?.some((part) => part.type === "tool"))
      if (!source || finished) {
        await state.updateCompactionReminder({ ...record, status: "skipped" })
        return
      }
      if (!activeBinding(binding) || !state.reminderEnabled()) return
      const payload = reminderPayload(source, record.compactionID)
      if (payload.parts.length < 2) {
        await state.updateCompactionReminder({ ...record, status: "skipped" })
        return
      }
      const status = await backendRequest(binding.serverID, "reminder session status", () => opencode.sessionStatus(binding.serverID, binding.sessionID, { directory: binding.directory }))
      if (status === skippedBackendRequest) return scheduleReconcile(binding, 5000)
      if (!activeBinding(binding) || !state.reminderEnabled() || (status?.type !== "busy" && status?.type !== "retry")) {
        await state.updateCompactionReminder({ ...record, status: "skipped" })
        if (record.attemptedAt && activeBinding(binding)) await telegram.sendMessage({ chatId: binding.chatId, topicId: binding.topicId, text: t("reminder.failed"), format: "plain" })
        return
      }
      record = await state.updateCompactionReminder({ ...record, turnID: source.info.id, attemptedAt: Date.now(), status: "pending" })
      const result = await backendRequest(binding.serverID, "send compaction reminder", () => opencode.promptAsync(binding.serverID, binding.sessionID, payload, { directory: binding.directory }))
      if (result === skippedBackendRequest) {
        await state.updateCompactionReminder({ ...record, attemptedAt: null })
      }
      scheduleReconcile(binding, 1000)
    } catch (error) {
      // Never log the request, provider body, or original prompt.
      logWarn("reminder.delivery_failed", { serverID: binding.serverID, sessionID: binding.sessionID, compactionID: record.compactionID, status: error.status })
      if (error.name === "OpenCodeHttpError" && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        await state.updateCompactionReminder({ ...record, status: "skipped" })
        if (activeBinding(binding)) await telegram.sendMessage({ chatId: binding.chatId, topicId: binding.topicId, text: t("reminder.failed"), format: "plain" })
        return
      }
      scheduleReconcile(binding, 5000)
    }
  }

  return { completed, observe, observePart, recover }
}

export function reminderPayload(source, compactionID) {
  const parts = [{ type: "text", text: `${REMINDER_HEADER}\n\n`, synthetic: true, metadata: { opencodebot_reminder: { compactionID, turnID: source.info.id } } }]
  for (const part of source.parts || []) {
    if (part.type === "text" && !part.ignored && typeof part.text === "string" && part.text) parts.push({ type: "text", text: part.text, synthetic: true })
    // Text files/directories already have their captured contents in persisted text parts.
    if (part.type === "file" && part.url && part.mime !== "text/plain" && part.mime !== "application/x-directory") parts.push({ type: "file", mime: part.mime, filename: part.filename, url: part.url })
  }
  parts[0].metadata.opencodebot_reminder.partCount = parts.length
  return {
    agent: source.info.agent,
    model: { providerID: source.info.model.providerID, modelID: source.info.model.modelID },
    ...(source.info.model.variant ? { variant: source.info.model.variant } : {}),
    ...(source.info.system ? { system: source.info.system } : {}),
    ...(source.info.tools ? { tools: source.info.tools } : {}),
    ...(source.info.format ? { format: source.info.format } : {}),
    parts,
  }
}
