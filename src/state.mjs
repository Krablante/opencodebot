import fs from "node:fs/promises"
import path from "node:path"

const MIRRORED_SESSION_BUCKET_LIMIT = 250
const MAX_PROMPT_ORIGINS = 5_000
const TOPIC_TITLE_FIELDS = [
  "titleSource",
  "topicBaseTitle",
  "topicTitle",
  "topicServerSuffixManaged",
  "topicTitleUpdatedAt",
]
const TOPIC_ICON_FIELDS = ["topicIconCustomEmojiId", "topicIconEmoji", "topicIconUpdatedAt"]

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath
    this.markerPath = `${filePath}.mirror-markers.ndjson`
    this.data = defaultState()
    this.queue = Promise.resolve()
    this.markerQueue = Promise.resolve()
    this.deferredSaveTimer = null
    this.deferredDirty = false
  }

  async load() {
    try {
      const text = await fs.readFile(this.filePath, "utf8")
      this.data = { ...defaultState(), ...JSON.parse(text) }
      this.data.bindings ||= []
      this.data.pendingTopics ||= {}
      this.data.pendingPrompts ||= []
      this.data.promptOrigins ||= []
      this.data.mirroredAssistantBySession ||= {}
      this.data.mirroredUserBySession ||= {}
      this.data.finalNotifications ||= { enabledUserIds: [], sentMessages: [] }
      this.data.finalNotifications.enabledUserIds ||= []
      this.data.finalNotifications.sentMessages ||= []
      this.data.incompleteRunHistory = Array.isArray(this.data.incompleteRunHistory) ? this.data.incompleteRunHistory : []
      this.data.questionMessages ||= []
      this.data.seenSessions ||= []
      this.data.telegram ||= {}
      this.data.telegram.mirrorMode = normalizeMirrorMode(this.data.telegram.mirrorMode)
      const migratedContextPreferences = migrateContextTurnsByUser(this.data.telegram)
      this.data.telegram.artifactsTopic ||= null
      this.data.telegram.soundsTopic ||= null
      this.data.runtime ||= {}
      const legacyMirrorMarkers = hasMirrorMarkers(this.data)
      await this.loadMirrorMarkerJournal()
      const migratedResetTitles = migrateResetTitleOwnership(this.data)
      const reconciledTopicMetadata = reconcileTopicMetadata(this.data)
      const pruned = pruneState(this.data)
      await this.compactMirrorMarkerJournal()
      if (legacyMirrorMarkers || migratedContextPreferences || migratedResetTitles || reconciledTopicMetadata || pruned) await this.save()
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      this.data = defaultState()
      await this.loadMirrorMarkerJournal()
      pruneState(this.data)
      await this.compactMirrorMarkerJournal()
      await this.save()
    }
    return this.data
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.${process.pid}.tmp`
    const persisted = {
      ...this.data,
      mirroredAssistantBySession: {},
      mirroredUserBySession: {},
    }
    await fs.writeFile(temp, JSON.stringify(persisted, null, 2) + "\n", { mode: 0o600 })
    await fs.rename(temp, this.filePath)
  }

  async loadMirrorMarkerJournal() {
    let text
    try {
      text = await fs.readFile(this.markerPath, "utf8")
    } catch (error) {
      if (error.code === "ENOENT") return
      throw error
    }
    for (const line of text.split("\n")) {
      if (!line) continue
      const value = JSON.parse(line)
      const marker = Array.isArray(value)
        ? { kind: value[0] === "u" ? "user" : "assistant", serverID: value[1], sessionID: value[2], messageID: value[3] }
        : value
      const target = marker.kind === "user" ? this.data.mirroredUserBySession : this.data.mirroredAssistantBySession
      addMirroredMessage(target, marker.serverID, marker.sessionID, marker.messageID)
    }
  }

  async compactMirrorMarkerJournal() {
    await fs.mkdir(path.dirname(this.markerPath), { recursive: true })
    const temp = `${this.markerPath}.${process.pid}.tmp`
    const lines = [
      ...mirrorMarkerLines(this.data.mirroredAssistantBySession, "assistant"),
      ...mirrorMarkerLines(this.data.mirroredUserBySession, "user"),
    ]
    await fs.writeFile(temp, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 })
    await fs.rename(temp, this.markerPath)
  }

  appendMirrorMarkers(kind, serverID, sessionID, messageIDs) {
    const update = this.markerQueue.then(async () => {
      const target = kind === "user" ? this.data.mirroredUserBySession : this.data.mirroredAssistantBySession
      const pending = [...new Set(messageIDs)].filter((messageID) => !hasMirroredMessage(target, serverID, sessionID, messageID))
      if (!pending.length) return false
      const lines = pending.map((messageID) => mirrorMarkerLine(kind, serverID, sessionID, messageID)).join("\n")
      await fs.appendFile(this.markerPath, `${lines}\n`, { mode: 0o600 })
      for (const messageID of pending) addMirroredMessage(target, serverID, sessionID, messageID)
      pruneMirroredBuckets(target)
      return true
    })
    this.markerQueue = update.catch(() => undefined)
    return update
  }

  async update(mutator) {
    const update = this.queue.then(async () => {
      const result = await mutator(this.data)
      if (result === false) return false
      await this.save()
      this.clearDeferredSave()
      return result
    })
    this.queue = update.catch(() => undefined)
    return update
  }

  async updateDeferred(mutator, delayMs = 60_000) {
    const update = this.queue.then(async () => {
      const result = await mutator(this.data)
      if (result === false) return false
      this.deferredDirty = true
      this.scheduleDeferredSave(delayMs)
      return result
    })
    this.queue = update.catch(() => undefined)
    return update
  }

  async flushDeferred() {
    if (this.deferredSaveTimer) {
      clearTimeout(this.deferredSaveTimer)
      this.deferredSaveTimer = null
    }
    const flush = this.queue.then(async () => {
      if (!this.deferredDirty) return false
      await this.save()
      this.deferredDirty = false
      return true
    })
    this.queue = flush.catch(() => undefined)
    return flush
  }

  scheduleDeferredSave(delayMs) {
    if (this.deferredSaveTimer) return
    this.deferredSaveTimer = setTimeout(() => {
      this.deferredSaveTimer = null
      this.flushDeferred().catch((error) => {
        console.error(`[opencodebot] deferred state save failed: ${error.message}`)
        if (this.deferredDirty) this.scheduleDeferredSave(5_000)
      })
    }, delayMs)
    this.deferredSaveTimer.unref?.()
  }

  clearDeferredSave() {
    this.deferredDirty = false
    if (!this.deferredSaveTimer) return
    clearTimeout(this.deferredSaveTimer)
    this.deferredSaveTimer = null
  }

  get chatId() {
    return this.data.telegram.chatId ?? null
  }

  // Telegram runtime and artifact target.

  artifactsTopic() {
    return this.data.telegram.artifactsTopic || null
  }

  isArtifactsTopic(chatId, topicId) {
    const topic = this.artifactsTopic()
    return Boolean(topic && String(topic.chatId) === String(chatId) && Number(topic.topicId || 0) === Number(topicId || 0))
  }

  async setArtifactsTopic({ chatId, topicId, title, setBy }) {
    return this.update((data) => {
      const now = new Date().toISOString()
      data.telegram.artifactsTopic = {
        chatId,
        topicId,
        title: title || `Topic ${topicId}`,
        setBy,
        setAt: now,
      }
      for (const binding of data.bindings.filter((item) => String(item.chatId) === String(chatId) && Number(item.topicId || 0) === Number(topicId || 0))) {
        binding.disabled = true
        binding.disabledReason = "artifacts-topic"
        binding.disabledAt = now
      }
      delete data.pendingTopics[String(topicId ?? 0)]
      return data.telegram.artifactsTopic
    })
  }

  soundsTopic() {
    return this.data.telegram.soundsTopic || null
  }

  speechModelId(defaultModelId = "") {
    return String(this.data.telegram.speechModelId || defaultModelId || "")
  }

  async setSpeechModelId(modelId) {
    const selected = String(modelId || "").trim()
    await this.update((data) => {
      data.telegram.speechModelId = selected
    })
    return selected
  }

  soundsMenuMessageId() {
    return this.data.telegram.soundsMenuMessageId || null
  }

  async setSoundsMenuMessageId(messageId) {
    await this.update((data) => {
      data.telegram.soundsMenuMessageId = messageId || null
    })
    return messageId || null
  }

  isSoundsTopic(chatId, topicId) {
    const topic = this.soundsTopic()
    return Boolean(topic && String(topic.chatId) === String(chatId) && Number(topic.topicId || 0) === Number(topicId || 0))
  }

  async setSoundsTopic({ chatId, topicId, title, setBy }) {
    return this.update((data) => {
      const now = new Date().toISOString()
      data.telegram.soundsTopic = {
        chatId,
        topicId,
        title: title || `Topic ${topicId}`,
        setBy,
        setAt: now,
      }
      data.telegram.soundsMenuMessageId = null
      for (const binding of data.bindings.filter((item) => String(item.chatId) === String(chatId) && Number(item.topicId || 0) === Number(topicId || 0))) {
        binding.disabled = true
        binding.disabledReason = "sounds-topic"
        binding.disabledAt = now
      }
      delete data.pendingTopics[String(topicId ?? 0)]
      return data.telegram.soundsTopic
    })
  }

  async clearSoundsTopic(chatId, topicId) {
    return this.update((data) => {
      const topic = data.telegram.soundsTopic
      if (!topic || String(topic.chatId) !== String(chatId) || Number(topic.topicId || 0) !== Number(topicId || 0)) return false
      data.telegram.soundsTopic = null
      data.telegram.soundsMenuMessageId = null
      return true
    })
  }

  // Topic/session bindings and reconcile windows.

  findBinding(serverID, sessionID) {
    return this.data.bindings.find((binding) => !binding.disabled && binding.serverID === serverID && binding.sessionID === sessionID)
  }

  bindings() {
    return this.data.bindings.filter((binding) => !binding.disabled)
  }

  findBindingByTopic(chatId, topicId) {
    return findLatestBindingByTopic(this.data.bindings, chatId, topicId, { activeOnly: true })
  }

  findAnyBindingByTopic(chatId, topicId) {
    return findLatestBindingByTopic(this.data.bindings, chatId, topicId)
  }

  topicRecord(chatId, topicId) {
    return canonicalTopicRecord(this.data, chatId, topicId)
  }

  pendingTopic(topicId) {
    return this.data.pendingTopics[String(topicId ?? 0)]
  }

  async setChatId(chatId) {
    return this.update((data) => {
      data.telegram.chatId = chatId
    })
  }

  async setMirrorEnabled(enabled) {
    return this.update((data) => {
      data.telegram.mirrorEnabled = Boolean(enabled)
    })
  }

  mirrorEnabled(config) {
    return this.data.telegram.mirrorEnabled ?? config.telegram.mirrorEnabled ?? true
  }

  mirrorMode() {
    return normalizeMirrorMode(this.data.telegram?.mirrorMode)
  }

  async setMirrorMode(mode) {
    const normalized = normalizeMirrorMode(mode)
    await this.update((data) => {
      data.telegram ||= {}
      data.telegram.mirrorMode = normalized
    })
    return normalized
  }

  contextTurnsForUser(userID, fallback = 3) {
    const value = Number(this.data.telegram.contextTurnsByUser?.[String(userID)])
    return Number.isInteger(value) && value >= 1 && value <= 10 ? value : fallback
  }

  async setContextTurnsForUser(userID, count) {
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("Context turn count must be an integer from 1 to 10")
    return this.update((data) => {
      data.telegram.contextTurnsByUser ||= {}
      const key = String(userID)
      if (data.telegram.contextTurnsByUser[key] === count) return false
      data.telegram.contextTurnsByUser[key] = count
      return true
    })
  }

  interruptedUserMessageIDs(serverID, sessionID) {
    return new Set(this.data.incompleteRunHistory
      .filter((item) => item?.serverID === serverID && item?.sessionID === sessionID && item?.userMessageID)
      .map((item) => item.userMessageID))
  }

  async bindTopic(binding) {
    return this.update((data) => {
      const existing = data.bindings.findIndex(
        (item) => item.serverID === binding.serverID && item.sessionID === binding.sessionID,
      )
      const normalized = {
        createdAt: new Date().toISOString(),
        mirrorEnabled: true,
        ...binding,
      }
      if (existing >= 0) data.bindings[existing] = { ...data.bindings[existing], ...normalized }
      else data.bindings.push(normalized)
      delete data.pendingTopics[String(binding.topicId ?? 0)]
    })
  }

  hasSeenSession(serverID, sessionID) {
    return this.data.seenSessions.includes(sessionKey(serverID, sessionID))
  }

  async markSeenSession(serverID, sessionID) {
    return this.update((data) => {
      data.seenSessions ||= []
      const key = sessionKey(serverID, sessionID)
      if (!data.seenSessions.includes(key)) data.seenSessions.push(key)
      if (data.seenSessions.length > 5000) data.seenSessions = data.seenSessions.slice(-5000)
    })
  }

  async seedSeenSessions(serverSessions) {
    return this.update((data) => {
      data.seenSessions ||= []
      const existing = new Set(data.seenSessions)
      let added = 0
      for (const [serverID, sessionID] of serverSessions) {
        const key = sessionKey(serverID, sessionID)
        if (existing.has(key)) continue
        existing.add(key)
        data.seenSessions.push(key)
        added += 1
      }
      if (data.seenSessions.length > 5000) data.seenSessions = data.seenSessions.slice(-5000)
      return added || false
    })
  }

  async checkpointBindingReconcileCursor(serverID, sessionID, messageID) {
    if (!messageID) return false
    return this.updateDeferred((data) => {
      const binding = data.bindings.find((item) => item.serverID === serverID && item.sessionID === sessionID)
      if (!binding || binding.reconcileCursorMessageID === messageID) return false
      binding.reconcileCursorMessageID = messageID
      return true
    })
  }

  async updateBindingTitle(serverID, sessionID, title, titleSource = "opencode", topicMetadata = {}) {
    return this.update((data) => {
      const binding = data.bindings.find((item) => item.serverID === serverID && item.sessionID === sessionID)
      if (!binding) return false
      const nextTitle = String(title || "").trim()
      if (!nextTitle) return false
      const now = new Date().toISOString()
      let changed = assignValue(binding, "title", nextTitle)
      changed = assignValue(binding, "titleSource", titleSource === "user" ? "user" : "opencode") || changed
      if (changed) binding.titleUpdatedAt = now
      const topicChanged = applyTopicMetadata(
        topicRecords(data, binding.chatId, binding.topicId),
        {
          titleSource: binding.titleSource,
          topicBaseTitle: topicMetadata.topicBaseTitle || nextTitle,
          topicTitle: topicMetadata.topicTitle || nextTitle,
          ...(typeof topicMetadata.topicServerSuffixManaged === "boolean"
            ? { topicServerSuffixManaged: topicMetadata.topicServerSuffixManaged }
            : {}),
        },
        { now },
      )
      return changed || topicChanged
    })
  }

  async updateTopicMetadata(chatId, targetTopicId, metadata = {}) {
    return this.update((data) => {
      const records = topicRecords(data, chatId, targetTopicId)
      if (!records.length) return false
      return applyTopicMetadata(records, metadata, { includeTitle: true })
    })
  }

  async activateBinding(serverID, sessionID, { reconcileAfter, reconcileUntil, reason } = {}) {
    return this.update((data) => {
      const binding = data.bindings.find((item) => item.serverID === serverID && item.sessionID === sessionID)
      if (!binding) return false
      if (reconcileAfter) binding.reconcileAfter = toIso(reconcileAfter)
      if (reconcileUntil) binding.reconcileUntil = toIso(reconcileUntil)
      delete binding.reconcileUsersOnlyUntil
      binding.lastActiveAt = new Date().toISOString()
      if (reason) binding.lastActiveReason = reason
      return true
    })
  }

  async extendBindingActivity(serverID, sessionID, { reconcileUntil, reconcileUsersOnlyUntil, reason } = {}) {
    return this.update((data) => applyBindingActivity(data, serverID, sessionID, { reconcileUntil, reconcileUsersOnlyUntil, reason }))
  }

  async extendBindingActivityDeferred(serverID, sessionID, { reconcileUntil, reconcileUsersOnlyUntil, reason } = {}) {
    return this.updateDeferred((data) => applyBindingActivity(data, serverID, sessionID, {
      reconcileUntil,
      reconcileUsersOnlyUntil,
      reason,
    }))
  }

  async addPendingTopic(topicId, pending) {
    return this.update((data) => {
      const record = { createdAt: new Date().toISOString(), ...pending }
      data.pendingTopics[String(topicId ?? 0)] = record
      applyTopicMetadata(topicRecords(data, record.chatId, topicId), record, { includeTitle: true })
    })
  }

  async resetBindingToPending(binding, profile = null, reason = "topic-reset") {
    return this.update((data) => {
      const current = data.bindings.find(
        (item) => item.serverID === binding.serverID && item.sessionID === binding.sessionID && !item.disabled,
      )
      if (!current) return null

      const now = new Date().toISOString()
      current.disabled = true
      current.disabledReason = reason
      current.disabledAt = now
      const topicTitle = profile?.topicTitle || current.topicTitle || current.title || "New session"
      const topicBaseTitle = profile?.topicBaseTitle || current.topicBaseTitle || current.topicTitle || current.title || "New session"
      const pending = compactObject({
        chatId: current.chatId,
        topicTitle,
        topicBaseTitle,
        topicServerSuffixManaged: profile?.topicServerSuffixManaged === true,
        topicIconCustomEmojiId: current.topicIconCustomEmojiId,
        topicIconEmoji: current.topicIconEmoji,
        title: profile?.title || topicBaseTitle,
        titleSource: profile?.titleSource || "user",
        serverID: profile?.serverID || current.serverID,
        directory: Object.hasOwn(profile || {}, "directory") ? profile.directory : current.directory,
        chatTemplateName: profile?.chatTemplateName || current.chatTemplateName,
        chatTemplate: profile?.chatTemplate || current.chatTemplate,
        createdAt: now,
      })
      data.pendingTopics[String(current.topicId ?? 0)] = pending
      applyTopicMetadata(topicRecords(data, current.chatId, current.topicId), pending, { includeTitle: true, now })
      return { binding: { ...current }, pending: { ...pending } }
    })
  }

  async updatePendingTopicProfile(topicId, profile) {
    return this.update((data) => {
      const pending = data.pendingTopics[String(topicId ?? 0)]
      if (!pending) return null
      if (Object.hasOwn(profile, "chatTemplateName")) pending.chatTemplateName = profile.chatTemplateName
      if (Object.hasOwn(profile, "chatTemplate")) pending.chatTemplate = profile.chatTemplate
      if (profile.serverID) pending.serverID = profile.serverID
      if (Object.hasOwn(profile, "directory")) {
        if (profile.directory === undefined) delete pending.directory
        else pending.directory = profile.directory
      }
      for (const key of ["title", "titleSource", "topicTitle", "topicBaseTitle", "topicServerSuffixManaged"]) {
        if (Object.hasOwn(profile, key)) pending[key] = profile[key]
      }
      pending.updatedAt = new Date().toISOString()
      applyTopicMetadata(topicRecords(data, pending.chatId, topicId), profile, {
        includeTitle: true,
        now: pending.updatedAt,
      })
      return { ...pending }
    })
  }

  async removePendingTopic(topicId) {
    return this.update((data) => {
      delete data.pendingTopics[String(topicId ?? 0)]
    })
  }

  // Telegram-origin prompt markers.

  async addPendingPrompt(marker) {
    return this.update((data) => {
      const cutoff = Date.now() - 10 * 60 * 1000
      data.pendingPrompts = data.pendingPrompts.filter((item) => Date.parse(item.createdAt) > cutoff)
      data.pendingPrompts.push({ createdAt: new Date().toISOString(), ...marker })
    })
  }

  async consumePendingPrompt(serverID, sessionID, text) {
    const hash = promptHash(text)
    return this.update((data) => {
      const index = data.pendingPrompts.findIndex(
        (item) => item.serverID === serverID && item.sessionID === sessionID && item.hash === hash,
      )
      if (index === -1) return null
      const [matched] = data.pendingPrompts.slice(index, index + 1)
      data.pendingPrompts.splice(index, 1)
      return matched
    })
  }

  async markPendingPromptPinned(serverID, sessionID, text, messageId) {
    const hash = promptHash(text)
    return this.update((data) => {
      const marker = data.pendingPrompts.find(
        (item) => item.serverID === serverID && item.sessionID === sessionID && item.hash === hash && Number(item.messageId || 0) === Number(messageId || 0),
      )
      if (!marker) return false
      marker.pinnedAt = new Date().toISOString()
      return true
    })
  }

  async removePendingPrompt(serverID, sessionID, text) {
    const hash = promptHash(text)
    return this.update((data) => {
      data.pendingPrompts = data.pendingPrompts.filter(
        (item) => !(item.serverID === serverID && item.sessionID === sessionID && item.hash === hash),
      )
    })
  }

  // Durable Telegram -> OpenCodez prompt links. They make reply-to-rewind safe
  // across bot restarts without retaining prompt text or attachment contents.

  findPromptOrigin({ chatID, topicID, telegramMessageID }) {
    const chat = String(chatID)
    const topic = String(topicID ?? "")
    const messageID = Number(telegramMessageID)
    if (!Number.isSafeInteger(messageID)) return null

    for (let index = this.data.promptOrigins.length - 1; index >= 0; index -= 1) {
      const origin = this.data.promptOrigins[index]
      if (origin.chatID !== chat || origin.topicID !== topic || origin.telegramMessageID !== messageID) continue
      return { ...origin }
    }
    return null
  }

  async recordPromptOrigin({ chatID, topicID, telegramMessageID, serverID, sessionID, opencodeMessageID }) {
    const origin = {
      chatID: String(chatID),
      topicID: String(topicID ?? ""),
      telegramMessageID: Number(telegramMessageID),
      serverID: String(serverID),
      sessionID: String(sessionID),
      opencodeMessageID: String(opencodeMessageID),
      status: "active",
      createdAt: new Date().toISOString(),
    }
    if (!Number.isSafeInteger(origin.telegramMessageID)) throw new Error("Telegram message id is required to record prompt origin")

    return this.update((data) => {
      data.promptOrigins ||= []
      const existing = data.promptOrigins.findIndex(
        (item) =>
          item.chatID === origin.chatID &&
          item.topicID === origin.topicID &&
          item.telegramMessageID === origin.telegramMessageID,
      )
      if (existing >= 0) data.promptOrigins.splice(existing, 1)
      data.promptOrigins.push(origin)
      if (data.promptOrigins.length > MAX_PROMPT_ORIGINS) data.promptOrigins.splice(0, data.promptOrigins.length - MAX_PROMPT_ORIGINS)
    })
  }

  async markPromptOriginsRewound(serverID, sessionID, targetMessageID) {
    const server = String(serverID)
    const session = String(sessionID)
    const target = String(targetMessageID)
    let rewound = 0

    await this.update((data) => {
      let afterTarget = false
      for (const origin of data.promptOrigins || []) {
        if (origin.serverID !== server || origin.sessionID !== session) continue
        if (origin.opencodeMessageID === target) afterTarget = true
        if (!afterTarget || origin.status !== "active") continue
        origin.status = "rewound"
        origin.rewoundAt = new Date().toISOString()
        rewound += 1
      }
    })
    return rewound
  }

  // Final-answer DM notification preferences and dedupe markers.

  debugEnabled() {
    return this.data.debugEnabled === true
  }

  async setDebugEnabled(enabled) {
    return this.update((data) => {
      data.debugEnabled = enabled === true
    })
  }

  finalNotificationUserIds() {
    return [...new Set((this.data.finalNotifications?.enabledUserIds || []).map(String))]
  }

  finalNotificationsEnabledFor(userID) {
    return this.finalNotificationUserIds().includes(String(userID))
  }

  async enableFinalNotificationsFor(userID) {
    return this.update((data) => {
      data.finalNotifications ||= { enabledUserIds: [], sentMessages: [] }
      data.finalNotifications.enabledUserIds ||= []
      const value = String(userID)
      if (!data.finalNotifications.enabledUserIds.map(String).includes(value)) data.finalNotifications.enabledUserIds.push(value)
    })
  }

  async disableFinalNotificationsFor(userID) {
    return this.update((data) => {
      data.finalNotifications ||= { enabledUserIds: [], sentMessages: [] }
      data.finalNotifications.enabledUserIds = (data.finalNotifications.enabledUserIds || []).filter((item) => String(item) !== String(userID))
    })
  }

  finalNotificationSent(userID, serverID, sessionID, assistantMessageID) {
    const sent = this.data.finalNotifications?.sentMessages || []
    const key = finalNotificationKey(userID, serverID, sessionID, assistantMessageID)
    const legacyPrefix = legacyFinalNotificationPrefix(serverID, sessionID, assistantMessageID)
    return sent.includes(key) || sent.some((item) => item.startsWith(legacyPrefix))
  }

  async markFinalNotificationSent(userID, serverID, sessionID, assistantMessageID, maxItems = 1000) {
    return this.update((data) => {
      data.finalNotifications ||= { enabledUserIds: [], sentMessages: [] }
      data.finalNotifications.sentMessages ||= []
      const key = finalNotificationKey(userID, serverID, sessionID, assistantMessageID)
      if (!data.finalNotifications.sentMessages.includes(key)) data.finalNotifications.sentMessages.push(key)
      if (data.finalNotifications.sentMessages.length > maxItems) {
        data.finalNotifications.sentMessages = data.finalNotifications.sentMessages.slice(-maxItems)
      }
    })
  }

  incompleteRunHandled(key) {
    return this.data.incompleteRunHistory.some((item) => item?.key === key)
  }

  async markIncompleteRunHandled(item, maxItems = 1000) {
    if (this.incompleteRunHandled(item.key)) return false
    await this.update((data) => {
      data.incompleteRunHistory ||= []
      data.incompleteRunHistory.push({ ...item, handledAt: new Date().toISOString() })
      if (data.incompleteRunHistory.length > maxItems) {
        data.incompleteRunHistory = data.incompleteRunHistory.slice(-maxItems)
      }
    })
    return true
  }

  isAssistantMirrored(serverID, sessionID, messageID) {
    return hasMirroredMessage(this.data.mirroredAssistantBySession, serverID, sessionID, messageID)
  }

  async markAssistantMirrored(serverID, sessionID, messageID) {
    return this.appendMirrorMarkers("assistant", serverID, sessionID, [messageID])
  }

  async markAssistantMirroredMany(serverID, sessionID, messageIDs) {
    return this.appendMirrorMarkers("assistant", serverID, sessionID, messageIDs)
  }

  isUserMirrored(serverID, sessionID, messageID) {
    return hasMirroredMessage(this.data.mirroredUserBySession, serverID, sessionID, messageID)
  }

  async markUserMirrored(serverID, sessionID, messageID) {
    return this.appendMirrorMarkers("user", serverID, sessionID, [messageID])
  }

  questionRecord(requestID) {
    return this.data.questionMessages?.find((item) => item.requestID === requestID) || null
  }

  questionRecords() {
    return [...(this.data.questionMessages || [])]
  }

  hasPendingQuestion(serverID, sessionID) {
    return (this.data.questionMessages || []).some((item) => item.serverID === serverID && item.sessionID === sessionID && item.status === "pending")
  }

  async upsertQuestion(record, maxItems = 250) {
    return this.update((data) => {
      data.questionMessages ||= []
      const index = data.questionMessages.findIndex((item) => item.requestID === record.requestID)
      const next = { ...(index >= 0 ? data.questionMessages[index] : {}), ...record, updatedAt: new Date().toISOString() }
      if (index >= 0) data.questionMessages[index] = next
      else data.questionMessages.push(next)
      if (data.questionMessages.length > maxItems) data.questionMessages = data.questionMessages.slice(-maxItems)
      return next
    })
  }

  async resolveQuestion(requestID, status, answers = []) {
    return this.update((data) => {
      const record = (data.questionMessages || []).find((item) => item.requestID === requestID)
      if (!record) return null
      record.status = status
      record.answers = answers
      record.updatedAt = new Date().toISOString()
      return record
    })
  }

  async disableBinding(serverID, sessionID, reason) {
    return this.update((data) => {
      const binding = data.bindings.find((item) => item.serverID === serverID && item.sessionID === sessionID)
      if (!binding) return false
      binding.disabled = true
      binding.disabledReason = reason
      binding.disabledAt = new Date().toISOString()
      return true
    })
  }
}

export function promptHash(text) {
  let hash = 5381
  for (const char of String(text)) hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0
  return hash.toString(16)
}

function defaultState() {
  return {
    version: 1,
    telegram: { mirrorMode: "full", contextTurnsByUser: {}, artifactsTopic: null, soundsTopic: null },
    bindings: [],
    pendingTopics: {},
    pendingPrompts: [],
    mirroredAssistantBySession: {},
    mirroredUserBySession: {},
    debugEnabled: false,
    finalNotifications: { enabledUserIds: [], sentMessages: [] },
    incompleteRunHistory: [],
    questionMessages: [],
    seenSessions: [],
    runtime: {},
  }
}

function normalizeMirrorMode(value) {
  return String(value || "").trim().toLowerCase() === "economy" ? "economy" : "full"
}

function normalizeContextTurnsByUser(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, count]) => {
    const numeric = Number(count)
    return Number.isInteger(numeric) && numeric >= 1 && numeric <= 10
  }).map(([userID, count]) => [userID, Number(count)]))
}

function migrateContextTurnsByUser(telegram) {
  const source = telegram.contextTurnsByUser || telegram.contextPairsByUser
  const normalized = normalizeContextTurnsByUser(source)
  const changed = JSON.stringify(telegram.contextTurnsByUser || {}) !== JSON.stringify(normalized)
    || Object.hasOwn(telegram, "contextPairsByUser")
  telegram.contextTurnsByUser = normalized
  delete telegram.contextPairsByUser
  return changed
}

function sessionKey(serverID, sessionID) {
  return `${serverID}:${sessionID}`
}

function finalNotificationKey(userID, serverID, sessionID, assistantMessageID) {
  return `${userID}:${serverID}:${sessionID}:${assistantMessageID || "unknown"}`
}

function legacyFinalNotificationPrefix(serverID, sessionID, assistantMessageID) {
  return `${serverID}:${sessionID}:${assistantMessageID || "unknown"}:`
}

function sessionMirrorKey(serverID, sessionID) {
  return `${serverID}:${sessionID}`
}

function hasMirroredMessage(bySession, serverID, sessionID, messageID) {
  const key = sessionMirrorKey(serverID, sessionID)
  return Boolean(bySession?.[key]?.includes(messageID))
}

function addMirroredMessage(bySession, serverID, sessionID, messageID) {
  const key = sessionMirrorKey(serverID, sessionID)
  bySession[key] ||= []
  if (bySession[key].includes(messageID)) return false
  bySession[key].push(messageID)
  return true
}

function hasMirrorMarkers(data) {
  return Object.keys(data.mirroredAssistantBySession || {}).length > 0 || Object.keys(data.mirroredUserBySession || {}).length > 0
}

function mirrorMarkerLines(bySession, kind) {
  const lines = []
  for (const [key, messageIDs] of Object.entries(bySession || {})) {
    const separator = key.indexOf(":")
    if (separator < 0) continue
    const serverID = key.slice(0, separator)
    const sessionID = key.slice(separator + 1)
    for (const messageID of messageIDs || []) lines.push(mirrorMarkerLine(kind, serverID, sessionID, messageID))
  }
  return lines
}

function mirrorMarkerLine(kind, serverID, sessionID, messageID) {
  return JSON.stringify([kind === "user" ? "u" : "a", serverID, sessionID, messageID])
}

function pruneState(data) {
  let changed = false
  changed = pruneMirroredBuckets(data.mirroredAssistantBySession) || changed
  changed = pruneMirroredBuckets(data.mirroredUserBySession) || changed
  const incompleteRunHistory = data.incompleteRunHistory.filter((item) => item && typeof item.key === "string")
  if (incompleteRunHistory.length !== data.incompleteRunHistory.length || incompleteRunHistory.length > 1000) {
    data.incompleteRunHistory = incompleteRunHistory.slice(-1000)
    changed = true
  }
  return changed
}

function pruneMirroredBuckets(bySession) {
  if (!bySession || typeof bySession !== "object") return false
  let changed = false
  for (const [key, value] of Object.entries(bySession)) {
    if (!Array.isArray(value)) {
      delete bySession[key]
      changed = true
      continue
    }
  }
  const keys = Object.keys(bySession)
  if (keys.length > MIRRORED_SESSION_BUCKET_LIMIT) {
    for (const key of keys.slice(0, keys.length - MIRRORED_SESSION_BUCKET_LIMIT)) delete bySession[key]
    changed = true
  }
  return changed
}

function toIso(value) {
  const ms = toMillis(value)
  return ms ? new Date(ms).toISOString() : undefined
}

function toMillis(value) {
  if (!value) return 0
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function applyBindingActivity(data, serverID, sessionID, { reconcileUntil, reconcileUsersOnlyUntil, reason } = {}) {
  const binding = data.bindings.find((item) => item.serverID === serverID && item.sessionID === sessionID)
  if (!binding) return false
  const nextUntil = toMillis(reconcileUntil)
  const currentUntil = toMillis(binding.reconcileUntil)
  if (nextUntil && nextUntil > currentUntil) binding.reconcileUntil = toIso(nextUntil)
  const nextUsersOnlyUntil = toMillis(reconcileUsersOnlyUntil)
  const currentUsersOnlyUntil = toMillis(binding.reconcileUsersOnlyUntil)
  if (nextUsersOnlyUntil && nextUsersOnlyUntil > currentUsersOnlyUntil) binding.reconcileUsersOnlyUntil = toIso(nextUsersOnlyUntil)
  binding.lastActiveAt = new Date().toISOString()
  if (reason) binding.lastActiveReason = reason
  return true
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function assignValue(record, key, value) {
  if (record[key] === value) return false
  record[key] = value
  return true
}

function topicMatches(record, chatId, topicId) {
  return String(record?.chatId) === String(chatId) && String(record?.topicId ?? 0) === String(topicId ?? 0)
}

function findLatestBindingByTopic(bindings, chatId, topicId, { activeOnly = false } = {}) {
  for (let index = bindings.length - 1; index >= 0; index -= 1) {
    const binding = bindings[index]
    if (activeOnly && binding.disabled) continue
    if (topicMatches(binding, chatId, topicId)) return binding
  }
  return undefined
}

function topicRecords(data, chatId, topicId) {
  const records = data.bindings.filter((binding) => topicMatches(binding, chatId, topicId))
  const pending = data.pendingTopics?.[String(topicId ?? 0)]
  if (pending && String(pending.chatId) === String(chatId)) records.push(pending)
  return records
}

function recordTimestamp(record, field) {
  return toMillis(record?.[field] || record?.titleUpdatedAt || record?.updatedAt || record?.createdAt)
}

function latestTopicRecord(records, field, predicate) {
  let selected
  let selectedTimestamp = -1
  for (const record of records) {
    if (!predicate(record)) continue
    const timestamp = recordTimestamp(record, field)
    if (timestamp < selectedTimestamp) continue
    selected = record
    selectedTimestamp = timestamp
  }
  return selected
}

function latestTitleRecord(records) {
  const userOwned = records.filter((record) => record.titleSource === "user")
  const candidates = userOwned.length ? userOwned : records
  const explicitlyUpdated = candidates.filter((record) => Boolean(record.topicTitleUpdatedAt))
  const timestamped = explicitlyUpdated.length ? explicitlyUpdated : candidates
  return latestTopicRecord(
    timestamped,
    "topicTitleUpdatedAt",
    (record) => Boolean(record.topicTitle || record.topicBaseTitle || record.title),
  )
}

function canonicalTopicRecord(data, chatId, topicId) {
  const records = topicRecords(data, chatId, topicId)
  if (!records.length) return undefined
  const pending = data.pendingTopics?.[String(topicId ?? 0)]
  const context =
    (pending && String(pending.chatId) === String(chatId) ? pending : undefined) ||
    findLatestBindingByTopic(data.bindings, chatId, topicId, { activeOnly: true }) ||
    findLatestBindingByTopic(data.bindings, chatId, topicId)
  const titleRecord = latestTitleRecord(records)
  const iconRecord = latestTopicRecord(
    records,
    "topicIconUpdatedAt",
    (record) => Boolean(record.topicIconUpdatedAt) || Object.hasOwn(record, "topicIconCustomEmojiId") || Object.hasOwn(record, "topicIconEmoji"),
  )
  const canonical = { ...context }
  for (const key of TOPIC_TITLE_FIELDS) {
    if (titleRecord && Object.hasOwn(titleRecord, key)) canonical[key] = titleRecord[key]
  }
  if (titleRecord?.titleSource === "user") canonical.title = titleRecord.topicBaseTitle || titleRecord.title
  if (iconRecord) {
    delete canonical.topicIconCustomEmojiId
    delete canonical.topicIconEmoji
    for (const key of TOPIC_ICON_FIELDS) {
      if (Object.hasOwn(iconRecord, key)) canonical[key] = iconRecord[key]
    }
  }
  return canonical
}

function applyTopicMetadata(records, metadata, { includeTitle = false, now = new Date().toISOString() } = {}) {
  if (!records.length) return false
  const titleTimestamp = metadata.topicTitleUpdatedAt || now
  const iconTimestamp = metadata.topicIconUpdatedAt || now
  let changed = false

  for (const record of records) {
    let titleChanged = false
    let iconChanged = false
    if (includeTitle) {
      const title = String(metadata.title || "").trim()
      if (title) titleChanged = assignValue(record, "title", title) || titleChanged
    }
    if (metadata.titleSource === "user" || metadata.titleSource === "opencode") {
      titleChanged = assignValue(record, "titleSource", metadata.titleSource) || titleChanged
    }
    for (const key of ["topicBaseTitle", "topicTitle"]) {
      const value = String(metadata[key] || "").trim()
      if (value) titleChanged = assignValue(record, key, value) || titleChanged
    }
    if (Object.hasOwn(metadata, "topicServerSuffixManaged")) {
      titleChanged = assignValue(record, "topicServerSuffixManaged", metadata.topicServerSuffixManaged === true) || titleChanged
    }
    if (titleChanged) {
      record.topicTitleUpdatedAt = titleTimestamp
      if (includeTitle) record.titleUpdatedAt = titleTimestamp
    } else if (metadata.topicTitleUpdatedAt && record.topicTitleUpdatedAt !== metadata.topicTitleUpdatedAt) {
      record.topicTitleUpdatedAt = metadata.topicTitleUpdatedAt
      titleChanged = true
    }

    for (const key of ["topicIconCustomEmojiId", "topicIconEmoji"]) {
      if (!Object.hasOwn(metadata, key)) continue
      const value = String(metadata[key] || "").trim()
      if (value) iconChanged = assignValue(record, key, value) || iconChanged
      else if (Object.hasOwn(record, key)) {
        delete record[key]
        iconChanged = true
      }
    }
    if (iconChanged) record.topicIconUpdatedAt = iconTimestamp
    else if (metadata.topicIconUpdatedAt && record.topicIconUpdatedAt !== metadata.topicIconUpdatedAt) {
      record.topicIconUpdatedAt = metadata.topicIconUpdatedAt
      iconChanged = true
    }
    changed = titleChanged || iconChanged || changed
  }
  return changed
}

function reconcileTopicMetadata(data) {
  const groups = new Map()
  for (const binding of data.bindings) {
    const key = bindingTopicKey(binding)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(binding)
  }
  for (const [topicId, pending] of Object.entries(data.pendingTopics || {})) {
    const key = `${String(pending.chatId ?? data.telegram?.chatId ?? "")}:${Number(topicId || 0)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(pending)
  }

  let changed = false
  for (const records of groups.values()) {
    if (records.length < 2) continue
    const titleRecord = latestTitleRecord(records)
    if (titleRecord) {
      const titlePatch = Object.fromEntries(
        TOPIC_TITLE_FIELDS.filter((key) => Object.hasOwn(titleRecord, key)).map((key) => [key, titleRecord[key]]),
      )
      if (titleRecord.titleSource === "user") titlePatch.title = titleRecord.topicBaseTitle || titleRecord.title
      changed =
        applyTopicMetadata(records, titlePatch, {
          includeTitle: titleRecord.titleSource === "user",
          now: titleRecord.topicTitleUpdatedAt || titleRecord.titleUpdatedAt || new Date().toISOString(),
        }) || changed
    }
    const iconRecord = latestTopicRecord(
      records,
      "topicIconUpdatedAt",
      (record) => Boolean(record.topicIconUpdatedAt) || Object.hasOwn(record, "topicIconCustomEmojiId") || Object.hasOwn(record, "topicIconEmoji"),
    )
    if (iconRecord) {
      const iconPatch = {
        topicIconCustomEmojiId: iconRecord.topicIconCustomEmojiId || "",
        topicIconEmoji: iconRecord.topicIconEmoji || "",
        ...(iconRecord.topicIconUpdatedAt ? { topicIconUpdatedAt: iconRecord.topicIconUpdatedAt } : {}),
      }
      changed =
        applyTopicMetadata(records, iconPatch, {
          now: iconRecord.topicIconUpdatedAt || iconRecord.updatedAt || new Date().toISOString(),
        }) || changed
    }
  }
  return changed
}

function migrateResetTitleOwnership(data) {
  const resetTopics = new Set(
    data.bindings
      .filter((binding) => binding.disabled && binding.disabledReason === "topic-reset")
      .map((binding) => bindingTopicKey(binding)),
  )
  let changed = false

  for (const binding of data.bindings) {
    if (binding.disabled || !resetTopics.has(bindingTopicKey(binding)) || binding.titleSource === "user") continue
    binding.titleSource = "user"
    binding.titleUpdatedAt = new Date().toISOString()
    changed = true
  }

  for (const [topicId, pending] of Object.entries(data.pendingTopics || {})) {
    const key = `${String(pending.chatId ?? data.telegram?.chatId ?? "")}:${Number(topicId || 0)}`
    if (!resetTopics.has(key)) continue
    const topicTitle = pending.topicTitle || pending.title || "New session"
    if (pending.titleSource === "user" && pending.title === topicTitle && pending.topicTitle === topicTitle) continue
    pending.titleSource = "user"
    pending.title = topicTitle
    pending.topicTitle = topicTitle
    changed = true
  }

  return changed
}

function bindingTopicKey(binding) {
  return `${String(binding.chatId ?? "")}:${Number(binding.topicId || 0)}`
}
