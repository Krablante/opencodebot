import { summarizeWords } from "./prompt-queue.mjs"
import { escapeHtml, topicId } from "./telegram.mjs"
import { parseResetArgs } from "./chat-templates.mjs"
import { managedTopicTitle, topicBaseTitle } from "./topic-titles.mjs"
import { formatArtifactUploadHelp } from "./artifact-uploads.mjs"
import { logErrorEvent, logInfo } from "./logger.mjs"
import { resolveSessionProfile } from "./opencode.mjs"
import {
  buildCollapsedContextMessages,
  DEFAULT_CONTEXT_TURNS,
  loadRecentContextTurns,
  MAX_CONTEXT_TURNS,
  parseContextTurnCount,
} from "./context-export.mjs"

export const telegramBotCommands = [
  { command: "new", description: "Create a new OpenCodez session topic" },
  { command: "reset", description: "Start fresh; optionally change profile/server" },
  { command: "session", description: "Show topic, session, and special topic status" },
  { command: "artifacts_here", description: "Use this topic for agent artifact uploads" },
  { command: "sounds_here", description: "Use this topic as the speech inbox" },
  { command: "sounds_off", description: "Disable the dedicated speech inbox" },
  { command: "sounds_status", description: "Show speech transcription status" },
  { command: "q", description: "Queue prompts for the current session" },
  { command: "kill", description: "Stop the current run and clear queued prompts" },
  { command: "compact", description: "Compact the current session context" },
  { command: "context", description: "Copy recent completed turns" },
  { command: "set_context", description: "Set default context turn count" },
  { command: "notify_on", description: "Enable final-answer DMs" },
  { command: "notify_off", description: "Disable final-answer DMs" },
  { command: "notify_status", description: "Show final-answer DM status" },
  { command: "update", description: "Check for opencodebot updates" },
  { command: "debug_on", description: "Enable global final-DM diagnostics" },
  { command: "debug_off", description: "Disable global final-DM diagnostics" },
  { command: "debug_status", description: "Show global diagnostics status" },
  { command: "mode", description: "Show or set full/economy mirror mode" },
  { command: "mirror_on", description: "Enable web-to-Telegram mirroring" },
  { command: "mirror_off", description: "Disable web-to-Telegram mirroring" },
  { command: "help", description: "Show commands and chat profiles" },
  { command: "start", description: "Show help" },
]

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
  questionManager,
  updateManager,
}) {
  const compactOperations = new Map()
  const handlers = {
    mirror_on: async (message) => {
      await state.setMirrorEnabled(true)
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Mirror enabled." })
    },
    mirror_off: async (message) => {
      await state.setMirrorEnabled(false)
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Mirror disabled." })
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
    mode: handleMirrorMode,
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

  async function handleMirrorMode(message, args) {
    const requested = String(args || "").trim().toLowerCase()
    if (requested && requested !== "status" && requested !== "full" && requested !== "economy") {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: "Usage: <code>/mode</code>, <code>/mode full</code>, or <code>/mode economy</code>",
      })
      return
    }
    const mode = requested === "full" || requested === "economy" ? await state.setMirrorMode(requested) : state.mirrorMode()
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: `🎛️ Mode: <b>${escapeHtml(mode.toUpperCase())}</b>\nScope: all mirrored topics`,
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
        text: `Usage: <code>/set_context N</code> where N is 1–${MAX_CONTEXT_TURNS}.`,
      })
      return
    }
    if (count === undefined) {
      const current = state.contextTurnsForUser(userID, DEFAULT_CONTEXT_TURNS)
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: `📋 <b>Context default:</b> ${current} ${turnLabel(current)}\nUse <code>/set_context N</code> to change it.`,
      })
      return
    }
    await state.setContextTurnsForUser(userID, count)
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: `✅ <b>Context default saved:</b> ${count} ${turnLabel(count)}\n<code>/context</code> now uses this value; <code>/context N</code> overrides it once.`,
    })
  }

  async function handleContext(message, args) {
    const currentTopicId = topicId(message)
    const binding = state.findBindingByTopic(message.chat.id, currentTopicId)
    if (!binding) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: "This topic is not bound to an active OpenCodez session.",
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
        text: `Usage: <code>/context [N]</code> where N is 1–${MAX_CONTEXT_TURNS}.`,
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
          text: "📋 No completed or interrupted turns are available yet. The active unfinished turn is intentionally omitted.",
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
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "No OpenCodez session is bound to this topic. Use /new to create a topic, or run /q inside an existing OpenCodez topic." })
      return
    }

    const input = String(args || "").trim()
    if (!input || input.toLowerCase() === "status") {
      await sendQueueStatus(message, binding)
      return
    }

    if (/^delete\b/i.test(input) && !/^delete\s+\d+$/i.test(input)) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Usage: <code>/q delete &lt;number&gt;</code>" })
      return
    }

    const deleteMatch = input.match(/^delete\s+(\d+)$/i)
    if (deleteMatch) {
      const removed = promptQueue.delete(binding, Number(deleteMatch[1]))
      const text = removed
        ? `Deleted queued prompt #${removed.index}: <code>${escapeHtml(removed.summary)}</code>`
        : `No queued prompt #${escapeHtml(deleteMatch[1])}.`
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text })
      return
    }

    const result = await promptQueue.enqueue(binding, input, { sourceMessageId: message.message_id })
    if (result.status === "queued") {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: `Queued prompt #${result.position}: <code>${escapeHtml(summarizeWords(input, 10))}</code>`,
      })
    }
  }

  async function handleKillCommand(message) {
    const currentTopicId = topicId(message)
    const binding = state.findBindingByTopic(message.chat.id, currentTopicId)
    if (!binding) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: "No OpenCodez session is bound to this topic. Use /new to create a topic, or run /kill inside an existing OpenCodez topic." })
      return
    }
    if (!opencode?.abortSession) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: "OpenCodez abort API is not available." })
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
        text: `Failed to stop the current OpenCodez run.\n<code>${escapeHtml(error.message)}</code>`,
      })
      return
    }
    const cleared = promptQueue.clear(binding, "Killed by /kill")
    const lines = [
      wasBusy ? "Stop signal sent to the current OpenCodez run." : "Stop signal sent to OpenCodez.",
      cleared.length ? `Cleared ${cleared.length} queued prompt(s).` : "No queued prompts were pending.",
    ]
    await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: lines.join("\n") })
  }

  async function handleCompactCommand(message) {
    const currentTopicId = topicId(message)
    const binding = state.findBindingByTopic(message.chat.id, currentTopicId)
    if (!binding) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: "No OpenCodez session is bound to this topic. Run /compact inside an existing session topic.",
      })
      return
    }
    if (!opencode?.summarizeSession) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: "OpenCodez compaction API is not available." })
      return
    }
    if (compactOperations.has(compactOperationKey(binding))) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: "⏳ Context compaction is already running in this topic. Wait for it to finish, or use /kill to stop it.",
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
        text: `Could not inspect the OpenCodez session before compaction.\n<code>${escapeHtml(error.message)}</code>`,
      })
      return
    }
    if (status.type !== "idle") {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: "⏳ OpenCodez is still working on this session. Wait for it to become idle, or use /kill before /compact.",
      })
      return
    }
    if (!messages.some((entry) => entry?.info?.summary !== true && ["user", "assistant"].includes(entry?.info?.role))) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: "Nothing to compact yet. Send at least one prompt first." })
      return
    }

    const profile = await resolveSessionProfile({ opencode, binding, defaultProfile: config.defaultPrompt, messages })
    if (!profile.model?.providerID || !profile.model?.modelID) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: "Could not determine the current OpenCodez model. Send one prompt in this topic and retry /compact.",
      })
      return
    }

    const feedback = await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId,
      text: "🗜️ <b>Compacting context…</b>\nNew prompts will wait in this topic’s queue.",
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
        await updateCompactFeedback({ message, feedback, text: "🛑 <b>Context compaction stopped.</b>\nThe session remains available." })
        return
      }
      await updateCompactFeedback({
        message,
        feedback,
        text: "✅ <b>Context compacted.</b>\nThe next prompt will use the condensed session history.",
      })
      logInfo("compact.completed", { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId })
    } catch (error) {
      if (operation.cancelled) {
        await updateCompactFeedback({ message, feedback, text: "🛑 <b>Context compaction stopped.</b>\nThe session remains available." })
        return
      }
      await releaseCompactQueueAfterFailure(binding)
      logErrorEvent("compact.failed", error, { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId })
      await updateCompactFeedback({
        message,
        feedback,
        text: `❌ <b>Context compaction failed.</b>\n<code>${escapeHtml(error.message)}</code>\nThe session is still available.`,
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
      await telegram.sendMessage({ chatId: message.chat.id, text: "Run /reset inside an active OpenCodez session topic." })
      return
    }
    if (state.isArtifactsTopic(message.chat.id, currentTopicId) || state.isSoundsTopic(message.chat.id, currentTopicId)) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: "This special-purpose topic cannot be reset into an OpenCodez session topic.",
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
        text: escapeHtml(error.message),
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
          text: "No active OpenCodez session is bound here. Use /new to create a session topic.",
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
        discardedMultipart ? "unfinished multipart prompt" : null,
        discardedAttachments
          ? `${discardedAttachments} buffered attachment${discardedAttachments === 1 ? "" : "s"}`
          : null,
      ].filter(Boolean)
      let topicRenameWarning = null
      if (updated.topicTitle !== previousTopicTitle) {
        try {
          await telegram.editForumTopic({ chatId: message.chat.id, topicId: currentTopicId, name: updated.topicTitle })
        } catch (error) {
          topicRenameWarning = `⚠️ Topic rename failed: ${escapeHtml(error.message)}`
        }
      }
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: currentTopicId,
        text: [
          "🟡 <b>This topic is already waiting for its first prompt</b>",
          `🧠 Profile: <code>${escapeHtml(updated.chatTemplateName || "current")}</code>`,
          serverChanged
            ? `🔀 Server: <code>${escapeHtml(previousServerID)}</code> → <code>${escapeHtml(updated.serverID)}</code>`
            : `🖥️ Server: <code>${escapeHtml(updated.serverID)}</code>`,
          `📁 Directory: ${updated.directory ? `<code>${escapeHtml(updated.directory)}</code>` : "<i>server default</i>"}`,
          `💬 Topic: ${escapeHtml(updated.topicTitle)}`,
          discarded.length ? `🧹 Discarded: ${escapeHtml(discarded.join(", "))}` : null,
          topicRenameWarning,
        ].filter(Boolean).join("\n"),
      })
      return
    }
    if (!opencode?.abortSession) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: currentTopicId, text: "OpenCodez abort API is not available." })
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
        text: `⚠️ <b>Reset needs a profile</b>\n${escapeHtml(error.message)}`,
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
        text: `Reset failed while stopping the current OpenCodez session.\n<code>${escapeHtml(error.message)}</code>`,
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
        text: "The topic binding changed while it was being reset. Check /session before retrying.",
      })
      return
    }
    detachBinding(binding)

    let topicRenameWarning = null
    if (titleFields.topicTitle !== topic.topicTitle) {
      try {
        await telegram.editForumTopic({ chatId: message.chat.id, topicId: currentTopicId, name: titleFields.topicTitle })
      } catch (error) {
        topicRenameWarning = `⚠️ Topic rename failed: ${escapeHtml(error.message)}`
      }
    }

    const discarded = []
    if (cleared.length) discarded.push(`${cleared.length} queued prompt${cleared.length === 1 ? "" : "s"}`)
    if (discardedMultipart) discarded.push("an unfinished multipart prompt")
    if (discardedAttachments) {
      discarded.push(`${discardedAttachments} buffered attachment${discardedAttachments === 1 ? "" : "s"}`)
    }
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId,
      text: [
        "🆕 <b>Fresh session ready</b>",
        "",
        `🧠 Profile: <code>${escapeHtml(reset.pending.chatTemplateName || "current")}</code>`,
        serverChanged
          ? `🔀 Server: <code>${escapeHtml(binding.serverID)}</code> → <code>${escapeHtml(reset.pending.serverID)}</code>`
          : `🖥️ Server: <code>${escapeHtml(reset.pending.serverID)}</code>`,
        `📁 Directory: ${reset.pending.directory ? `<code>${escapeHtml(reset.pending.directory)}</code>` : "<i>server default</i>"}`,
        `💬 Topic: ${escapeHtml(reset.pending.topicTitle)}`,
        "",
        `♻️ Preserved: <code>${escapeHtml(binding.sessionID)}</code>`,
        discarded.length ? `🧹 Discarded: ${escapeHtml(discarded.join(", "))}` : null,
        "✍️ Send the first prompt to create the new session.",
        topicRenameWarning,
      ]
        .filter(Boolean)
        .join("\n"),
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
        text: `❌ Cannot switch to <code>${escapeHtml(serverID)}</code>: ${escapeHtml(error.message)}`,
      })
      return false
    }
  }

  async function handleSoundsHere(message) {
    if (!speech?.enabled()) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Speech transcription is disabled in config." })
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
        ? "Dedicated voice/audio inbox disabled for this topic. Voice messages in ordinary topics are still transcribed."
        : "This topic is not the dedicated voice/audio inbox.",
    })
  }

  async function handleSoundsStatus(message) {
    const status = speech?.status?.() || { enabled: false, configured: false, topic: null, queueDepth: 0, active: 0 }
    const providers = status.providers?.map((provider) => `${escapeHtml(provider.label)}: ${provider.configured ? "configured" : `missing <code>${escapeHtml(provider.apiKeyEnv)}</code>`}`)
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: [
        "<b>Voice transcription</b>",
        `enabled: ${status.enabled ? "yes" : "no"}`,
        providers?.length ? `providers: ${providers.join("; ")}` : `api_key: ${status.configured ? "configured" : status.apiKeyEnv ? `missing <code>${escapeHtml(status.apiKeyEnv)}</code>` : "not configured"}`,
        status.model ? `model: <code>${escapeHtml(status.modelLabel || status.model)}</code>${status.modelProvider ? ` · ${escapeHtml(status.modelProvider)}` : ""}` : null,
        status.language ? `language: <code>${escapeHtml(status.language)}</code>` : null,
        "voice_messages: all non-artifact topics when enabled",
        status.topic ? `dedicated_topic_id: <code>${escapeHtml(String(status.topic.topicId || 0))}</code>` : "dedicated_topic_id: none",
        `active: <code>${escapeHtml(String(status.active || 0))}</code>`,
        `queue: <code>${escapeHtml(String(status.queueDepth || 0))}</code>`,
      ].filter(Boolean).join("\n"),
    })
  }

  async function handleNotifyOn(message) {
    if (config.finalNotifications?.enabled === false) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Final DM notifications are disabled in config." })
      return
    }
    const userIds = configuredFinalNotificationUserIds()
    if (!userIds.length) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "No final notification userIds are configured." })
      return
    }
    const enabled = []
    const failed = []
    for (const userID of userIds) {
      try {
        await telegram.sendMessage({
          chatId: userID,
          text: "🔔 Final answer notifications enabled\n🏁 I will DM you when a mirrored topic gets its final answer\n🔗 The DM includes the source topic, an Open topic button, and context quotes",
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
        text: [
          enabled.length ? `🔔 Enabled for ${enabled.length} configured recipient(s).` : "🔴 No configured recipients were enabled.",
          "Some configured recipients cannot receive DMs yet:",
          ...failed.map((item) => `<code>${escapeHtml(item.userID)}</code>: <code>${escapeHtml(item.error.message)}</code>`),
          "Open a private chat with this bot from that account, press Start or send /start, then run /notify_on again.",
        ].join("\n"),
      })
      return
    }
    await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: `🔔 Final DM notifications enabled for ${enabled.length} configured recipient(s).` })
  }

  async function handleNotifyOff(message) {
    const userIds = configuredFinalNotificationUserIds()
    for (const userID of userIds) await state.disableFinalNotificationsFor(userID)
    await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: `🔕 Final DM notifications disabled for ${userIds.length} configured recipient(s).` })
  }

  async function handleNotifyStatus(message) {
    const userIds = configuredFinalNotificationUserIds()
    const enabled = config.finalNotifications?.enabled !== false ? userIds.filter((userID) => state.finalNotificationsEnabledFor(userID)) : []
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: [
        config.finalNotifications?.enabled === false ? "🔕 Final DM notifications are disabled in config." : "🔔 Final DM notifications config",
        `Configured recipients: <code>${escapeHtml(String(userIds.length))}</code>`,
        `Enabled recipients: <code>${escapeHtml(String(enabled.length))}</code>`,
      ].join("\n"),
    })
  }

  async function handleDebugMode(message, enabled) {
    const currentTopicId = topicId(message)
    await state.setDebugEnabled(enabled)
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId || undefined,
      text: enabled
        ? "🐛 Global debug diagnostics enabled. Every final DM will end with an expandable run-diagnostics block."
        : "Global debug diagnostics disabled.",
    })
  }

  async function handleDebugStatus(message) {
    const currentTopicId = topicId(message)
    const enabled = state.debugEnabled()
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId || undefined,
      text: `🐛 Global debug diagnostics: <code>${enabled ? "enabled" : "disabled"}</code>.`,
    })
  }

  function configuredFinalNotificationUserIds() {
    return [...new Set((config.finalNotifications?.userIds || []).map(String))]
  }

  async function handleArtifactsHere(message) {
    const currentTopicId = topicId(message)
    if (!currentTopicId) {
      await telegram.sendMessage({ chatId: message.chat.id, text: "Run /artifacts_here inside a Telegram forum topic." })
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
      text: [
        "Artifacts topic configured.",
        "This is now the only agent artifact target; any previous artifacts topic was forgotten.",
        "Web/session mirroring is disabled for this topic.",
        `Target: <code>${escapeHtml(String(target.chatId))}</code> / <code>${escapeHtml(String(target.topicId))}</code>`,
        "",
        formatArtifactUploadHelp({
          defaultServerId: config.artifactUploads?.defaultServerId,
          availableServerIds: Array.from(opencode.servers.keys()).sort(),
        }),
      ].join("\n"),
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
      "🧭 <b>Session</b>",
      "",
      "💬 <b>Telegram</b>",
      `chat_id: <code>${escapeHtml(String(message.chat.id))}</code>`,
      `topic_id: <code>${escapeHtml(String(currentTopicId || 0))}</code>`,
      `message_id: <code>${escapeHtml(String(message.message_id))}</code>`,
      "",
    ]
    if (pending) {
      lines.push(
        "🔗 <b>Binding</b>",
        "status: 🟡 waiting for first prompt",
        `server: <code>${escapeHtml(pending.serverID || "")}</code>`,
        pending.chatTemplateName ? `profile: <code>${escapeHtml(pending.chatTemplateName)}</code>` : "profile: server default",
        previousBinding?.sessionID
          ? `previous session: <code>${escapeHtml(previousBinding.sessionID)}</code> (preserved in OpenCodez)`
          : null,
        pending.title ? `title: <code>${escapeHtml(pending.title)}</code>` : null,
        "",
      )
    } else if (storedBinding) {
      lines.push(
        "🔗 <b>Binding</b>",
        `status: ${activeBinding ? "🟢 active" : "⚪ disabled"}`,
        `server: <code>${escapeHtml(storedBinding.serverID || "")}</code>`,
        `session: <code>${escapeHtml(storedBinding.sessionID || "")}</code>`,
        storedBinding.disabledReason ? `reason: <code>${escapeHtml(storedBinding.disabledReason)}</code>` : null,
        storedBinding.title ? `title: <code>${escapeHtml(storedBinding.title)}</code>` : null,
        "",
      )
    } else {
      lines.push("🔗 <b>Binding</b>", "status: ⚪ no OpenCodez session bound", "")
    }
    if (storedBinding) {
      const directory = session?.directory || storedBinding.directory
      lines.push(
        "🖥 <b>OpenCodez</b>",
        server?.url ? `server_url: <code>${escapeHtml(server.url)}</code>` : "server_url: unavailable",
        directory ? `directory: <code>${escapeHtml(directory)}</code>` : null,
        session?.agent || storedBinding.agent ? `agent: <code>${escapeHtml(session?.agent || storedBinding.agent)}</code>` : null,
        modelLine(session?.model || storedBinding.model),
        sessionUrl ? `url: <code>${escapeHtml(sessionUrl)}</code>` : "url: unavailable",
        sessionError ? `lookup_error: <code>${escapeHtml(sessionError)}</code>` : null,
        "",
      )
    }
    lines.push(
      "📦 <b>Artifacts</b>",
      `this_topic: ${thisIsArtifactsTopic ? "🟢 yes" : "⚪ no"}`,
      artifactsTopic ? `current_topic_id: <code>${escapeHtml(String(artifactsTopic.topicId || 0))}</code>` : "current_topic_id: none",
      artifactsTopic?.title ? `current_title: <code>${escapeHtml(artifactsTopic.title)}</code>` : null,
      "",
      "🎙 <b>Sounds</b>",
      `this_topic: ${thisIsSoundsTopic ? "🟢 yes" : "⚪ no"}`,
      soundsTopic ? `current_topic_id: <code>${escapeHtml(String(soundsTopic.topicId || 0))}</code>` : "current_topic_id: none",
      soundsTopic?.title ? `current_title: <code>${escapeHtml(soundsTopic.title)}</code>` : null,
    )
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: currentTopicId,
      text: lines.filter(Boolean).join("\n"),
      replyMarkup: sessionUrl ? { inline_keyboard: [[{ text: "Open session", url: sessionUrl }]] } : undefined,
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
    return [
      "<b>OpenCodez Bot</b>",
      "",
      "<code>/new [server] [profile] [dir:&lt;path&gt;] [title]</code> - create a topic and wait for the first prompt.",
      "<code>/reset [profile] [server]</code> - preserve the old session and start fresh here, optionally changing profile and/or server.",
      "<code>/session</code> - show current topic, binding, session URL, and special topic status.",
      "<code>/q &lt;prompt&gt;</code> - queue a prompt for this topic/session.",
      "<code>/q status</code> - show queued prompts.",
      "<code>/q delete &lt;number&gt;</code> - remove a queued prompt.",
      "<code>/kill</code> - stop the current run and clear queued prompts.",
      "<code>/compact</code> - compact this topic’s OpenCodez context; prompts sent while it runs are queued.",
      `<code>/context [N]</code> - send the latest 1–${MAX_CONTEXT_TURNS} completed or interrupted turns as collapsed copyable context.`,
      `<code>/set_context N</code> - set your personal /context default from 1–${MAX_CONTEXT_TURNS}.`,
      "<code>/artifacts_here</code> - make this topic the artifact target and file dropbox.",
      "Drop files there with an optional server id caption; no caption uses the default server.",
      "When speech is enabled, voice messages in ordinary topics become copyable transcript replies; send the transcript as text to use it as a prompt.",
      "<code>/sounds_here</code> - use this topic as the dedicated voice/audio inbox with the model menu.",
      "<code>/sounds_off</code> / <code>/sounds_status</code> - manage the dedicated inbox and show speech status.",
      "<code>/notify_on</code> / <code>/notify_off</code> - toggle final-answer DMs for configured recipients.",
      "<code>/notify_status</code> - show configured final-answer DM status.",
      "<code>/debug_on</code> / <code>/debug_off</code> - toggle global final-DM run diagnostics.",
      "<code>/debug_status</code> - show global diagnostics status.",
      "<code>/mode [full|economy]</code> - show or set the global mirror mode.",
      "<code>/mirror_on</code> / <code>/mirror_off</code> - toggle web-to-Telegram mirroring.",
      "",
      `Profiles: <code>${escapeHtml(profiles)}</code>`,
      "Files: send files/photos with a caption, or send files first and prompt text next.",
    ].join("\n")
  }

  async function sendQueueStatus(message, binding) {
    const items = promptQueue.status(binding)
    if (!items.length) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Queue is empty." })
      return
    }
    const lines = items.map((item) => `${item.index}. <code>${escapeHtml(item.summary)}</code>`)
    await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: `Queued prompts:\n${lines.join("\n")}` })
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
  return value ? `model: <code>${escapeHtml(value)}</code>` : null
}

function turnLabel(count) {
  return count === 1 ? "turn" : "turns"
}

function contextExportErrorText(error, count) {
  if (error.code !== "CONTEXT_TOO_LARGE") {
    return "❌ <b>Could not send the collapsed context.</b>\nNo plain-text fallback was posted. Try again or request fewer turns."
  }
  if (count === 1) return "⚠️ <b>The latest context turn alone exceeds the safe export limit.</b>"
  return `⚠️ <b>Context is too large for a safe collapsed export.</b>\nTry <code>/context ${count - 1}</code>.`
}
