import fs from "node:fs/promises"
import path from "node:path"

const MIRRORED_SESSION_BUCKET_LIMIT = 250
const MAX_PROMPT_ORIGINS = 5_000

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath
    this.data = defaultState()
    this.queue = Promise.resolve()
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
      this.data.questionMessages ||= []
      this.data.seenSessions ||= []
      this.data.telegram ||= {}
      this.data.telegram.mirrorMode = normalizeMirrorMode(this.data.telegram.mirrorMode)
      this.data.telegram.artifactsTopic ||= null
      this.data.telegram.soundsTopic ||= null
      this.data.runtime ||= {}
      const migratedResetTitles = migrateResetTitleOwnership(this.data)
      const pruned = pruneState(this.data)
      if (migratedResetTitles || pruned) await this.save()
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      this.data = defaultState()
      await this.save()
    }
    return this.data
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.${process.pid}.tmp`
    await fs.writeFile(temp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 })
    await fs.rename(temp, this.filePath)
  }

  async update(mutator) {
    const update = this.queue.then(async () => {
      const result = await mutator(this.data)
      await this.save()
      return result
    })
    this.queue = update.catch(() => undefined)
    return update
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
    return this.data.bindings.find(
      (binding) => !binding.disabled && String(binding.chatId) === String(chatId) && String(binding.topicId ?? 0) === String(topicId ?? 0),
    )
  }

  findAnyBindingByTopic(chatId, topicId) {
    return [...this.data.bindings].reverse().find(
      (binding) => String(binding.chatId) === String(chatId) && String(binding.topicId ?? 0) === String(topicId ?? 0),
    )
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
      return added
    })
  }

  async updateBindingTitle(serverID, sessionID, title, titleSource = "opencode") {
    return this.update((data) => {
      const binding = data.bindings.find((item) => item.serverID === serverID && item.sessionID === sessionID)
      if (!binding) return false
      if (binding.title === title && binding.titleSource === titleSource && binding.topicTitle === title) return false
      binding.title = title
      binding.titleSource = titleSource
      binding.titleUpdatedAt = new Date().toISOString()
      binding.topicTitle = title
      binding.topicTitleUpdatedAt = binding.titleUpdatedAt
      return true
    })
  }

  async updateBindingTopicMetadata(chatId, targetTopicId, metadata = {}) {
    return this.update((data) => {
      const binding = data.bindings.find((item) => String(item.chatId) === String(chatId) && String(item.topicId) === String(targetTopicId))
      if (!binding) return false
      let changed = false

      const title = String(metadata.title || "").trim()
      if (title && binding.topicTitle !== title) {
        binding.topicTitle = title
        binding.topicTitleUpdatedAt = new Date().toISOString()
        changed = true
      }

      if (Object.hasOwn(metadata, "topicIconCustomEmojiId")) {
        const icon = String(metadata.topicIconCustomEmojiId || "").trim()
        if (icon && binding.topicIconCustomEmojiId !== icon) {
          binding.topicIconCustomEmojiId = icon
          changed = true
        } else if (!icon && binding.topicIconCustomEmojiId) {
          delete binding.topicIconCustomEmojiId
          changed = true
        }
      }

      if (Object.hasOwn(metadata, "topicIconEmoji")) {
        const emoji = String(metadata.topicIconEmoji || "").trim()
        if (emoji && binding.topicIconEmoji !== emoji) {
          binding.topicIconEmoji = emoji
          changed = true
        } else if (!emoji && binding.topicIconEmoji) {
          delete binding.topicIconEmoji
          changed = true
        }
      }

      return changed
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
    return this.update((data) => {
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
    })
  }

  async addPendingTopic(topicId, pending) {
    return this.update((data) => {
      data.pendingTopics[String(topicId ?? 0)] = { createdAt: new Date().toISOString(), ...pending }
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
      const topicTitle = current.topicTitle || current.title || "New session"
      const pending = compactObject({
        chatId: current.chatId,
        topicTitle,
        topicIconCustomEmojiId: current.topicIconCustomEmojiId,
        topicIconEmoji: current.topicIconEmoji,
        title: topicTitle,
        titleSource: "user",
        serverID: current.serverID,
        directory: current.directory,
        chatTemplateName: profile?.chatTemplateName || current.chatTemplateName,
        chatTemplate: profile?.chatTemplate || current.chatTemplate,
        createdAt: now,
      })
      data.pendingTopics[String(current.topicId ?? 0)] = pending
      return { binding: { ...current }, pending: { ...pending } }
    })
  }

  async updatePendingTopicProfile(topicId, profile) {
    return this.update((data) => {
      const pending = data.pendingTopics[String(topicId ?? 0)]
      if (!pending) return null
      pending.chatTemplateName = profile.chatTemplateName
      pending.chatTemplate = profile.chatTemplate
      pending.updatedAt = new Date().toISOString()
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

  finalNotificationSent(serverID, sessionID, assistantMessageID, messageID) {
    return (this.data.finalNotifications?.sentMessages || []).includes(finalNotificationKey(serverID, sessionID, assistantMessageID, messageID))
  }

  async markFinalNotificationSent(serverID, sessionID, assistantMessageID, messageID, maxItems = 1000) {
    return this.update((data) => {
      data.finalNotifications ||= { enabledUserIds: [], sentMessages: [] }
      data.finalNotifications.sentMessages ||= []
      const key = finalNotificationKey(serverID, sessionID, assistantMessageID, messageID)
      if (!data.finalNotifications.sentMessages.includes(key)) data.finalNotifications.sentMessages.push(key)
      if (data.finalNotifications.sentMessages.length > maxItems) {
        data.finalNotifications.sentMessages = data.finalNotifications.sentMessages.slice(-maxItems)
      }
    })
  }

  isAssistantMirrored(serverID, sessionID, messageID) {
    return hasMirroredMessage(this.data.mirroredAssistantBySession, serverID, sessionID, messageID)
  }

  async markAssistantMirrored(serverID, sessionID, messageID) {
    return this.update((data) => {
      data.mirroredAssistantBySession ||= {}
      markMirroredMessage(data.mirroredAssistantBySession, serverID, sessionID, messageID)
    })
  }

  isUserMirrored(serverID, sessionID, messageID) {
    return hasMirroredMessage(this.data.mirroredUserBySession, serverID, sessionID, messageID)
  }

  async markUserMirrored(serverID, sessionID, messageID) {
    return this.update((data) => {
      data.mirroredUserBySession ||= {}
      markMirroredMessage(data.mirroredUserBySession, serverID, sessionID, messageID)
    })
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
    telegram: { mirrorMode: "full", artifactsTopic: null, soundsTopic: null },
    bindings: [],
    pendingTopics: {},
    pendingPrompts: [],
    mirroredAssistantBySession: {},
    mirroredUserBySession: {},
    debugEnabled: false,
    finalNotifications: { enabledUserIds: [], sentMessages: [] },
    questionMessages: [],
    seenSessions: [],
    runtime: {},
  }
}

function normalizeMirrorMode(value) {
  return String(value || "").trim().toLowerCase() === "economy" ? "economy" : "full"
}

function sessionKey(serverID, sessionID) {
  return `${serverID}:${sessionID}`
}

function finalNotificationKey(serverID, sessionID, assistantMessageID, messageID) {
  return `${serverID}:${sessionID}:${assistantMessageID || "unknown"}:${messageID || "unknown"}`
}

function sessionMirrorKey(serverID, sessionID) {
  return `${serverID}:${sessionID}`
}

function hasMirroredMessage(bySession, serverID, sessionID, messageID) {
  const key = sessionMirrorKey(serverID, sessionID)
  return Boolean(bySession?.[key]?.includes(messageID))
}

function markMirroredMessage(bySession, serverID, sessionID, messageID) {
  const key = sessionMirrorKey(serverID, sessionID)
  bySession[key] ||= []
  if (!bySession[key].includes(messageID)) bySession[key].push(messageID)
  pruneMirroredBuckets(bySession)
}

function pruneState(data) {
  let changed = false
  changed = pruneMirroredBuckets(data.mirroredAssistantBySession) || changed
  changed = pruneMirroredBuckets(data.mirroredUserBySession) || changed
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

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
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
