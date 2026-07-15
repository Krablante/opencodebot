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
  const activeRuns = new Map()
  const bindingOperations = new Map()
  const reconcileTimers = new Map()

  function activeBinding(binding) {
    const current = state.findBinding(binding.serverID, binding.sessionID)
    if (!current) return null
    if (String(current.chatId) !== String(binding.chatId) || String(current.topicId) !== String(binding.topicId)) return null
    return current
  }

  function handleOpenCodeEvent(server, event) {
    const sessionID = event.properties?.sessionID
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
    const sessionID = properties.sessionID
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
    if (event.type === "session.next.prompted") await activateBindingForPrompt(binding, "web-prompt")
    else await maybeExtendBindingActivity(binding, "opencode-event")
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
          await renderer.textDelta(binding, properties)
          break
        case "session.next.text.ended":
          await renderer.textEnded(binding, properties)
          break
        case "session.next.step.ended":
          if (properties.finish === "stop") {
            if (state.isAssistantMirrored(server.id, sessionID, properties.assistantMessageID)) {
              clearRun(binding)
              await promptQueue.markTerminalMirrored(binding)
            } else {
              const mirrored = await renderer.finalAssistantMessageReady(binding, properties.assistantMessageID)
              if (mirrored) clearRun(binding)
            }
          } else {
            await state.markAssistantMirrored(server.id, sessionID, properties.assistantMessageID)
          }
          break
        case "session.status":
          if (properties.status?.type === "idle") await handleSessionIdle(server, binding)
          break
        case "session.idle":
          await handleSessionIdle(server, binding)
          break
        case "session.next.step.failed":
          clearRun(binding)
          await state.markAssistantMirrored(server.id, sessionID, properties.assistantMessageID)
          if (promptQueue.hasExpectedStop(binding)) break
          await notifyRunFailed(binding, properties, promptQueue.clear(binding))
          break
        case "session.error":
          clearRun(binding)
          if (promptQueue.hasExpectedStop(binding)) break
          await notifySessionError(binding, properties)
          break
        case "session.next.tool.called":
          await renderer.toolCalled(binding, properties)
          break
        case "session.next.tool.success":
          await renderer.toolResult(binding, properties, true)
          break
        case "session.next.tool.failed":
          await renderer.toolResult(binding, properties, false)
          break
        case "message.part.updated":
        case "message.part.added":
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
      clearRun(binding)
      promptQueue.clearExpectedStop(binding)
      return
    }
    scheduleIncompleteRunCheck(server, binding)
  }

  function startRun(binding, userMessageID) {
    const key = bindingKey(binding)
    clearRun(binding)
    activeRuns.set(key, { token: Symbol(key), userMessageID, timer: null })
  }

  function clearRun(binding, token) {
    const key = bindingKey(binding)
    const run = activeRuns.get(key)
    if (!run || (token && run.token !== token)) return
    if (run.timer) clearTimeout(run.timer)
    activeRuns.delete(key)
  }

  function scheduleIncompleteRunCheck(server, binding) {
    const run = activeRuns.get(bindingKey(binding))
    if (!run || run.timer) return
    const token = run.token
    run.timer = setTimeout(() => {
      checkIncompleteRun(server, binding, token).catch((error) => logError(error))
    }, incompleteRunGraceMs)
    run.timer.unref?.()
  }

  async function checkIncompleteRun(server, binding, token) {
    const run = activeRuns.get(bindingKey(binding))
    if (!run || run.token !== token) return
    run.timer = null
    const originalBinding = binding
    binding = activeBinding(binding)
    if (!binding) {
      clearRun(originalBinding, token)
      return
    }
    if (questionManager?.hasPending(server.id, binding.sessionID)) return

    const statuses = await backendRequest(server.id, "incomplete-run-status", () => opencode.request(server, "/session/status", { directory: binding.directory }))
    if (statuses === skippedBackendRequest) return
    const statusType = statuses?.[binding.sessionID]?.type
    if (statusType && statusType !== "idle") return

    const messages = await backendRequest(server.id, "incomplete-run-messages", () => opencode.messages(server.id, binding.sessionID, { directory: binding.directory }))
    if (messages === skippedBackendRequest) return
    if (!activeBinding(binding)) {
      clearRun(binding, token)
      return
    }
    const terminalAssistantID = terminalAssistantAfterUser(messages, run.userMessageID)
    if (terminalAssistantID) {
      await reconcileBinding(binding)
      if (!state.isAssistantMirrored(server.id, binding.sessionID, terminalAssistantID)) return
      clearRun(binding, token)
      await promptQueue.markTerminalMirrored(binding)
      return
    }

    await telegram.sendMessage({
      chatId: binding.chatId,
      topicId: binding.topicId,
      text: "⚠️ OpenCodez run ended without a final answer.\nThe session is idle. Send a new prompt to continue.",
    })
    clearRun(binding, token)
    await promptQueue.markTerminalMirrored(binding)
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
          await reconcileBinding(binding)
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
          await maybeSyncTopicTitle(binding, session.title)
          await maybeExtendExpiredBindingFromSession(binding, session)
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
    const userOwned = binding.titleSource === "user"
    if (!shouldSyncManagedTopicTitle(binding, title)) return
    const baseTitle = userOwned ? topicBaseTitle(binding) : title
    const titleFields = managedTopicTitle(baseTitle, binding.serverID, opencode.servers)
    if (binding.title === baseTitle && binding.topicTitle === titleFields.topicTitle) return
    if (!userOwned && title.startsWith("New session -") && binding.title && !binding.title.startsWith("New session -")) return
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
    const text = sessionErrorText(properties)
    await telegram.sendMessage({
      chatId: binding.chatId,
      topicId: binding.topicId,
      text: `<b>OpenCodez session error.</b>${text ? `\n${escapeHtml(text)}` : ""}`,
    })
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
    clearRun(binding)
    const key = bindingKey(binding)
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

function sessionErrorText(properties) {
  const error = properties.error || properties.exception || properties.reason
  if (typeof error === "string") return error
  if (error?.message) return error.message
  if (properties.message) return String(properties.message)
  return ""
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

function terminalAssistantAfterUser(messages, userMessageID) {
  const infos = messages.map((message) => message.info || message)
  let userIndex = userMessageID ? infos.findIndex((info) => info.id === userMessageID) : -1
  if (userIndex < 0) {
    for (let index = infos.length - 1; index >= 0; index -= 1) {
      if (infos[index]?.role === "user") {
        userIndex = index
        break
      }
    }
  }
  if (userIndex < 0) return null
  for (let index = infos.length - 1; index > userIndex; index -= 1) {
    if (infos[index]?.role === "assistant" && infos[index]?.finish === "stop") return infos[index].id || null
  }
  return null
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
