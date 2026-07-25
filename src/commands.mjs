import { summarizeWords } from "./prompt-queue.mjs"
import { escapeHtml, topicId } from "./telegram.mjs"
import { parseResetArgs } from "./chat-templates.mjs"
import { managedTopicTitle, topicBaseTitle } from "./topic-titles.mjs"
import { formatArtifactUploadHelp } from "./artifact-uploads.mjs"
import { logErrorEvent, logInfo, logWarn } from "./logger.mjs"
import { getLanguage, normalizeLanguage, setLanguage, t } from "./i18n/index.mjs"
import { resolveSessionProfile } from "./opencode.mjs"
import {
  buildCollapsedContextMessages,
  DEFAULT_CONTEXT_TURNS,
  loadRecentContextTurns,
  MAX_CONTEXT_TURNS,
  parseContextTurnCount,
} from "./context-export.mjs"

const commandDefinitions = [
  ["new", "new"],
  ["reset", "reset"],
  ["session", "session"],
  ["artifacts_here", "artifacts_here"],
  ["sounds_here", "sounds_here"],
  ["sounds_off", "sounds_off"],
  ["sounds_status", "sounds_status"],
  ["q", "q"],
  ["kill", "kill"],
  ["compact", "compact"],
  ["context", "context"],
  ["set_context", "set_context"],
  ["notify_on", "notify_on"],
  ["notify_off", "notify_off"],
  ["notify_status", "notify_status"],
  ["tts", "tts"],
  ["speak", "speak"],
  ["lang", "lang"],
  ["update", "update"],
  ["debug_on", "debug_on"],
  ["debug_off", "debug_off"],
  ["debug_status", "debug_status"],
  ["mode", "mode"],
  ["mirror_on", "mirror_on"],
  ["mirror_off", "mirror_off"],
  ["help", "help"],
  ["start", "start"],
]

export function telegramBotCommands() {
  return commandDefinitions.map(([command, descriptionKey]) => ({
    command,
    description: t(`command.description.${descriptionKey}`),
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
  speech,
  finalVoice,
  questionManager,
  updateManager,
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
    new: createPendingTopic,
    reset: handleResetCommand,
    help: sendHelp,
    start: sendHelp,
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
    ...(finalVoice?.commandHandlers?.() || {}),
  }

  return {
    async handle(message, command, promptKey) {
      const handler = handlers[command.name]
      if (!handler) return false
      if (command.name === "kill") multipartPrompts.discardKey?.(promptKey)
      else if (command.name !== "reset") await multipartPrompts.flushKey(promptKey)
      await handler(message, command.args, promptKey)
      return true
    },
    async handleCallback(query) {
      if (await updateManager?.handleCallback?.(query)) return true
      if (await questionManager?.handleCallback?.(query)) return true
      return Boolean(await speech?.handleCallbackQuery?.(query))
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

    const feedback = await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId,
      text: t("commands.compact.starting"),
    })
    const operation = { cancelled: false }
    compactOperations.set(compactOperationKey(binding), operation)
    promptQueue.markBusy(binding)
    void compactSessionInBackground({ binding, message, feedback, model: profile.model, operation }).catch((error) => {
      logErrorEvent("compact.background_failed", error, { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId })
    })
  }

  async function compactSessionInBackground({ binding, message, feedback, model, operation }) {
    try {
      await opencode.summarizeSession(binding.serverID, binding.sessionID, { directory: binding.directory, model })
      if (operation.cancelled) {
        await updateCompactFeedback({ message, feedback, text: t("commands.compact.stopped") })
        return
      }
      await updateCompactFeedback({
        message,
        feedback,
        text: t("commands.compact.completed"),
      })
      logInfo("compact.completed", { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId })
    } catch (error) {
      if (operation.cancelled) {
        await updateCompactFeedback({ message, feedback, text: t("commands.compact.stopped") })
        return
      }
      await releaseCompactQueueAfterFailure(binding)
      logErrorEvent("compact.failed", error, { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId })
      await updateCompactFeedback({
        message,
        feedback,
        text: t("commands.compact.failed", { errorHtml: escapeHtml(error.message) }),
      })
    } finally {
      if (compactOperations.get(compactOperationKey(binding)) === operation) compactOperations.delete(compactOperationKey(binding))
    }
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
      requested = parseResetArgs(args, { chatTemplates: config.chatTemplates, servers: opencode.servers })
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
      const profile = requested.chatTemplateName ? requested : {
        chatTemplateName: pending.chatTemplateName,
        chatTemplate: pending.chatTemplate,
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
          profileHtml: escapeHtml(updated.chatTemplateName || t("common.current")),
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
      profile = resolveResetProfile(requested, binding, config.chatTemplates)
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
        profileHtml: escapeHtml(reset.pending.chatTemplateName || t("common.current")),
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
    const existing = state.findBindingByTopic(message.chat.id, currentTopicId)
    const target = await state.setArtifactsTopic({
      chatId: message.chat.id,
      topicId: currentTopicId,
      title: existing?.title || `Topic ${currentTopicId}`,
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
    const currentTopicId = topicId(message)
    const activeBinding = state.findBindingByTopic(message.chat.id, currentTopicId)
    const pending = activeBinding ? null : state.pendingTopic(currentTopicId)
    const previousBinding = state.findAnyBindingByTopic(message.chat.id, currentTopicId)
    const storedBinding = activeBinding || (!pending ? previousBinding : null)
    const serverID = storedBinding?.serverID || pending?.serverID
    const server = serverID ? config.opencode.servers.find((item) => item.id === serverID) : null
    const artifactsTopic = state.artifactsTopic()
    const thisIsArtifactsTopic = state.isArtifactsTopic(message.chat.id, currentTopicId)
    const soundsTopic = state.soundsTopic()
    const thisIsSoundsTopic = state.isSoundsTopic(message.chat.id, currentTopicId)
    let session = null
    let sessionError = ""
    if (storedBinding?.serverID && storedBinding?.sessionID && opencode?.getSession) {
      try {
        session = await opencode.getSession(storedBinding.serverID, storedBinding.sessionID, { directory: storedBinding.directory })
      } catch (error) {
        sessionError = error.message
      }
    }
    const sessionUrl = sessionWebUrl(server, storedBinding?.sessionID, session)
    const lines = [
      t("commands.session.title"),
      "",
      t("commands.session.telegram"),
      `chat_id: <code>${escapeHtml(String(message.chat.id))}</code>`,
      `topic_id: <code>${escapeHtml(String(currentTopicId || 0))}</code>`,
      `message_id: <code>${escapeHtml(String(message.message_id))}</code>`,
      "",
    ]
    if (pending) {
      lines.push(
        t("commands.session.binding"),
        t("commands.session.waiting"),
        t("commands.session.server", { valueHtml: escapeHtml(pending.serverID || "") }),
        pending.chatTemplateName ? t("commands.session.profile", { valueHtml: escapeHtml(pending.chatTemplateName) }) : t("commands.session.profileDefault"),
        previousBinding?.sessionID
          ? t("commands.session.previous", { valueHtml: escapeHtml(previousBinding.sessionID) })
          : null,
        pending.title ? t("commands.session.titleLine", { valueHtml: escapeHtml(pending.title) }) : null,
        "",
      )
    } else if (storedBinding) {
      lines.push(
        t("commands.session.binding"),
        t(activeBinding ? "commands.session.statusActive" : "commands.session.statusDisabled"),
        t("commands.session.server", { valueHtml: escapeHtml(storedBinding.serverID || "") }),
        t("commands.session.session", { valueHtml: escapeHtml(storedBinding.sessionID || "") }),
        storedBinding.disabledReason ? t("commands.session.reason", { valueHtml: escapeHtml(storedBinding.disabledReason) }) : null,
        storedBinding.title ? t("commands.session.titleLine", { valueHtml: escapeHtml(storedBinding.title) }) : null,
        "",
      )
    } else {
      lines.push(t("commands.session.binding"), t("commands.session.statusNone"), "")
    }
    if (storedBinding) {
      const directory = session?.directory || storedBinding.directory
      lines.push(
        t("commands.session.opencode"),
        server?.url ? t("commands.session.serverUrl", { valueHtml: escapeHtml(server.url) }) : t("commands.session.serverUrlUnavailable"),
        directory ? t("commands.session.directory", { valueHtml: escapeHtml(directory) }) : null,
        session?.agent || storedBinding.agent ? t("commands.session.agent", { valueHtml: escapeHtml(session?.agent || storedBinding.agent) }) : null,
        modelLine(session?.model || storedBinding.model),
        sessionUrl ? t("commands.session.url", { valueHtml: escapeHtml(sessionUrl) }) : t("commands.session.urlUnavailable"),
        sessionError ? t("commands.session.lookupError", { valueHtml: escapeHtml(sessionError) }) : null,
        "",
      )
    }
    lines.push(
      t("commands.session.artifacts"),
      t("commands.session.thisTopic", { yes: thisIsArtifactsTopic }),
      t("commands.session.currentTopic", { valueHtml: artifactsTopic ? `<code>${escapeHtml(String(artifactsTopic.topicId || 0))}</code>` : null }),
      artifactsTopic?.title ? t("commands.session.currentTitle", { valueHtml: escapeHtml(artifactsTopic.title) }) : null,
      "",
      t("commands.session.sounds"),
      t("commands.session.thisTopic", { yes: thisIsSoundsTopic }),
      t("commands.session.currentTopic", { valueHtml: soundsTopic ? `<code>${escapeHtml(String(soundsTopic.topicId || 0))}</code>` : null }),
      soundsTopic?.title ? t("commands.session.currentTitle", { valueHtml: escapeHtml(soundsTopic.title) }) : null,
    )
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId,
      text: lines.filter(Boolean).join("\n"),
      replyMarkup: sessionUrl ? { inline_keyboard: [[{ text: t("commands.session.openButton"), url: sessionUrl }]] } : undefined,
    })
  }

  async function sendHelp(message) {
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: helpText(),
    })
  }

  function helpText() {
    const profiles = Object.keys(config.chatTemplates || {}).join(", ") || "none"
    return t("commands.help.body", { maxContextTurns: MAX_CONTEXT_TURNS, profilesHtml: escapeHtml(profiles) })
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

function resolveResetProfile(requested, binding, chatTemplates = {}) {
  if (requested.chatTemplateName) return requested

  const chatTemplateName = binding.chatTemplateName || null
  if (!chatTemplateName) return { chatTemplateName: null, chatTemplate: null }

  const chatTemplate = chatTemplates[chatTemplateName]
  if (!chatTemplate) {
    const available = Object.keys(chatTemplates).join(", ") || "none configured"
    throw new Error(
      `Current profile is no longer configured: ${chatTemplateName}. ` +
        `Choose one with /reset PROFILE [SERVER]. Available profiles: ${available}`,
    )
  }

  return { chatTemplateName, chatTemplate }
}

function sessionWebUrl(server, sessionID, session) {
  const baseUrl = String(server?.url || "").replace(/\/+$/, "")
  const directory = session?.directory
  if (!baseUrl || !sessionID || !directory) return ""
  const encodedDirectory = Buffer.from(String(directory)).toString("base64").replace(/=+$/, "")
  return `${baseUrl}/${encodeURIComponent(encodedDirectory)}/session/${encodeURIComponent(sessionID)}`
}

function modelLine(model) {
  if (!model) return null
  const provider = model.providerID ? `${model.providerID}/` : ""
  const id = model.modelID || model.id || ""
  const variant = model.variant ? ` ${model.variant}` : ""
  const value = `${provider}${id}${variant}`.trim()
  return value ? t("commands.session.model", { valueHtml: escapeHtml(value) }) : null
}

function contextExportErrorText(error, count) {
  if (error.code !== "CONTEXT_TOO_LARGE") {
    return t("commands.context.collapsedFailed")
  }
  if (count === 1) return t("commands.context.latestTooLarge")
  return t("commands.context.tooLargeCollapsed", { nextCount: count - 1 })
}
