import { summarizeWords } from "./prompt-queue.mjs"
import { escapeHtml, telegramMessageLink, topicId } from "./telegram.mjs"
import { parseResetArgs } from "./prompt-profiles.mjs"
import { managedTopicTitle, topicBaseTitle } from "./topic-titles.mjs"
import { formatArtifactUploadHelp } from "./artifact-uploads.mjs"
import { logErrorEvent, logInfo, logWarn } from "./logger.mjs"
import { getLanguage, normalizeLanguage, setLanguage, t } from "./i18n/index.mjs"
import { isOpenCodeSessionNotFound, resolveSessionProfile } from "./opencode.mjs"
import { buttonRows, menuTable, localText, richButton } from "./menu-format.mjs"
import {
  buildCollapsedContextMessages,
  DEFAULT_CONTEXT_TURNS,
  loadRecentContextTurns,
  MAX_CONTEXT_TURNS,
  parseContextTurnCount,
} from "./context-export.mjs"

const commandDefinitions = ["menu", "new", "session", "q", "compact", "reminder", "context", "speak", "reset", "kill", "help", "setup"]

export function telegramBotCommands() {
  return commandDefinitions.map((command) => ({
    command,
    description: command === "setup" ? (getLanguage() === "ru" ? "Подключения и первый запуск" : "Connections and first setup") : t(`command.description.${command}`),
  }))
}

export function createTelegramCommandHandlers({
  config,
  state,
  telegram,
  opencode,
  promptQueue,
  multipartPrompts,
  createPendingTopic,
  discardAttachmentBatch = async () => 0,
  detachBinding = () => {},
  notifyLatestManualCompaction = async () => false,
  speech,
  finalVoice,
  questionManager,
  updateManager,
  controlMenu,
  setup,
  launchMenu,
  settings,
  refreshCommandMenu = async () => {},
}) {
  const compactOperations = new Map()
  const handlers = {
    mirror_on: async (message) => {
      await state.setMirrorEnabled(true)
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("commands.mirror.enabled") })
    },
    mirror_off: async (message) => {
      await state.setMirrorEnabled(false)
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("commands.mirror.disabled") })
    },
    artifacts_here: handleArtifactsHere,
    sounds_here: handleSoundsHere,
    sounds_off: handleSoundsOff,
    sounds_status: handleSoundsStatus,
    session: handleSessionInfo,
    new: (message, args) => args?.trim() ? createPendingTopic(message, args) : launchMenu.open({ message, from: message.from }),
    setup: (message) => setup.open(message),
    reset: handleResetCommand,
    menu: (message) => controlMenu.open(message, "home", { replace: true }),
    help: (message) => controlMenu.open(message, "help"),
    start: (message) => controlMenu.open(message),
    q: handleQueueCommand,
    kill: handleKillCommand,
    compact: handleCompactCommand,
    context: handleContext,
    set_context: handleSetContext,
    notify_on: handleNotifyOn,
    notify_off: handleNotifyOff,
    notify_status: handleNotifyStatus,
    update: handleUpdate,
    debug_on: (message) => handleDebugMode(message, true),
    debug_off: (message) => handleDebugMode(message, false),
    debug_status: handleDebugStatus,
    lang: handleLanguage,
    mode: handleMirrorMode,
    reminder: handleReminder,
    ...(finalVoice?.commandHandlers?.() || {}),
  }

  return {
    prepareUpdate: (update) => setup?.prepareUpdate(update) || update,
    async handlePrivate(message) {
      if (!/^\/start(?:\s|$)/.test(message.text || "")) return
      const enabled = await setup.ensureNotifications(message.from.id)
      await telegram.sendMessage({ chatId: message.chat.id, text: getLanguage() === "ru"
        ? (enabled ? "✓ Уведомления готовы. Управление ботом — в General твоей группы." : "Уведомления отключены в твоих настройках. Управление ботом — в General.")
        : (enabled ? "✓ Notifications are ready. Manage your bot in the group's General topic." : "Notifications are disabled in your settings. Manage your bot in General.") })
    },
    async handle(message, command, promptKey) {
      const handler = handlers[command.name]
      if (!handler) return false
      if (command.name === "kill") multipartPrompts.discardKey?.(promptKey)
      else if (command.name !== "reset") await multipartPrompts.flushKey(promptKey)
      await handler(message, command.args, promptKey)
      return true
    },
    async handleCallback(query) {
      if (await controlMenu?.handleCallback?.(query)) return true
      if (await updateManager?.handleCallback?.(query)) return true
      if (await questionManager?.handleCallback?.(query)) return true
      return Boolean(await speech?.handleCallbackQuery?.(query))
    },
    handleMessage(message) {
      return controlMenu?.handleMessage?.(message) || false
    },
  }

  async function handleUpdate(message) {
    await updateManager.checkNow({ chatId: message.chat.id, topicId: topicId(message) })
  }

  async function handleLanguage(message, args) {
    const requested = String(args || "").trim()
    if (!requested) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: t("language.current", { language: t("language.name") }),
      })
      return
    }
    const normalized = normalizeLanguage(requested)
    if (!normalized) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("language.invalid") })
      return
    }
    await setLanguage(normalized)
    let menuRefreshFailed = false
    try {
      await refreshCommandMenu()
    } catch (error) {
      menuRefreshFailed = true
      logWarn("telegram.commands.language_refresh_failed", { language: getLanguage(), error: error?.message })
    }
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: menuRefreshFailed ? `${t("language.changed")}\n\n${t("language.menuRefreshFailed")}` : t("language.changed"),
    })
  }

  async function handleMirrorMode(message, args) {
    const requested = String(args || "").trim().toLowerCase()
    if (requested && requested !== "status" && requested !== "full" && requested !== "economy") {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: t("commands.mode.usage"),
      })
      return
    }
    const mode = requested === "full" || requested === "economy" ? await state.setMirrorMode(requested) : state.mirrorMode()
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: t("commands.mode.status", { mode: escapeHtml(mode.toUpperCase()) }),
    })
  }

  async function handleReminder(message, args) {
    const requested = String(args || "").trim().toLowerCase()
    if (requested && !["status", "on", "off"].includes(requested)) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("commands.reminder.usage") })
      return
    }
    if (requested === "on" || requested === "off") await state.setReminderEnabled(requested === "on")
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: t(state.reminderEnabled() ? "commands.reminder.enabled" : "commands.reminder.disabled"),
    })
  }

  async function handleSetContext(message, args) {
    const userID = message.from?.id
    if (!userID) return
    let count
    try {
      count = parseContextTurnCount(args, { allowEmpty: true })
    } catch {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: t("commands.context.setUsage", { max: MAX_CONTEXT_TURNS }),
      })
      return
    }
    if (count === undefined) {
      const current = state.contextTurnsForUser(userID, DEFAULT_CONTEXT_TURNS)
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: t("commands.context.current", { turns: current, max: MAX_CONTEXT_TURNS }),
      })
      return
    }
    await state.setContextTurnsForUser(userID, count)
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: t("commands.context.saved", { turns: count }),
    })
  }

  async function handleContext(message, args) {
    const currentTopicId = topicId(message)
    const binding = state.findBindingByTopic(message.chat.id, currentTopicId)
    if (!binding) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.context.noBinding"),
      })
      return
    }
    let count
    try {
      count = parseContextTurnCount(args, { allowEmpty: true })
    } catch {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.context.usage", { max: MAX_CONTEXT_TURNS }),
      })
      return
    }
    count ??= state.contextTurnsForUser(message.from?.id, DEFAULT_CONTEXT_TURNS)

    try {
      const turns = await loadRecentContextTurns({
        opencode,
        binding,
        count,
        interruptedUserMessageIDs: state.interruptedUserMessageIDs(binding.serverID, binding.sessionID),
      })
      if (!turns.length) {
        await telegram.sendMessage({
          chatId: message.chat.id,
          topicId: currentTopicId,
          text: t("commands.context.empty"),
        })
        return
      }
      const richMessages = buildCollapsedContextMessages(turns)
      await sendCollapsedContext(message.chat.id, currentTopicId, richMessages)
      logInfo("context.export.sent", {
        source: binding.serverID,
        sessionID: binding.sessionID,
        topicId: currentTopicId,
        userId: message.from?.id,
        turns: turns.length,
        parts: richMessages.length,
        characters: richMessages.reduce((sum, item) => sum + item.text.length, 0),
      })
    } catch (error) {
      const eventFields = {
        source: binding.serverID,
        sessionID: binding.sessionID,
        topicId: currentTopicId,
        userId: message.from?.id,
        turns: count,
      }
      if (error.code === "CONTEXT_TOO_LARGE") logInfo("context.export.rejected", { ...eventFields, characters: error.characters })
      else logErrorEvent("context.export.failed", error, eventFields)
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: contextExportErrorText(error, count),
      })
    }
  }

  async function sendCollapsedContext(chatId, currentTopicId, richMessages) {
    const sentMessageIds = []
    try {
      for (const richMessage of richMessages) {
        const result = await telegram.sendRichMessage({
          chatId,
          topicId: currentTopicId,
          html: richMessage.html,
          skipEntityDetection: true,
        })
        const messageId = result?.message_id || result?.messageId || result?.id
        if (messageId) sentMessageIds.push(messageId)
      }
    } catch (error) {
      await Promise.all(sentMessageIds.map((messageId) => telegram.deleteMessage({
        chatId,
        messageId,
        suppressFailureLog: true,
      }).catch(() => undefined)))
      throw error
    }
  }

  async function handleQueueCommand(message, args) {
    const binding = state.findBindingByTopic(message.chat.id, topicId(message))
    if (!binding) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("commands.queue.noBinding") })
      return
    }

    const input = String(args || "").trim()
    if (!input || input.toLowerCase() === "status") {
      await sendQueueStatus(message, binding)
      return
    }

    if (/^delete\b/i.test(input) && !/^delete\s+\d+$/i.test(input)) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("commands.queue.deleteUsage") })
      return
    }

    const deleteMatch = input.match(/^delete\s+(\d+)$/i)
    if (deleteMatch) {
      const removed = promptQueue.delete(binding, Number(deleteMatch[1]))
      const text = removed
        ? t("commands.queue.deleted", { index: removed.index, summaryHtml: escapeHtml(removed.summary) })
        : t("commands.queue.missing", { indexHtml: escapeHtml(deleteMatch[1]) })
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text })
      return
    }

    const result = await promptQueue.enqueue(binding, input, { sourceMessageId: message.message_id })
    if (result.status === "queued") {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: t("commands.queue.queued", { position: result.position, summaryHtml: escapeHtml(summarizeWords(input, 10)) }),
      })
    }
  }

  async function handleKillCommand(message) {
    const currentTopicId = topicId(message)
    const binding = state.findBindingByTopic(message.chat.id, currentTopicId)
    if (!binding) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: t("commands.kill.noBinding") })
      return
    }
    if (!opencode?.abortSession) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: t("commands.kill.unavailable") })
      return
    }

    const compactOperation = compactOperations.get(compactOperationKey(binding))
    if (compactOperation) compactOperation.cancelled = true
    const wasBusy = promptQueue.isBusy(binding)
    promptQueue.markExpectedStop(binding)
    try {
      await opencode.abortSession(binding.serverID, binding.sessionID, { directory: binding.directory })
    } catch (error) {
      if (compactOperation) compactOperation.cancelled = false
      promptQueue.clearExpectedStop(binding)
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.kill.failed", { errorHtml: escapeHtml(error.message) }),
      })
      return
    }
    const cleared = promptQueue.clear(binding, "Killed by /kill")
    await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: t("commands.kill.result", { wasBusy, cleared: cleared.length }) })
  }

  async function handleCompactCommand(message) {
    const currentTopicId = topicId(message)
    const binding = state.findBindingByTopic(message.chat.id, currentTopicId)
    if (!binding) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.compact.noBinding"),
      })
      return
    }
    if (!opencode?.summarizeSession) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: t("commands.compact.unavailable") })
      return
    }
    if (compactOperations.has(compactOperationKey(binding))) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.compact.alreadyRunning"),
      })
      return
    }

    let messages
    let status
    try {
      const inspection = await Promise.all([
        opencode.messages(binding.serverID, binding.sessionID, { directory: binding.directory, limit: 50 }),
        opencode.sessionStatus(binding.serverID, binding.sessionID, { directory: binding.directory }),
      ])
      messages = inspection[0]
      status = inspection[1]
    } catch (error) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.compact.inspectFailed", { errorHtml: escapeHtml(error.message) }),
      })
      return
    }
    if (status.type !== "idle") {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.compact.busy"),
      })
      return
    }
    if (!messages.some((entry) => entry?.info?.summary !== true && ["user", "assistant"].includes(entry?.info?.role))) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: t("commands.compact.nothing") })
      return
    }

    const profile = await resolveSessionProfile({ opencode, binding, defaultProfile: config.defaultPrompt, messages })
    if (!profile.model?.providerID || !profile.model?.modelID) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.compact.noModel"),
      })
      return
    }

    if (config.reconcile && config.reconcile.enabled !== false) {
      const now = Date.now()
      await state.activateBinding(binding.serverID, binding.sessionID, {
        reconcileAfter: now - config.reconcile.lookbackMs,
        reconcileUntil: now + config.reconcile.activeWindowMs,
        reason: "compact-command",
      })
    }

    const feedback = await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId,
      text: t("commands.compact.starting"),
    })
    const operation = { cancelled: false, startedAt: Date.now() }
    compactOperations.set(compactOperationKey(binding), operation)
    promptQueue.setCompacting(binding, operation)
    void compactSessionInBackground({ binding, message, feedback, model: profile.model, operation }).catch((error) => {
      logErrorEvent("compact.background_failed", error, { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId })
    })
  }

  async function compactSessionInBackground({ binding, message, feedback, model, operation }) {
    let compactCompleted = false
    try {
      await opencode.summarizeSession(binding.serverID, binding.sessionID, { directory: binding.directory, model })
      compactCompleted = true
      if (operation.cancelled) {
        await updateCompactFeedback({ message, feedback, text: t("commands.compact.stopped") })
        return
      }
      let notified = false
      try {
        notified = await notifyLatestManualCompaction(binding, operation.startedAt)
      } catch (error) {
        logErrorEvent("compact.notice_failed", error, { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId })
      }
      if (notified) {
        if (feedback?.message_id) {
          try {
            await telegram.deleteMessage({ chatId: message.chat.id, messageId: feedback.message_id, suppressFailureLog: true })
          } catch (error) {
            logErrorEvent("compact.feedback.delete_failed", error, { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId })
            await updateCompactFeedback({ message, feedback, text: t("commands.compact.completed") })
          }
        }
      } else {
        const current = state.findBindingByTopic(message.chat.id, topicId(message))
        if (current?.serverID === binding.serverID && current.sessionID === binding.sessionID) {
          await updateCompactFeedback({ message, feedback, text: t("commands.compact.completed") })
        }
      }
      logInfo("compact.completed", { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId })
    } catch (error) {
      if (operation.cancelled) {
        await updateCompactFeedback({ message, feedback, text: t("commands.compact.stopped") })
        return
      }
      if (compactCompleted) {
        logErrorEvent("compact.feedback_failed", error, {
          serverID: binding.serverID,
          sessionID: binding.sessionID,
          topicId: binding.topicId,
        })
        return
      }
      promptQueue.setCompacting(binding, false)
      await releaseCompactQueueAfterFailure(binding)
      logErrorEvent("compact.failed", error, { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId })
      await updateCompactFeedback({
        message,
        feedback,
        text: t("commands.compact.failed", { errorHtml: escapeHtml(error.message) }),
      })
    } finally {
      promptQueue.setCompacting(binding, false)
      if (compactCompleted && !operation.cancelled) {
        await releaseCompactQueueAfterSuccess(binding).catch((error) => {
          logErrorEvent("compact.queue_release_failed", error, {
            serverID: binding.serverID,
            sessionID: binding.sessionID,
            topicId: binding.topicId,
          })
        })
      }
      if (compactOperations.get(compactOperationKey(binding)) === operation) compactOperations.delete(compactOperationKey(binding))
    }
  }

  async function releaseCompactQueueAfterSuccess(binding) {
    await promptQueue.markTerminalMirrored(binding)
    await promptQueue.markBackendIdle(binding)
  }

  async function releaseCompactQueueAfterFailure(binding) {
    try {
      const status = await opencode.sessionStatus(binding.serverID, binding.sessionID, { directory: binding.directory })
      if (status.type !== "idle" || !promptQueue.isBusy(binding)) return
      promptQueue.markSendFailed(binding)
      await promptQueue.markBackendIdle(binding)
    } catch (error) {
      logErrorEvent("compact.queue_release_failed", error, { serverID: binding.serverID, sessionID: binding.sessionID })
    }
  }

  async function updateCompactFeedback({ message, feedback, text }) {
    if (feedback?.message_id) {
      try {
        await telegram.editMessageText({ chatId: message.chat.id, messageId: feedback.message_id, text })
        return
      } catch (error) {
        logErrorEvent("compact.feedback.edit_failed", error, { chatId: message.chat.id, messageId: feedback.message_id })
      }
    }
    await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text })
  }

  function compactOperationKey(binding) {
    return `${binding.serverID}:${binding.sessionID}`
  }

  async function handleResetCommand(message, args, promptKey) {
    const currentTopicId = topicId(message)
    if (!currentTopicId) {
      await telegram.sendMessage({ chatId: message.chat.id, text: t("commands.reset.topicRequired") })
      return
    }
    if (state.isArtifactsTopic(message.chat.id, currentTopicId) || state.isSoundsTopic(message.chat.id, currentTopicId)) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.reset.specialTopic"),
      })
      return
    }

    let requested
    try {
      requested = parseResetArgs(args, { promptProfiles: config.promptProfiles, servers: opencode.servers })
    } catch (error) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.reset.invalid", { errorHtml: escapeHtml(error.message) }),
      })
      return
    }

    const binding = state.findBindingByTopic(message.chat.id, currentTopicId)
    if (!binding) {
      const pending = state.pendingTopic(currentTopicId)
      if (!pending) {
        await telegram.sendMessage({
          chatId: message.chat.id,
          topicId: currentTopicId,
          text: t("commands.reset.noBinding"),
        })
        return
      }
      const topic = state.topicRecord(message.chat.id, currentTopicId) || pending
      const profile = requested.promptProfileName ? requested : {
        promptProfileName: pending.promptProfileName,
        promptProfile: pending.promptProfile,
      }
      const previousServerID = pending.serverID
      const previousTopicTitle = topic.topicTitle
      const targetServerID = requested.serverID || pending.serverID
      const serverChanged = targetServerID !== pending.serverID
      const targetDirectory = serverChanged ? opencode.defaultNewSessionDirectory(targetServerID) : pending.directory
      if (serverChanged && !(await preflightResetServer(message, currentTopicId, targetServerID, targetDirectory))) return
      const titleFields = managedTopicTitle(topicBaseTitle(topic), targetServerID, opencode.servers)
      const updated = await state.updatePendingTopicProfile(currentTopicId, {
        ...profile,
        serverID: targetServerID,
        directory: targetDirectory,
        title: titleFields.topicBaseTitle,
        titleSource: "user",
        ...titleFields,
      })
      const discardedMultipart = pending ? multipartPrompts.discardKey?.(promptKey) || false : false
      const discardedAttachments = pending ? await discardAttachmentBatch(promptKey) : 0
      const discarded = [
        discardedMultipart ? t("commands.reset.discardedMultipart") : null,
        discardedAttachments
          ? t("commands.reset.discardedAttachments", { count: discardedAttachments })
          : null,
      ].filter(Boolean)
      let topicRenameWarning = null
      if (updated.topicTitle !== previousTopicTitle) {
        try {
          await telegram.editForumTopic({ chatId: message.chat.id, topicId: currentTopicId, name: updated.topicTitle })
        } catch (error) {
          topicRenameWarning = t("commands.reset.renameFailed", { errorHtml: escapeHtml(error.message) })
        }
      }
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.reset.pendingStatus", {
          profileHtml: escapeHtml(updated.promptProfileName || t("common.current")),
          serverLine: serverChanged
            ? t("commands.reset.serverChanged", { previousHtml: escapeHtml(previousServerID), nextHtml: escapeHtml(updated.serverID) })
            : t("commands.reset.server", { serverHtml: escapeHtml(updated.serverID) }),
          directoryHtml: updated.directory ? `<code>${escapeHtml(updated.directory)}</code>` : `<i>${t("common.serverDefault")}</i>`,
          topicHtml: escapeHtml(updated.topicTitle),
          discardedHtml: discarded.length ? escapeHtml(discarded.join(", ")) : null,
          warning: topicRenameWarning,
        }),
      })
      return
    }
    if (!opencode?.abortSession) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: t("commands.reset.abortUnavailable") })
      return
    }

    const topic = state.topicRecord(message.chat.id, currentTopicId) || binding
    let profile
    try {
      profile = resolveResetProfile(requested, binding, config.promptProfiles)
      if (!profile.promptProfile) {
        profile.promptProfile = await resolveSessionProfile({ opencode, binding, defaultProfile: config.defaultPrompt })
        if (typeof opencode.request === "function") {
          const system = await opencode.request(opencode.server(binding.serverID), "/opencodez/prompts/state", {
            method: "POST", directory: binding.directory, timeoutMs: 15_000,
            body: { sessionID: binding.sessionID, ...(profile.promptProfile.model ? { model: { providerID: profile.promptProfile.model.providerID, id: profile.promptProfile.model.modelID } } : {}) },
          })
          if (system.state?.manual) profile.promptProfile.opencodezSystem = system.state.system
          else delete profile.promptProfile.opencodezSystem
        }
      }
    } catch (error) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.reset.profileRequired", { errorHtml: escapeHtml(error.message) }),
      })
      return
    }
    const targetServerID = requested.serverID || binding.serverID
    const serverChanged = targetServerID !== binding.serverID
    const targetDirectory = serverChanged ? opencode.defaultNewSessionDirectory(targetServerID) : binding.directory
    if (serverChanged && !(await preflightResetServer(message, currentTopicId, targetServerID, targetDirectory))) return

    promptQueue.markExpectedStop(binding)
    try {
      await opencode.abortSession(binding.serverID, binding.sessionID, { directory: binding.directory })
    } catch (error) {
      promptQueue.clearExpectedStop(binding)
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.reset.stopFailed", { errorHtml: escapeHtml(error.message) }),
      })
      return
    }

    const cleared = promptQueue.clear(binding, "Discarded by /reset")
    const discardedMultipart = multipartPrompts.discardKey?.(promptKey) || false
    const discardedAttachments = await discardAttachmentBatch(promptKey)
    const titleFields = managedTopicTitle(topicBaseTitle(topic), targetServerID, opencode.servers)
    const reset = await state.resetBindingToPending(binding, {
      ...profile,
      serverID: targetServerID,
      directory: targetDirectory,
      title: titleFields.topicBaseTitle,
      titleSource: "user",
      ...titleFields,
    })
    if (!reset) {
      promptQueue.clearExpectedStop(binding)
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.reset.bindingChanged"),
      })
      return
    }
    detachBinding(binding)
    await settings?.used(reset.pending.promptProfileName)

    let topicRenameWarning = null
    if (titleFields.topicTitle !== topic.topicTitle) {
      try {
        await telegram.editForumTopic({ chatId: message.chat.id, topicId: currentTopicId, name: titleFields.topicTitle })
      } catch (error) {
        topicRenameWarning = t("commands.reset.renameFailed", { errorHtml: escapeHtml(error.message) })
      }
    }

    const discarded = []
    if (cleared.length) discarded.push(t("commands.reset.discardedPrompts", { count: cleared.length }))
    if (discardedMultipart) discarded.push(t("commands.reset.discardedMultipart"))
    if (discardedAttachments) {
      discarded.push(t("commands.reset.discardedAttachments", { count: discardedAttachments }))
    }
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId,
      text: t("commands.reset.freshReady", {
        profileHtml: escapeHtml(reset.pending.promptProfileName || t("common.current")),
        serverLine: serverChanged
          ? t("commands.reset.serverChanged", { previousHtml: escapeHtml(binding.serverID), nextHtml: escapeHtml(reset.pending.serverID) })
          : t("commands.reset.server", { serverHtml: escapeHtml(reset.pending.serverID) }),
        directoryHtml: reset.pending.directory ? `<code>${escapeHtml(reset.pending.directory)}</code>` : `<i>${t("common.serverDefault")}</i>`,
        topicHtml: escapeHtml(reset.pending.topicTitle),
        sessionHtml: escapeHtml(binding.sessionID),
        discardedHtml: discarded.length ? escapeHtml(discarded.join(", ")) : null,
        warning: topicRenameWarning,
      }),
    })
  }

  async function preflightResetServer(message, currentTopicId, serverID, directory) {
    try {
      await opencode.sessionStatus(serverID, "__opencodebot_preflight__", { directory })
      return true
    } catch (error) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: t("commands.reset.switchFailed", { serverHtml: escapeHtml(serverID), errorHtml: escapeHtml(error.message) }),
      })
      return false
    }
  }

  async function handleSoundsHere(message) {
    if (!speech?.enabled()) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("commands.speech.disabled") })
      return
    }
    await speech.setCurrentTopic(message)
    await speech.createOrRefreshMenu({ chatId: message.chat.id, topicId: topicId(message) })
  }

  async function handleSoundsOff(message) {
    const cleared = speech ? await speech.clearCurrentTopic(message) : false
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: cleared
        ? t("commands.speech.inboxDisabled")
        : t("commands.speech.notInbox"),
    })
  }

  async function handleSoundsStatus(message) {
    const status = speech?.status?.() || { enabled: false, configured: false, topic: null, queueDepth: 0, active: 0 }
    const providers = status.providers?.map((provider) => provider.configured
      ? t("commands.speech.providerConfigured", { label: escapeHtml(provider.label) })
      : t("commands.speech.providerMissing", { label: escapeHtml(provider.label), envHtml: escapeHtml(provider.apiKeyEnv) }))
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: t("commands.speech.status", {
        enabled: t(status.enabled ? "common.yes" : "common.no"),
        providers: providers?.length
          ? providers.join("; ")
          : status.configured
            ? t("common.configured")
            : status.apiKeyEnv
              ? t("commands.speech.providerMissing", { label: t("commands.speech.apiKey"), envHtml: escapeHtml(status.apiKeyEnv) })
              : t("common.notConfigured"),
        modelLine: status.model ? t("commands.speech.modelLine", { modelHtml: escapeHtml(status.modelLabel || status.model), provider: status.modelProvider ? escapeHtml(status.modelProvider) : "" }) : null,
        languageLine: status.language ? t("commands.speech.languageLine", { languageHtml: escapeHtml(status.language) }) : null,
        topicIdHtml: status.topic ? `<code>${escapeHtml(String(status.topic.topicId || 0))}</code>` : null,
        activeHtml: escapeHtml(String(status.active || 0)),
        queueHtml: escapeHtml(String(status.queueDepth || 0)),
      }),
    })
  }

  async function handleNotifyOn(message) {
    if (config.finalNotifications?.enabled === false) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("commands.notifications.disabledConfig") })
      return
    }
    const userIds = configuredFinalNotificationUserIds()
    if (!userIds.length) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("commands.notifications.noRecipients") })
      return
    }
    const enabled = []
    const failed = []
    for (const userID of userIds) {
      try {
        await telegram.sendMessage({
          chatId: userID,
          text: t("commands.notifications.dmEnabled"),
        })
        await state.enableFinalNotificationsFor(userID)
        enabled.push(userID)
      } catch (error) {
        failed.push({ userID, error })
      }
    }
    if (failed.length) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: t("commands.notifications.failed", {
          enabled: enabled.length,
          failures: failed.map((item) => `<code>${escapeHtml(item.userID)}</code>: <code>${escapeHtml(item.error.message)}</code>`),
        }),
      })
      return
    }
    await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("commands.notifications.enabled", { count: enabled.length }) })
  }

  async function handleNotifyOff(message) {
    const userIds = configuredFinalNotificationUserIds()
    for (const userID of userIds) await state.disableFinalNotificationsFor(userID)
    await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("commands.notifications.disabled", { count: userIds.length }) })
  }

  async function handleNotifyStatus(message) {
    const userIds = configuredFinalNotificationUserIds()
    const enabled = config.finalNotifications?.enabled !== false ? userIds.filter((userID) => state.finalNotificationsEnabledFor(userID)) : []
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: t("commands.notifications.status", {
        disabled: config.finalNotifications?.enabled === false,
        configured: escapeHtml(String(userIds.length)),
        enabled: escapeHtml(String(enabled.length)),
      }),
    })
  }

  async function handleDebugMode(message, enabled) {
    const currentTopicId = topicId(message)
    await state.setDebugEnabled(enabled)
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId || undefined,
      text: enabled ? t("commands.debug.enabled") : t("commands.debug.disabled"),
    })
  }

  async function handleDebugStatus(message) {
    const currentTopicId = topicId(message)
    const enabled = state.debugEnabled()
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId || undefined,
      text: t("commands.debug.status", { enabled: t(enabled ? "common.enabled" : "common.disabled") }),
    })
  }

  function configuredFinalNotificationUserIds() {
    return [...new Set((config.finalNotifications?.userIds || []).map(String))]
  }

  async function handleArtifactsHere(message) {
    const currentTopicId = topicId(message)
    if (!currentTopicId) {
      await telegram.sendMessage({ chatId: message.chat.id, text: t("commands.artifacts.topicRequired") })
      return
    }
    const existing = state.topicRecord(message.chat.id, currentTopicId)
    const target = await state.setArtifactsTopic({
      chatId: message.chat.id,
      topicId: currentTopicId,
      title: message.forum_topic_created?.name || message.reply_to_message?.forum_topic_created?.name
        || (state.isArtifactsTopic(message.chat.id, currentTopicId) ? state.artifactsTopic().title : null)
        || existing?.topicTitle || null,
      setBy: message.from?.id,
    })
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId,
      text: t("commands.artifacts.configured", {
        targetHtml: `<code>${escapeHtml(String(target.chatId))}</code> / <code>${escapeHtml(String(target.topicId))}</code>`,
        help: formatArtifactUploadHelp({
          defaultServerId: config.artifactUploads?.defaultServerId,
          availableServerIds: Array.from(opencode.servers.keys()).sort(),
        }),
      }),
    })
  }

  async function handleSessionInfo(message) {
    const L = (ru, en) => localText(ru, en, getLanguage())
    const value = (text) => escapeHtml(String(text || "—"))
    const code = (text) => `<code>${value(text)}</code>`
    const copyId = (id) => richButton({ text: id, copy_text: { text: id } })
    const currentTopicId = topicId(message)
    const thisIsArtifactsTopic = state.isArtifactsTopic(message.chat.id, currentTopicId)
    const thisIsSoundsTopic = state.isSoundsTopic(message.chat.id, currentTopicId)
    const serviceTopic = thisIsArtifactsTopic || thisIsSoundsTopic
    const activeBinding = serviceTopic ? null : state.findBindingByTopic(message.chat.id, currentTopicId)
    const candidate = !serviceTopic && !activeBinding ? state.pendingTopic(currentTopicId) : null
    const pending = candidate && String(candidate.chatId) === String(message.chat.id) ? candidate : null
    const previousBinding = serviceTopic ? null : state.findAnyBindingByTopic(message.chat.id, currentTopicId)
    const storedBinding = activeBinding || (!pending ? previousBinding : null)
    const serverID = storedBinding?.serverID || pending?.serverID
    const server = serverID ? config.opencode.servers.find((item) => item.id === serverID) : null
    const artifactsTopic = state.artifactsTopic()
    const soundsTopic = state.soundsTopic()
    let session = null
    let sessionError = null
    let status = pending ? L("Ожидает первого запроса", "Waiting for the first prompt") : L("Нет активной сессии", "No active session")
    if (storedBinding?.sessionID) {
      const options = { directory: storedBinding.directory, timeoutMs: 5000 }
      const [info, live] = await Promise.allSettled([
        opencode.getSession(serverID, storedBinding.sessionID, options),
        activeBinding ? opencode.sessionStatus(serverID, storedBinding.sessionID, options) : Promise.resolve(null),
      ])
      if (info.status === "fulfilled") session = info.value
      else sessionError = info.reason
      if (activeBinding) {
        status = sessionError && isOpenCodeSessionNotFound(sessionError, storedBinding.sessionID) ? L("Сессия удалена на сервере", "Session deleted on the server")
          : sessionError || live.status === "rejected" ? L("Не удалось проверить сессию", "Could not check the session")
          : live.value?.type === "idle" ? L("Готова", "Ready") : L("В работе", "Running")
      } else status = L("Связь с темой отключена", "Topic connection disabled")
    }
    const launch = pending?.promptProfile || storedBinding?.promptProfile || {}
    const model = session?.model || storedBinding?.model || launch.model || {}
    const directory = session?.directory || storedBinding?.directory || pending?.directory
    const sessionUrl = isOpenCodeSessionNotFound(sessionError, storedBinding?.sessionID) ? "" : sessionWebUrl(server, storedBinding?.sessionID, { directory })
    const role = [thisIsArtifactsTopic ? L("Приём и отправка файлов", "Incoming files and agent artifacts") : null,
      thisIsSoundsTopic ? L("Расшифровка аудио", "Audio transcription") : null].filter(Boolean).join(" · ")
    const rows = [[serviceTopic ? L("Назначение", "Purpose") : L("Состояние", "Status"), value(role || status)]]
    if (serverID) rows.push([L("Сервер", "Server"), value(serverID)])
    rows.push([storedBinding && !activeBinding ? L("Последняя сессия", "Last session") : L("ID сессии", "Session ID"),
      storedBinding?.sessionID ? copyId(storedBinding.sessionID) : value(pending ? L("Создастся с первым запросом", "Created on the first prompt") : L("Нет", "None"))])
    if (pending || storedBinding) rows.push(
      [L("Профиль", "Profile"), value(pending?.promptProfileName || storedBinding?.promptProfileName || L("Автовыбор", "Automatic"))],
      [L("Модель", "Model"), `<b>${value(model.modelID || model.id || L("Автовыбор OpenCodez", "OpenCodez automatic"))}</b>`],
      ["Reasoning", value(model.variant || L("По умолчанию", "Default"))],
    )
    if (activeBinding) rows.push([L("Запросов в очереди", "Queued prompts"), String(promptQueue.status(activeBinding).length)])
    const topic = state.topicRecord(message.chat.id, currentTopicId)
    const topicName = serviceTopic ? (thisIsArtifactsTopic ? artifactsTopic?.title : soundsTopic?.title)
      : topic?.topicTitle || topic?.title || (!currentTopicId ? "General" : null)
    let details = `<h3>${L("Тема, где вызвана /session", "Topic where /session was called")}</h3>` + menuTable([
      [L("Название темы", "Topic name"), value(topicName || L("Название ещё неизвестно боту", "Name not yet known to the bot"))],
      [L("Назначение", "Purpose"), value(role || (pending || storedBinding ? L("Работа с агентом", "Agent conversation") : L("Сессия не назначена", "No session assigned")))],
      [L("ID этой темы", "This topic's ID"), code(String(currentTopicId || 0))],
      [L("ID группы", "Group ID"), code(message.chat.id)],
    ])
    if (pending || storedBinding) {
      const connection = pending ? L("Новая сессия ещё не создана. Отправь запрос в эту тему, чтобы начать.", "The new session has not been created yet. Send a prompt in this topic to start.")
        : activeBinding ? L("Сообщения этой темы связаны с указанной выше сессией.", "Messages in this topic are connected to the session above.")
        : L("Указана последняя сессия этой темы. Новые сообщения ей не отправляются.", "The last session of this topic is shown. New messages are not sent to it.")
      const settingsRows = [
        [L("Папка проекта", "Project directory"), code(directory)],
        [L("Агент", "Agent"), value(session?.agent || storedBinding?.agent || launch.agent || L("Автовыбор OpenCodez", "OpenCodez automatic"))],
        [L("Провайдер модели", "Model provider"), value(model.providerID || L("Автовыбор OpenCodez", "OpenCodez automatic"))],
      ]
      if (session?.title) settingsRows.push([L("Название в OpenCodez", "OpenCodez title"), value(session.title)])
      if (server?.url) settingsRows.push([L("Адрес OpenCodez", "OpenCodez address"), `<a href="${value(server.url)}">${value(server.url)}</a>`])
      if (pending && previousBinding?.sessionID) settingsRows.push([L("Предыдущая сессия", "Previous session"), copyId(previousBinding.sessionID)])
      if (!activeBinding && storedBinding?.disabledReason) {
        const reasons = {
          "topic-reset": L("Сессия сброшена через /reset", "Session reset with /reset"),
          "Telegram topic closed": L("Тема закрыта в Telegram", "Telegram topic closed"),
          "Telegram topic deleted": L("Тема удалена в Telegram", "Telegram topic deleted"),
          "internal session": L("Внутренняя сессия OpenCodez", "Internal OpenCodez session"),
        }
        settingsRows.push([L("Причина отключения", "Disconnection reason"), value(reasons[storedBinding.disabledReason] || storedBinding.disabledReason)])
      }
      details += `<h3>OpenCodez</h3><p>${connection}</p>` + menuTable(settingsRows)
      if (sessionError) details += `<p>${isOpenCodeSessionNotFound(sessionError, storedBinding.sessionID)
        ? L("Сессия больше не существует в OpenCodez. Показаны сохранённые настройки.", "This session no longer exists in OpenCodez. Saved settings are shown.")
        : L("Сведения с сервера недоступны. Показаны сохранённые настройки; ссылка использует сохранённую папку проекта.", "Server information is unavailable. Saved settings are shown; the link uses the saved project directory.")}</p>`
      else details += `<p>${pending ? L("Это настройки запуска будущей сессии.", "These are the launch settings for the next session.")
        : L("Модель и профиль — сохранённые настройки запуска этой сессии, если сервер не сообщил другие значения.", "Model and profile are the saved launch settings for this session unless the server reported other values.")}</p>`
    }
    const destination = (target) => !target ? value(L("Не назначена", "Not assigned"))
      : `<a href="${telegramMessageLink(target.chatId, target.topicId)}">${value(target.title || L("Открыть назначенную тему", "Open the assigned topic"))} ↗</a><br>${code(target.topicId)}`
    details += `<h3>${L("Куда поступают файлы и аудио", "File and audio destinations")}</h3><p>${L("Назначенные служебные темы. Название и ID в каждой строке относятся к получателю файлов или аудио.", "Assigned service topics. The name and ID in each row identify the file or audio destination.")}</p>` + menuTable([
      [L("Файлы и артефакты", "Files and artifacts"), destination(artifactsTopic)],
      [L("Голос и аудио", "Voice and audio"), destination(soundsTopic)],
    ])
    const summary = `<h2>💬 ${L("Сессия", "Session")}</h2>` + menuTable(rows)
      + (storedBinding?.sessionID ? `<p>${L("Нажми ID сессии, чтобы скопировать его.", "Tap the session ID to copy it.")}</p>` : "")
    await telegram.sendRichMessage({
      chatId: message.chat.id,
      topicId: currentTopicId,
      html: summary + (sessionUrl ? buttonRows([[{ text: t("commands.session.openButton"), url: sessionUrl, style: "primary" }]]) : "")
        + `<details><summary>${L("О теме и подключениях", "Topic and connections")}</summary>${details}</details>`,
    })
  }

  async function sendQueueStatus(message, binding) {
    const items = promptQueue.status(binding)
    if (!items.length) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("commands.queue.empty") })
      return
    }
    const lines = items.map((item) => `${item.index}. <code>${escapeHtml(item.summary)}</code>`)
    await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("commands.queue.status", { lines }) })
  }
}

function resolveResetProfile(requested, binding, promptProfiles = {}) {
  if (requested.promptProfileName) return requested

  const promptProfileName = binding.promptProfileName || null
  if (!promptProfileName) return { promptProfileName: null, promptProfile: binding.promptProfile || binding.setupProfile || null }

  const promptProfile = promptProfiles[promptProfileName] || binding.promptProfile || binding.setupProfile
  if (!promptProfile) {
    const available = Object.keys(promptProfiles).join(", ") || "none configured"
    throw new Error(
      `Current profile is no longer configured: ${promptProfileName}. ` +
        `Choose one with /reset PROFILE [SERVER]. Available profiles: ${available}`,
    )
  }

  return { promptProfileName, promptProfile }
}

function sessionWebUrl(server, sessionID, session) {
  const baseUrl = String(server?.url || "").replace(/\/+$/, "")
  const directory = session?.directory
  if (!baseUrl || !sessionID || !directory) return ""
  const encodedDirectory = Buffer.from(String(directory)).toString("base64").replace(/=+$/, "")
  return `${baseUrl}/${encodeURIComponent(encodedDirectory)}/session/${encodeURIComponent(sessionID)}`
}

function contextExportErrorText(error, count) {
  if (error.code !== "CONTEXT_TOO_LARGE") {
    return t("commands.context.collapsedFailed")
  }
  if (count === 1) return t("commands.context.latestTooLarge")
  return t("commands.context.tooLargeCollapsed", { nextCount: count - 1 })
}
