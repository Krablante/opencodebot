import { durationMs, logErrorEvent, logInfo, shouldLogSlow } from "./logger.mjs"
import { textFromPrompt, visibleTextFromParts } from "./opencode.mjs"
import { formatToolLine } from "./render.mjs"
import { runAfterFlight, runSingleFlight } from "./single-flight.mjs"
import { escapeHtml } from "./telegram.mjs"
import { managedTopicTitle, topicBaseTitle } from "./topic-titles.mjs"

export function createSessionReconciler({
  config,
  state,
  telegram,
  opencode,
  renderer,
  promptQueue,
  questionManager,
  backendRequest,
  skippedBackendRequest,
  createTopicForSession,
  createTopicForWebSession,
  isInternalSession,
  activateBindingForPrompt,
  maybeExtendBindingActivity,
  logError,
  shouldStop,
  incompleteRunGraceMs = 1500,
}) {
  const bindingOperations = new Map()
  const incompleteChecks = new Map()
  const incompleteNotifications = new Set()
  const latestUserMessages = new Map()
  const manualCompactions = new Set()
  const finalNotificationAttempts = new Map()
  const reconcileTimers = new Map()

  function activeBinding(binding) {
    const current = state.findBinding(binding.serverID, binding.sessionID)
    if (!current || current.disabled) return null
    if (String(current.chatId) !== String(binding.chatId) || String(current.topicId) !== String(binding.topicId)) return null
    return current
  }

  function handleOpenCodeEvent(server, event) {
    const sessionID = eventSessionID(event.properties)
    if (!sessionID) return Promise.resolve()
    return runAfterFlight(
      bindingOperations,
      `${server.id}:${sessionID}`,
      () => handleOpenCodeEventNow(server, event),
    )
  }

  async function handleOpenCodeEventNow(server, event) {
    const startedAt = Date.now()
    const properties = event.properties || {}
    const sessionID = eventSessionID(properties)
    if (!sessionID) return

    if (event.type === "question.replied" || event.type === "question.rejected") {
      await questionManager?.handleEvent(server, null, event)
      return
    }
    if (!state.mirrorEnabled(config)) return

    let binding = state.findBinding(server.id, sessionID)
    if (!binding && event.type === "session.next.prompted" && config.telegram.autocreateTopics) {
      binding = await createTopicForWebSession(server.id, sessionID, textFromPrompt(properties.prompt))
    }
    if (!binding && event.type === "question.asked" && config.telegram.autocreateTopics) {
      await delay(500)
      binding = state.findBinding(server.id, sessionID)
      if (!binding) binding = await createTopicForWebSession(server.id, sessionID, properties.questions?.[0]?.question || "OpenCodez question")
    }
    if (!binding || binding.disabled) return
    const key = bindingKey(binding)
    if (isManualCompactionPart(properties.part)) {
      manualCompactions.add(key)
      logInfo("compact.detected", { source: server.id, sessionID, topicId: binding.topicId })
    }
    const manualCompaction = manualCompactions.has(key)
    const userMessage = event.type === "message.updated" && properties.info?.role === "user"
    const newUserRun = userMessage && startRun(binding, properties.info.id)
    if (event.type === "session.next.prompted" || newUserRun) {
      await activateBindingForPrompt(binding, event.type === "session.next.prompted" ? "web-prompt" : "user-message")
    } else await maybeExtendBindingActivity(binding, "opencode-event")
    if (newUserRun && !promptQueue.hasExpectedStop(binding)) promptQueue.markBusy(binding)
    const fields = () => ({
      source: server.id,
      sessionID,
      topicId: binding.topicId,
      type: event.type,
      assistantMessageID: properties.assistantMessageID,
      messageID: properties.messageID,
      partID: properties.partID,
    })

    try {
      switch (event.type) {
        case "session.next.prompted": {
          startRun(binding, properties.messageID)
          promptQueue.clearExpectedStop(binding)
          promptQueue.markBusy(binding)
          const text = textFromPrompt(properties.prompt)
          if (!text) {
            if (properties.messageID) await state.markUserMirrored(server.id, sessionID, properties.messageID)
            return
          }
          const consumed = await state.consumePendingPrompt(server.id, sessionID, text)
          if (consumed) {
            await recordConsumedPromptOrigin(binding, consumed, properties.messageID)
            await pinConsumedTelegramPrompt(binding, consumed)
          } else {
            await renderer.userPrompt(binding, text, "web")
          }
          if (properties.messageID) await state.markUserMirrored(server.id, sessionID, properties.messageID)
          break
        }
        case "question.asked":
        case "question.replied":
        case "question.rejected":
          await questionManager?.handleEvent(server, binding, event)
          break
        case "session.next.text.delta":
          if (manualCompaction) break
          await renderer.textDelta(binding, properties)
          break
        case "session.next.text.ended":
          if (manualCompaction) break
          await renderer.textEnded(binding, properties)
          break
        case "session.next.step.ended":
          if (manualCompaction) {
            await state.markAssistantMirrored(server.id, sessionID, properties.assistantMessageID)
            if (properties.finish === "stop") {
              manualCompactions.delete(key)
              clearRunCheck(binding)
              await promptQueue.markTerminalMirrored(binding)
            }
            break
          }
          if (state.isAssistantMirrored?.(server.id, sessionID, properties.assistantMessageID)) {
            if (properties.finish === "stop") scheduleReconcile(binding, 0)
            break
          }
          if (properties.finish === "stop") {
            if (state.isAssistantMirrored(server.id, sessionID, properties.assistantMessageID)) {
              clearRunCheck(binding)
              await promptQueue.markTerminalMirrored(binding)
            } else {
              const mirrored = await renderer.finalAssistantMessageReady(binding, properties.assistantMessageID)
              if (mirrored) clearRunCheck(binding)
            }
          } else {
            await state.markAssistantMirrored(server.id, sessionID, properties.assistantMessageID)
          }
          break
        case "session.status":
          if (properties.status?.type === "idle") {
            await handleSessionIdle(server, binding)
            manualCompactions.delete(key)
          }
          break
        case "session.idle":
          await handleSessionIdle(server, binding)
          manualCompactions.delete(key)
          break
        case "session.next.step.failed":
          clearRunCheck(binding)
          await state.markAssistantMirrored(server.id, sessionID, properties.assistantMessageID)
          if (manualCompaction) {
            manualCompactions.delete(key)
            if (promptQueue.hasExpectedStop(binding)) break
            promptQueue.markSendFailed(binding)
            break
          }
          if (promptQueue.hasExpectedStop(binding)) break
          await notifyRunFailed(binding, properties, promptQueue.clear(binding))
          break
        case "session.error":
          clearRunCheck(binding)
          if (manualCompaction) {
            manualCompactions.delete(key)
            if (promptQueue.hasExpectedStop(binding)) break
            promptQueue.markSendFailed(binding)
            break
          }
          if (promptQueue.hasExpectedStop(binding)) break
          await notifySessionError(binding, properties)
          break
        case "session.next.tool.called":
          if (manualCompaction) break
          await renderer.toolCalled(binding, properties)
          break
        case "session.next.tool.success":
          if (manualCompaction) break
          await renderer.toolResult(binding, properties, true)
          break
        case "session.next.tool.failed":
          if (manualCompaction) break
          await renderer.toolResult(binding, properties, false)
          break
        case "message.part.updated":
        case "message.part.added":
          if (manualCompaction) break
          await mirrorToolPartUpdate(binding, properties)
          break
      }
    } catch (error) {
      logErrorEvent("mirror.event.failed", error, fields())
      await handleMirrorError(binding, error)
    }
    const elapsedMs = durationMs(startedAt)
    if (isMirrorMilestone(event.type) || shouldLogSlow(elapsedMs)) logInfo("mirror.event.handled", { ...fields(), durationMs: elapsedMs })
  }

  async function handleSessionIdle(server, binding) {
    const queued = promptQueue.status(binding).queued
    const result = await promptQueue.markBackendIdle(binding)
    if (queued && result.status !== "sent") await reconcileBindingNow(binding)
    if (promptQueue.hasExpectedStop(binding)) {
      const userMessageID = latestUserMessages.get(bindingKey(binding))
      if (userMessageID) {
        await state.markIncompleteRunHandled({
          key: incompleteWarningKey(binding, { userMessageID }),
          serverID: binding.serverID,
          sessionID: binding.sessionID,
          userMessageID,
          assistantMessageID: null,
          finish: "expected-stop",
          source: "expected-stop",
        })
      }
      clearRunCheck(binding)
      promptQueue.clearExpectedStop(binding)
      scheduleIncompleteRunCheck(server, binding, { expectedStop: true })
      return
    }
    scheduleIncompleteRunCheck(server, binding)
  }

  function startRun(binding, userMessageID) {
    const key = bindingKey(binding)
    if (userMessageID && latestUserMessages.get(key) === userMessageID) return false
    if (userMessageID) latestUserMessages.set(key, userMessageID)
    clearRunCheck(binding)
    return true
  }

  function clearRunCheck(binding) {
    const key = bindingKey(binding)
    const check = incompleteChecks.get(key)
    if (check) clearTimeout(check)
    incompleteChecks.delete(key)
  }

  function scheduleIncompleteRunCheck(server, binding, { expectedStop = false } = {}) {
    const key = bindingKey(binding)
    const existing = incompleteChecks.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      incompleteChecks.delete(key)
      verifyRunOutcome(server, binding, { expectedStop, source: expectedStop ? "expected-stop" : "idle" }).catch((error) => logError(error))
    }, incompleteRunGraceMs)
    timer.unref?.()
    incompleteChecks.set(key, timer)
  }

  async function verifyRunOutcome(server, binding, { expectedStop = false, messages, source = "reconcile" } = {}) {
    const originalBinding = binding
    binding = activeBinding(binding)
    if (!binding) {
      clearRunCheck(originalBinding)
      return
    }
    if (questionManager?.hasPending(server.id, binding.sessionID)) return

    const statuses = await backendRequest(server.id, "incomplete-run-status", () => opencode.request(server, "/session/status", { directory: binding.directory }))
    if (statuses === skippedBackendRequest) return
    const statusType = statuses?.[binding.sessionID]?.type
    if (statusType && statusType !== "idle") return

    const history = messages || await backendRequest(server.id, "incomplete-run-messages", () => opencode.messages(server.id, binding.sessionID, { directory: binding.directory }))
    if (history === skippedBackendRequest) return
    if (!activeBinding(binding)) {
      clearRunCheck(binding)
      return
    }
    const outcome = latestRunOutcome(history)
    if (!outcome) {
      clearRunCheck(binding)
      return
    }
    if (outcome.finalAnswer) await repairLatestFinalNotification(binding, history)
    if (expectedStop) {
      if (!outcome.complete) {
        await state.markIncompleteRunHandled({
          key: incompleteWarningKey(binding, outcome),
          serverID: binding.serverID,
          sessionID: binding.sessionID,
          userMessageID: outcome.userMessageID,
          assistantMessageID: outcome.assistantMessageID,
          finish: outcome.finish,
          source,
        })
      }
      clearRunCheck(binding)
      return
    }
    if (outcome.complete) {
      if (!messages) await reconcileBinding(binding)
      if (!state.isAssistantMirrored(server.id, binding.sessionID, outcome.assistantMessageID)) return
      clearRunCheck(binding)
      await promptQueue.markTerminalMirrored(binding)
      return
    }

    const warningKey = incompleteWarningKey(binding, outcome)
    if (state.incompleteRunHandled(warningKey)) {
      clearRunCheck(binding)
      await promptQueue.markTerminalMirrored(binding)
      return
    }
    if (incompleteNotifications.has(warningKey)) return

    incompleteNotifications.add(warningKey)
    try {
      const configuredServer = config.opencode.servers.find((item) => item.id === binding.serverID)
      const sessionUrl = sessionWebUrl(configuredServer || server, binding)
      const emptyTerminal = outcome.reason === "empty_terminal"
      await telegram.sendMessage({
        chatId: binding.chatId,
        topicId: binding.topicId,
        text: [
          emptyTerminal ? "⚠️ <b>OpenCodez stopped without a final response</b>" : "⚠️ <b>OpenCodez run was interrupted</b>",
          emptyTerminal
            ? "The backend reported a normal stop, but the terminal assistant message contained no visible text."
            : "The session became idle before a final answer was produced.",
          `<b>Last state:</b> ${incompleteRunReason(outcome)}`,
          "Continue the run in OpenCodez or send a new prompt in this topic.",
        ].join("\n\n"),
        disablePreview: true,
        replyMarkup: sessionUrl ? { inline_keyboard: [[{ text: "Open session", url: sessionUrl }]] } : undefined,
      })
      await state.markIncompleteRunHandled({
        key: warningKey,
        serverID: binding.serverID,
        sessionID: binding.sessionID,
        userMessageID: outcome.userMessageID,
        assistantMessageID: outcome.assistantMessageID,
        finish: outcome.finish,
        source,
      })
      clearRunCheck(binding)
      await promptQueue.markTerminalMirrored(binding)
    } finally {
      incompleteNotifications.delete(warningKey)
    }
  }

  async function mirrorToolPartUpdate(binding, properties) {
    const part = properties.part || properties
    if (!part || part.type !== "tool") return
    const status = part.state?.status || part.status
    const input = part.state?.input || part.input || {}
    const payload = {
      callID: part.callID || part.id || properties.partID,
      tool: part.tool || part.name || properties.tool || "tool",
      input,
      output: part.state?.output || part.output,
      content: part.state?.content || part.content,
      error: part.state?.error || part.error,
    }
    if (status === "running" || status === "pending") await renderer.toolCalled(binding, payload)
    else if (status === "completed" || status === "success") await renderer.toolResult(binding, payload, true)
    else if (status === "error" || status === "failed") await renderer.toolResult(binding, payload, false)
  }

  function scheduleReconcile(binding, delayMs) {
    if (config.reconcile.enabled === false) return
    const key = bindingKey(binding)
    const pending = reconcileTimers.get(key)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      if (reconcileTimers.get(key) !== timer) return
      reconcileTimers.delete(key)
      const current = activeBinding(binding)
      if (!current) return
      reconcileBinding(current).catch(logError)
    }, delayMs)
    timer.unref?.()
    reconcileTimers.set(key, timer)
  }

  async function reconcileLoop() {
    if (config.reconcile.enabled === false) return
    await seedExistingSessions()
    while (!shouldStop()) {
      await delay(config.reconcile.intervalMs).catch(() => {})
      if (shouldStop()) break
      if (!state.mirrorEnabled(config)) continue
      await reconcileSessions().catch(logError)
      for (const binding of [...state.data.bindings].filter((item) => !item.disabled)) {
        if (!reconcileWindow(binding)) continue
        try {
          const messages = await reconcileBinding(binding)
          const server = config.opencode.servers.find((item) => item.id === binding.serverID)
          if (server && messages) await verifyRunOutcome(server, binding, { messages, source: "periodic-reconcile" })
        } catch (error) {
          await handleMirrorError(binding, error).catch(logError)
        }
      }
    }
  }

  async function seedExistingSessions() {
    const seen = []
    for (const server of config.opencode.servers) {
      const sessions = await backendRequest(server.id, "seed sessions", () => opencode.listSessions(server.id, { mirror: true }))
      if (sessions === skippedBackendRequest) continue
      for (const session of sessions) seen.push([server.id, session.id])
    }
    const seeded = await state.seedSeenSessions(seen)
    if (seeded) console.log(`[opencodebot] seeded ${seeded} existing OpenCodez sessions`)
  }

  async function reconcileSessions() {
    const chatId = state.chatId || config.telegram.chatId
    if (!chatId || !config.telegram.autocreateTopics) return
    for (const server of config.opencode.servers) {
      const sessions = await backendRequest(server.id, "list sessions", () => opencode.listSessions(server.id, { mirror: true }))
      if (sessions === skippedBackendRequest) continue
      for (const session of sessions) {
        const binding = state.findBinding(server.id, session.id)
        if (isInternalSession(session)) {
          await state.markSeenSession(server.id, session.id)
          if (binding && !binding.disabled) await state.disableBinding(server.id, session.id, "internal subagent session")
          continue
        }
        if (binding) {
          if (!binding.disabled) {
            await maybeSyncTopicTitle(binding, session.title)
            await maybeExtendExpiredBindingFromSession(binding, session)
          }
          continue
        }
        if (state.hasSeenSession(server.id, session.id)) continue
        await createTopicForSession(server.id, session)
      }
    }
  }

  async function maybeExtendExpiredBindingFromSession(binding, session) {
    const refresh = bindingSessionReconcileRefresh(binding, session, Date.now(), config.reconcile.activeWindowMs)
    if (!refresh) return
    const now = Date.now()
    await state.extendBindingActivity(binding.serverID, binding.sessionID, {
      reconcileUntil: now + config.reconcile.activeWindowMs,
      reconcileUsersOnlyUntil: now + config.reconcile.activeWindowMs,
      reason: "session-list-update",
    })
    logInfo("reconcile.binding.reactivated", {
      serverID: binding.serverID,
      sessionID: binding.sessionID,
      topicId: binding.topicId,
      sessionUpdatedAt: new Date(refresh.updatedMs).toISOString(),
      previousUntil: new Date(refresh.untilMs).toISOString(),
    })
  }

  async function maybeSyncTopicTitle(binding, title) {
    if (!title) return
    const active = state.findBindingByTopic(binding.chatId, binding.topicId)
    if (!active || active.serverID !== binding.serverID || active.sessionID !== binding.sessionID) return
    const topic = state.topicRecord?.(binding.chatId, binding.topicId) || binding
    const userOwned = topic.titleSource === "user"
    if (!shouldSyncManagedTopicTitle(topic, title)) return
    const baseTitle = userOwned ? topicBaseTitle(topic) : title
    const titleFields = managedTopicTitle(baseTitle, binding.serverID, opencode.servers)
    if (topic.title === baseTitle && topic.topicTitle === titleFields.topicTitle) return
    if (!userOwned && title.startsWith("New session -") && topic.title && !topic.title.startsWith("New session -")) return
    try {
      await telegram.editForumTopic({ chatId: binding.chatId, topicId: binding.topicId, name: titleFields.topicTitle })
      await state.updateBindingTitle(binding.serverID, binding.sessionID, baseTitle, userOwned ? "user" : "opencode", titleFields)
    } catch (error) {
      console.warn(`[opencodebot] topic title sync failed for ${binding.serverID}/${binding.sessionID}: ${error.message}`)
    }
  }

  function reconcileBinding(binding) {
    return runSingleFlight(bindingOperations, bindingKey(binding), () => reconcileBindingNow(binding))
  }

  async function reconcileBindingNow(binding) {
    const current = activeBinding(binding)
    if (!current) return
    binding = current
    const window = reconcileWindow(binding)
    if (!window) return
    const startedAt = Date.now()
    let mirroredUsers = 0
    let mirroredAssistants = 0
    let skippedAssistants = 0
    let usersOnlyCatchup = Date.parse(binding.reconcileUsersOnlyUntil || "") > Date.now()
    let catchupUserSeen = !usersOnlyCatchup
    const messages = await backendRequest(binding.serverID, "session messages", () => opencode.messages(binding.serverID, binding.sessionID, { directory: binding.directory }))
    if (messages === skippedBackendRequest) return
    if (!activeBinding(binding)) return
    for (const message of messages) {
      if (!activeBinding(binding)) return
      const info = message.info || message
      if (!messageInReconcileWindow(info, window)) continue
      if (info.role === "user") {
        const text = textFromStoredMessage(message)
        if (info.id && !state.isUserMirrored(binding.serverID, binding.sessionID, info.id)) {
          if (!text) {
            await state.markUserMirrored(binding.serverID, binding.sessionID, info.id)
            continue
          }
          const consumed = await state.consumePendingPrompt(binding.serverID, binding.sessionID, text)
          if (consumed) {
            await recordConsumedPromptOrigin(binding, consumed, info.id)
            await pinConsumedTelegramPrompt(binding, consumed)
          } else {
            await renderer.userPrompt(binding, text, "web")
          }
          if (usersOnlyCatchup) {
            await activateBindingForPrompt(binding, "reconcile-user-prompt")
            usersOnlyCatchup = false
          }
          await state.markUserMirrored(binding.serverID, binding.sessionID, info.id)
          mirroredUsers += 1
          catchupUserSeen = true
        }
        continue
      }
      if (info.role !== "assistant" || !info.id) continue
      if (!isCompleted(info)) continue
      if (state.isAssistantMirrored(binding.serverID, binding.sessionID, info.id)) continue
      if (info.summary === true) {
        await state.markAssistantMirrored(binding.serverID, binding.sessionID, info.id)
        if (info.finish === "stop") await promptQueue.markTerminalMirrored(binding)
        skippedAssistants += 1
        continue
      }
      if (shouldSkipAssistantForCatchup(usersOnlyCatchup, catchupUserSeen)) {
        await state.markAssistantMirrored(binding.serverID, binding.sessionID, info.id)
        skippedAssistants += 1
        continue
      }
      await renderStoredAssistantMessage(binding, message)
      await state.markAssistantMirrored(binding.serverID, binding.sessionID, info.id)
      if (info.finish === "stop") await promptQueue.markTerminalMirrored(binding)
      mirroredAssistants += 1
    }
    await repairLatestFinalNotification(binding, messages)
    const elapsedMs = durationMs(startedAt)
    if (mirroredUsers || mirroredAssistants || skippedAssistants || shouldLogSlow(elapsedMs)) {
      logInfo("reconcile.binding.done", {
        serverID: binding.serverID,
        sessionID: binding.sessionID,
        topicId: binding.topicId,
        messages: messages.length,
        mirroredUsers,
        mirroredAssistants,
        skippedAssistants,
        reconcileAfter: new Date(window.afterMs).toISOString(),
        durationMs: elapsedMs,
      })
    }
    return messages
  }

  async function repairLatestFinalNotification(binding, messages) {
    if (typeof renderer.notifyFinalMessage !== "function") return
    const outcome = latestRunOutcome(messages)
    if (!outcome?.finalAnswer || !outcome.assistantMessageID) return
    const key = `${bindingKey(binding)}:${outcome.assistantMessageID}`
    const now = Date.now()
    if (now - (finalNotificationAttempts.get(key) || 0) < 60_000) return
    finalNotificationAttempts.set(key, now)
    await renderer.notifyFinalMessage(binding, { assistantMessageID: outcome.assistantMessageID, messageId: null })
  }

  async function handleMirrorError(binding, error) {
    if (isUnavailableTopicError(error)) {
      await state.disableBinding(binding.serverID, binding.sessionID, error.message || "Telegram topic unavailable")
      console.warn(`[opencodebot] disabled unavailable Telegram topic binding ${binding.serverID}/${binding.sessionID}: ${error.message}`)
      return
    }
    throw error
  }

  async function notifyRunFailed(binding, properties, clearedQueue) {
    const errorText = stepFailureText(properties)
    const lines = ["<b>Run finished with an error.</b>"]
    if (errorText) lines.push(escapeHtml(errorText))
    if (clearedQueue.length) {
      lines.push("", "<b>Cleared queued prompts:</b>")
      lines.push(...clearedQueue.map((item) => `${item.index}. <code>${escapeHtml(item.summary)}</code>`))
    }
    await telegram.sendMessage({
      chatId: binding.chatId,
      topicId: binding.topicId,
      text: lines.join("\n"),
    })
  }

  async function notifySessionError(binding, properties) {
    const detail = await resolvedSessionError(binding, properties)
    const text = detail
      ? `❌ <b>OpenCodez session error</b>\n<blockquote><b>${escapeHtml(detail.title)}</b>\n${escapeHtml(detail.message)}</blockquote>`
      : "❌ <b>OpenCodez session error.</b>"
    await telegram.sendMessage({
      chatId: binding.chatId,
      topicId: binding.topicId,
      text,
    })
  }

  async function resolvedSessionError(binding, properties) {
    const fromEvent = normalizeSessionError(properties)
    if (fromEvent) return fromEvent
    try {
      const messages = await opencode.messages(binding.serverID, binding.sessionID, { directory: binding.directory })
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const info = messages[index]?.info || messages[index]
        if (info?.role !== "assistant" || !info.error) continue
        const fromHistory = normalizeSessionError(info.error)
        if (fromHistory) return fromHistory
      }
    } catch (error) {
      logError(error)
    }
    return null
  }

  async function renderStoredAssistantMessage(binding, message) {
    const info = message.info || message
    const parts = message.parts || []
    const toolLines = []
    const textParts = []
    for (const part of parts) {
      if (part?.type === "text" && part.text) textParts.push(part.text)
      const toolLine = compactStoredToolLine(part, renderer)
      if (toolLine) toolLines.push(toolLine)
    }
    await renderer.compactTools(binding, toolLines)
    await renderer.assistantMessage(binding, textParts.join("\n\n"), { final: info.finish === "stop", assistantMessageID: info.id })
  }

  async function pinConsumedTelegramPrompt(binding, marker) {
    if (marker?.pinnedAt) return
    const messageId = Number(marker?.messageId)
    if (!renderer.shouldPinUserPrompts() || !Number.isSafeInteger(messageId) || messageId <= 0) return
    await renderer.pinMessage(binding, messageId, { origin: "telegram-prompt-event" })
  }

  async function recordConsumedPromptOrigin(binding, marker, opencodeMessageID) {
    const telegramMessageID = Number(marker?.messageId)
    if (!opencodeMessageID || !Number.isSafeInteger(telegramMessageID)) return
    await state.recordPromptOrigin({
      serverID: binding.serverID,
      sessionID: binding.sessionID,
      opencodeMessageID,
      chatID: binding.chatId,
      topicID: binding.topicId,
      telegramMessageID,
    })
  }

  function detachBinding(binding) {
    clearRunCheck(binding)
    const key = bindingKey(binding)
    for (const attemptKey of finalNotificationAttempts.keys()) {
      if (attemptKey.startsWith(`${key}:`)) finalNotificationAttempts.delete(attemptKey)
    }
    const timer = reconcileTimers.get(key)
    if (!timer) return
    clearTimeout(timer)
    reconcileTimers.delete(key)
  }

  return { handleOpenCodeEvent, reconcileBinding, reconcileLoop, scheduleReconcile, seedExistingSessions, detachBinding }
}

function isUnavailableTopicError(error) {
  return /message thread not found|forum topic .*not found|topic .*not found|topic .*deleted|topic .*closed|message thread .*closed/i.test(
    error.message || "",
  )
}

function stepFailureText(properties) {
  const error = properties.error || properties.exception || properties.reason
  if (typeof error === "string") return error
  if (error?.message) return error.message
  if (properties.message) return properties.message
  return ""
}

export function normalizeSessionError(value) {
  if (value === null || value === undefined) return null
  const direct = typeof value === "object" ? value : {}
  const candidate = direct.error ?? direct.exception ?? direct.reason ?? value
  if (typeof candidate === "string") return { title: "Session error", message: cleanSessionErrorMessage(candidate) }
  if (!candidate || typeof candidate !== "object") return null

  const data = candidate.data && typeof candidate.data === "object" ? candidate.data : {}
  const name = firstSessionErrorText(candidate.name, direct.name)
  const statusCode = data.statusCode ?? candidate.statusCode
  const explicitMessage = firstSessionErrorText(data.message, candidate.message, direct.message)
  const message = explicitMessage || defaultSessionErrorMessage(name)
  if (!message && !name && statusCode === undefined) return null

  const baseTitle = SESSION_ERROR_TITLES[name] || humanizeSessionErrorName(name) || "Session error"
  const status = statusCode === undefined || statusCode === null || statusCode === "" ? "" : ` (${String(statusCode).slice(0, 16)})`
  return {
    title: `${baseTitle}${status}`.slice(0, 160),
    message: cleanSessionErrorMessage(message || "OpenCodez reported an error without additional details."),
  }
}

const SESSION_ERROR_TITLES = {
  APIError: "API error",
  ContentFilterError: "Content filter error",
  ContextOverflowError: "Context overflow",
  MessageAbortedError: "Session aborted",
  MessageOutputLengthError: "Output limit reached",
  ProviderAuthError: "Provider authentication error",
  StructuredOutputError: "Structured output error",
  UnknownError: "Unknown error",
}

const SESSION_ERROR_MESSAGES = {
  APIError: "The model provider request failed.",
  ContentFilterError: "The model provider blocked the response with its content filter.",
  ContextOverflowError: "The session context is too large. Run /compact and retry the prompt.",
  MessageAbortedError: "The OpenCodez run was aborted.",
  MessageOutputLengthError: "The model reached its maximum output length before completing the response.",
  ProviderAuthError: "The model provider rejected authentication. Check the provider credentials.",
  StructuredOutputError: "The model could not produce the required structured output.",
  UnknownError: "OpenCodez reported an unknown session error.",
}

function defaultSessionErrorMessage(name) {
  return SESSION_ERROR_MESSAGES[name] || ""
}

function firstSessionErrorText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function humanizeSessionErrorName(name) {
  if (!name) return ""
  return String(name)
    .replace(/Error$/, " error")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase())
}

function cleanSessionErrorMessage(message) {
  const value = String(message || "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (value.length <= 2400) return value
  return `${value.slice(0, 2399).trimEnd()}…`
}

function textFromStoredMessage(message) {
  return visibleTextFromParts(message.parts || [])
}

function compactStoredToolLine(part, renderer) {
  if (!part || part.type !== "tool") return ""
  const tool = part.name || part.tool || "tool"
  const input = part.state?.input || part.input || {}
  if (!renderer.shouldMirrorTool(tool, input)) return ""
  const status = part.state?.status || part.state
  const failed = status === "error" || status === "failed" || part.state?.error
  const ok = !failed && (status === "completed" || status === "success")
  if (!failed && !ok) return ""
  return formatToolLine(tool, input, ok, failed ? part.state?.error?.message || "failed" : "")
}

function isMirrorMilestone(type) {
  return type === "session.next.step.ended" || type === "session.next.step.failed" || type === "session.status" || type === "session.idle"
}

function reconcileWindow(binding) {
  const afterMs = Date.parse(binding.reconcileAfter || "")
  const untilMs = Date.parse(binding.reconcileUntil || "")
  if (!Number.isFinite(afterMs) || !Number.isFinite(untilMs)) return null
  if (untilMs < Date.now()) return null
  return { afterMs, untilMs }
}

function messageInReconcileWindow(info, window) {
  const timeMs = messageTimeMs(info)
  return timeMs > 0 && timeMs >= window.afterMs
}

function messageTimeMs(info) {
  const direct = info?.time?.created || info?.time?.completed
  if (Number.isFinite(direct)) return direct
  for (const value of [info?.createdAt, info?.created, info?.updatedAt]) {
    const parsed = Date.parse(value || "")
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

export function bindingSessionReconcileRefresh(binding, session, nowMs = Date.now(), maxAgeMs = 0) {
  const updatedMs = sessionUpdatedMs(session)
  if (!updatedMs) return null
  if (maxAgeMs > 0 && Number.isFinite(nowMs) && nowMs - updatedMs > maxAgeMs) return null
  const untilMs = Date.parse(binding?.reconcileUntil || "")
  if (!Number.isFinite(untilMs) || updatedMs <= untilMs) return null
  return { updatedMs, untilMs }
}

export function shouldSyncManagedTopicTitle(binding, backendTitle) {
  const managed = binding?.topicServerSuffixManaged === true || Boolean(binding?.topicBaseTitle)
  if (managed) return true
  return binding?.titleSource !== "user" && backendTitle !== binding?.title
}

export function shouldSkipAssistantForCatchup(usersOnlyCatchup, catchupUserSeen) {
  return usersOnlyCatchup && !catchupUserSeen
}

function sessionUpdatedMs(session) {
  const direct = session?.time?.updated || session?.time?.created
  if (Number.isFinite(direct)) return direct
  for (const value of [session?.updatedAt, session?.updated, session?.createdAt, session?.created]) {
    const parsed = Date.parse(value || "")
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function isCompleted(info) {
  return Boolean(info.time?.completed || info.time?.failed || info.finished || info.completed)
}

function bindingKey(binding) {
  return `${binding.serverID}:${binding.sessionID}`
}

export function isManualCompactionPart(part) {
  return part?.type === "compaction" && part.auto === false
}

function eventSessionID(properties = {}) {
  return properties.sessionID || properties.part?.sessionID || properties.info?.sessionID || ""
}

function latestRunOutcome(messages) {
  const normalized = messages.map((message) => ({ info: message.info || message, parts: message.parts || [] }))
  let userIndex = -1
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (normalized[index]?.info?.role === "user" && normalized[index].info.summary !== true) {
      userIndex = index
      break
    }
  }
  if (userIndex < 0) return null

  const userMessageID = normalized[userIndex]?.info?.id || null
  for (let index = normalized.length - 1; index > userIndex; index -= 1) {
    const message = normalized[index]
    const info = message.info
    if (info?.role !== "assistant") continue
    const finish = String(info.finish || "").toLowerCase()
    const knownFailure = Boolean(info.error) || ["error", "cancelled", "canceled", "aborted"].includes(finish)
    const summary = info.summary === true
    const visibleFinalAnswer = finish === "stop" && assistantHasVisibleFinalAnswer(message)
    const emptyTerminal = finish === "stop" && !summary && !visibleFinalAnswer
    return {
      assistantMessageID: info.id || null,
      complete: knownFailure || summary || visibleFinalAnswer,
      finalAnswer: visibleFinalAnswer && !knownFailure && !summary,
      finish: finish || "missing",
      reason: emptyTerminal ? "empty_terminal" : knownFailure ? "failure" : summary ? "summary" : visibleFinalAnswer ? "complete" : "unfinished",
      userMessageID,
    }
  }
  return {
    assistantMessageID: null,
    complete: false,
    finalAnswer: false,
    finish: "missing",
    reason: "missing",
    userMessageID,
  }
}

function assistantHasVisibleFinalAnswer(message) {
  if (typeof message?.info?.text === "string" && message.info.text.trim()) return true
  return (message?.parts || []).some((part) => (
    part?.type === "text"
    && part.synthetic !== true
    && typeof part.text === "string"
    && part.text.trim()
  ))
}

function incompleteWarningKey(binding, outcome) {
  return JSON.stringify([
    binding.serverID,
    binding.sessionID,
    outcome.userMessageID || "",
  ])
}

function incompleteRunReason(outcome) {
  if (outcome.reason === "empty_terminal") return "OpenCodez reported a normal stop, but the terminal assistant message was empty."
  if (!outcome.assistantMessageID) return "No assistant response was created."
  if (outcome.finish === "unknown") return "The assistant response ended unexpectedly."
  if (outcome.finish === "tool-calls") return "The run stopped after a tool call."
  if (outcome.finish === "length") return "The model reached its output limit."
  if (outcome.finish === "content-filter") return "The response was stopped by the provider's content filter."
  return "The assistant response did not reach a normal final answer."
}

function sessionWebUrl(server, binding) {
  const base = String(server?.url || "").replace(/\/$/, "")
  if (!base || !binding?.sessionID) return ""
  const directory = binding.directory || "/"
  return `${base}/${Buffer.from(directory).toString("base64url")}/session/${binding.sessionID}`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
