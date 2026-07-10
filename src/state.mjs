import fs from "node:fs/promises"
import path from "node:path"

const MIRRORED_SESSION_BUCKET_LIMIT = 250

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
      this.data.mirroredAssistantBySession ||= {}
      this.data.mirroredUserBySession ||= {}
      this.data.finalNotifications ||= { enabledUserIds: [], sentMessages: [] }
      this.data.finalNotifications.enabledUserIds ||= []
      this.data.finalNotifications.sentMessages ||= []
      this.data.seenSessions ||= []
      this.data.telegram ||= {}
      this.data.telegram.mirrorMode = normalizeMirrorMode(this.data.telegram.mirrorMode)
      this.data.telegram.artifactsTopic ||= null
      this.data.telegram.soundsTopic ||= null
      this.data.runtime ||= {}
      if (pruneState(this.data)) await this.save()
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
    this.queue = this.queue.then(async () => {
      const result = await mutator(this.data)
      await this.save()
      return result
    })
    return this.queue
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
      if (binding.title === title) return false
      binding.title = title
      binding.titleSource = titleSource
      binding.titleUpdatedAt = new Date().toISOString()
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

  // Final-answer DM notification preferences and dedupe markers.

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
    finalNotifications: { enabledUserIds: [], sentMessages: [] },
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
