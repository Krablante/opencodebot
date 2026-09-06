import { setTimeout as sleep } from "node:timers/promises"
import { logErrorEvent, logInfo } from "./logger.mjs"
import { isAllowedMessage, messageText, topicId } from "./telegram.mjs"
import { formatArtifactUploadHelp } from "./artifact-uploads.mjs"
import { normalizeTelegramRichMessage } from "./telegram-rich-message.mjs"
import { t } from "./i18n/index.mjs"
import { TelegramInbox } from "./telegram-inbox.mjs"

export function createTelegramPolling({
  config,
  commands,
  state,
  telegram,
  commandHandlers,
  handleSpeechMessage,
  handleVoiceMessage,
  questionManager,
  handleTopicLifecycleMessage,
  handleAttachmentMessage,
  handleArtifactUploadMessage,
  extractTelegramFiles,
  hasPendingAttachmentBatch,
  queueTelegramPrompt,
  flushAttachmentText,
  promptContext,
  multipartPromptKey,
  flushPromptKey,
  logError,
  maxPendingUpdates = 1000,
  maxPendingBytes = 16 * 1024 * 1024,
  maxConcurrentUpdatesPerGroup = 2,
  slowUpdateMs = 5_000,
}) {
  async function syncCommandMenu() {
    const menuCommands = typeof commands === "function" ? commands() : commands
    const scopes = telegramCommandScopes()
    for (const scope of scopes) {
      try {
        await telegram.setMyCommands(menuCommands, scope ? { scope } : {})
      } catch (error) {
        logErrorEvent("telegram.commands.sync_failed", error, { scope: JSON.stringify(scope) })
      }
    }
    logInfo("telegram.commands.synced", { count: menuCommands.length, scopes: scopes.map((scope) => scope?.type || "default") })
  }

  function telegramCommandScopes() {
    const scopes = [null, { type: "all_private_chats" }, { type: "all_group_chats" }, { type: "all_chat_administrators" }]
    const chatId = state.chatId || config.telegram.chatId
    if (chatId) {
      scopes.push({ type: "chat", chat_id: chatId }, { type: "chat_administrators", chat_id: chatId })
      for (const userID of config.telegram.allowedUserIds || []) scopes.push({ type: "chat_member", chat_id: chatId, user_id: userID })
    }
    return scopes
  }

  async function poll({ shouldStop, signal, onProgress = () => {} }) {
    const inbox = new TelegramInbox(config.paths.statePath, state.data.runtime.telegramUpdateOffset)
    await inbox.open()
    const failure = new AbortController()
    const pollSignal = signal ? AbortSignal.any([signal, failure.signal]) : failure.signal
    let fatalError
    const reportProgress = () => onProgress({
      pending: inbox.pending.size,
      bytes: inbox.pendingBytes,
      backpressure: inbox.pending.size >= maxPendingUpdates || inbox.pendingBytes >= maxPendingBytes,
    })
    const dispatcher = createUpdateDispatcher({
      state,
      config,
      handleUpdate,
      inbox,
      logError,
      maxPendingUpdates,
      maxPendingBytes,
      maxConcurrentUpdatesPerGroup,
      slowUpdateMs,
      signal: pollSignal,
      onFatal: (error) => {
        fatalError = error
        failure.abort()
      },
    })
    logInfo("telegram.inbox.opened", { pending: inbox.pending.size, bytes: inbox.pendingBytes })
    for (const { update } of inbox.pending.values()) dispatcher.enqueue(update)
    let failed = false
    try {
      while (!shouldStop() && !pollSignal.aborted) {
        await dispatcher.waitForCapacity(reportProgress)
        if (shouldStop() || pollSignal.aborted) break
        let updates
        try {
          updates = await telegram.getUpdates(inbox.offset, 25, {
            signal: pollSignal,
            limit: Math.min(100, maxPendingUpdates - inbox.pending.size),
          })
        } catch (error) {
          if (shouldStop() || pollSignal.aborted) break
          logError(error)
          await delay(2500, pollSignal)
          continue
        }
        reportProgress()
        if (!updates.length) continue
        // Only a synced receipt authorizes the next Telegram acknowledgement.
        // Handler completion is independent of fetching subsequent batches.
        const fresh = await inbox.receive(updates, updates.at(-1).update_id + 1)
        for (const update of fresh) dispatcher.enqueue(update)
      }
      if (fatalError) throw fatalError
    } catch (error) {
      failed = true
      throw error
    } finally {
      failure.abort()
      // A fatal disk error must reach main immediately so it also cancels the
      // shared API clients and starts the bounded shutdown grace.
      if (!failed) await dispatcher.drain()
    }
  }

  async function handleUpdate(update) {
    try {
      if (update.callback_query) await handleCallbackQuery(update.callback_query)
      if (update.message) await handleTelegramMessage(update.message)
    } catch (error) {
      const message = update.message || update.callback_query?.message
      const actor = update.callback_query?.from || message?.from
      const chatId = state.chatId || config.telegram.chatId
      if (!error.feedbackReported && message && isAllowedMessage({ from: actor }, config)
        && String(chatId) === String(message.chat?.id)) {
        await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("polling.actionFailed") })
          .then(() => { error.feedbackReported = true }, () => {})
      }
      throw error
    }
  }

  async function handleCallbackQuery(query) {
    const message = query.message || {}
    const configuredChatId = state.chatId || config.telegram.chatId
    if (configuredChatId && String(configuredChatId) !== String(message.chat?.id)) return
    if (!isAllowedMessage({ from: query.from }, config)) {
      await telegram.answerCallbackQuery({ callbackQueryId: query.id, text: t("polling.notAllowed"), showAlert: true }).catch(() => {})
      return
    }
    if (await commandHandlers.handleCallback?.(query)) return
    await telegram.answerCallbackQuery({ callbackQueryId: query.id, text: t("polling.unknownAction"), showAlert: true }).catch(() => {})
  }

  async function handleTelegramMessage(message) {
    await cleanupOwnPinServiceMessage(message)
    const configuredChatId = state.chatId || config.telegram.chatId
    if (configuredChatId && String(configuredChatId) !== String(message.chat.id)) return
    if (configuredChatId && (await handleTopicLifecycleMessage(message))) return
    if (!isAllowedMessage(message, config)) return
    const richContent = normalizeTelegramRichMessage(message.rich_message)
    const text = String(messageText(message, richContent)).trim()
    const caption = String(message.caption || richContent.text || "").trim()
    const files = extractTelegramFiles(message, richContent)
    if (message.rich_message) {
      logInfo("telegram.rich_message.received", {
        blockTypes: richContent.blockTypes,
        files: files.length,
        textChars: richContent.text.length,
        unsupportedTypes: richContent.unsupportedTypes,
      })
    }

    if (!configuredChatId && config.telegram.allowChatBootstrap) {
      await state.setChatId(message.chat.id)
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("polling.chatConnected") })
    }

    const artifactsTopic = state.isArtifactsTopic(message.chat.id, topicId(message))
    // Artifact topics keep file-upload semantics; elsewhere voice notes are transcript-only drafts.
    if (!artifactsTopic && message.voice && (await handleVoiceMessage?.(message))) return

    if (await commandHandlers.handleMessage?.(message)) return
    if (await questionManager?.handleReplyMessage?.(message)) return

    const promptKey = multipartPromptKey(message)
    if (artifactsTopic) {
      if (files.length) {
        await handleArtifactUploadMessage({ message, files })
        return
      }
      if (text) {
        const command = parseCommand(text)
        if (artifactTopicCommandAllowed(command.name) && await commandHandlers.handle(message, command, promptKey)) return
        if (text.startsWith("/")) {
          await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("polling.artifactsReserved") })
          return
        }
      }
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: formatArtifactUploadHelp({
          defaultServerId: config.artifactUploads?.defaultServerId,
          availableServerIds: (config.opencode?.servers || []).map((server) => server.id).sort(),
        }),
      })
      return
    }
    if (state.isSoundsTopic(message.chat.id, topicId(message))) {
      if (text) {
        const command = parseCommand(text)
        if (soundsTopicCommandAllowed(command.name) && await commandHandlers.handle(message, command, promptKey)) return
        if (text.startsWith("/")) {
          await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("polling.soundsReserved") })
          return
        }
      }
      if (await handleSpeechMessage?.(message)) return
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: t("polling.soundsHelp"),
      })
      return
    }
    if (files.length) {
      await handleAttachmentMessage(message, promptKey, files, caption)
      return
    }
    if (!text) {
      if (message.rich_message) {
        await telegram.sendMessage({
          chatId: message.chat.id,
          topicId: topicId(message),
          text: t("polling.richUnreadable"),
        })
      }
      return
    }
    if (hasPendingAttachmentBatch(promptKey) && !text.startsWith("/")) {
      await flushAttachmentText(message, promptKey, text)
      return
    }

    const command = parseCommand(text)

    if (await commandHandlers.handle(message, command, promptKey)) return
    if (text.startsWith("/")) {
      await flushPromptKey(promptKey)
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: t("polling.unknownCommand") })
      return
    }

    const context = promptContext(message)
    if (context) {
      await queueTelegramPrompt(promptKey, text, context)
      return
    }
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: t("polling.topicNotBound"),
    })
  }

  async function cleanupOwnPinServiceMessage(message) {
    if (config.mirror.deletePinServiceMessages === false) return
    const configuredChatId = state.chatId || config.telegram.chatId
    if (!message?.pinned_message || String(message.chat?.id) !== String(configuredChatId)) return
    try {
      await telegram.deleteMessage({ chatId: message.chat.id, messageId: message.message_id })
      logInfo("telegram.pin_service_message.deleted", {
        chatId: message.chat.id,
        topicId: topicId(message),
        messageId: message.message_id,
        pinnedMessageId: message.pinned_message.message_id,
      })
    } catch (error) {
      console.warn(`[opencodebot] failed to delete pin service message: ${error.message}`)
    }
  }

  return { poll, syncCommandMenu }
}

function createUpdateDispatcher({
  state,
  config,
  handleUpdate,
  inbox,
  logError,
  maxPendingUpdates,
  maxPendingBytes,
  maxConcurrentUpdatesPerGroup,
  slowUpdateMs,
  signal,
  onFatal,
}) {
  const lanes = new Map()
  const scheduled = new Set()
  const capacityWaiters = new Set()
  const semaphore = createKeyedSemaphore(maxConcurrentUpdatesPerGroup)

  async function waitForCapacity(onProgress) {
    let paused = false
    while (!signal.aborted && (inbox.pending.size >= maxPendingUpdates || inbox.pendingBytes >= maxPendingBytes)) {
      if (!paused) logInfo("telegram.inbox.backpressure", { pending: inbox.pending.size, bytes: inbox.pendingBytes })
      paused = true
      await new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          capacityWaiters.delete(wake)
          signal.removeEventListener("abort", wake)
          resolve()
        }
        const timer = setTimeout(wake, 25_000)
        capacityWaiters.add(wake)
        signal.addEventListener("abort", wake, { once: true })
      })
      onProgress()
    }
    if (paused) logInfo("telegram.inbox.resumed", { pending: inbox.pending.size, bytes: inbox.pendingBytes })
  }

  function enqueue(update) {
    if (signal.aborted || scheduled.has(update.update_id)) return
    scheduled.add(update.update_id)
    const routing = updateRouting(update, state, config)
    const previous = lanes.get(routing.lane) || Promise.resolve()
    // Chat bootstrap can set state.chatId before its handler finishes. Later
    // batches must not switch to normal lanes and overtake that startup work.
    const ready = routing.lane !== "bootstrap" && lanes.has("bootstrap")
      ? Promise.all([previous, lanes.get("bootstrap")]) : previous
    const task = ready.then(async () => {
      let attempt = 0
      while (!signal.aborted) {
        // Resolve the backend again: /new and /reset may have changed it while
        // this update was waiting behind the preceding topic action.
        const { group } = updateRouting(update, state, config)
        const release = await semaphore.acquire(group)
        const startedAt = Date.now()
        let completed = false
        try {
          if (signal.aborted) return
          await handleUpdate(update)
          completed = true
        } catch (error) {
          if (!signal.aborted) logError(error)
          completed = error.feedbackReported === true
        } finally {
          release()
          const durationMs = Date.now() - startedAt
          if (durationMs >= slowUpdateMs) {
            logInfo("telegram.update.slow", { updateId: update.update_id, lane: routing.lane, group, durationMs })
          }
        }
        if (signal.aborted) return
        if (completed) {
          await inbox.complete(update.update_id)
          return
        }
        const retryMs = Math.min(30_000, 2500 * 2 ** Math.min(attempt++, 4))
        logInfo("telegram.update.retry", { updateId: update.update_id, attempt, retryMs })
        // Keep order in this topic, but release the backend slot during backoff.
        await delay(retryMs, signal)
      }
    })
    const settled = task.catch(onFatal).finally(() => {
      scheduled.delete(update.update_id)
      for (const wake of capacityWaiters) wake()
      if (lanes.get(routing.lane) === settled) lanes.delete(routing.lane)
    })
    lanes.set(routing.lane, settled)
  }

  async function drain() {
    await Promise.all([...lanes.values()])
    await inbox.writes
  }

  return { enqueue, waitForCapacity, drain }
}

function updateRouting(update, state, config) {
  const message = update.message || update.callback_query?.message || {}
  const chatId = message.chat?.id ?? update.callback_query?.from?.id ?? "unknown"
  const currentTopicId = topicId(message)
  const bootstrapPending = !state.chatId && !config.telegram.chatId && config.telegram.allowChatBootstrap
  const lane = bootstrapPending ? "bootstrap" : `${chatId}:${currentTopicId}`
  const binding = state.findBindingByTopic?.(chatId, currentTopicId)
  const pending = state.pendingTopic?.(currentTopicId)
  const artifacts = state.isArtifactsTopic?.(chatId, currentTopicId)
  const sounds = state.isSoundsTopic?.(chatId, currentTopicId)
  const media = message.document || message.photo || message.video || message.animation || message.audio
    || message.voice || message.video_note || message.rich_message
  // Slow transcription/dropbox work must not occupy the control-menu slots.
  const serverID = binding?.serverID || pending?.serverID
  let group = serverID ? `backend:${serverID}` : "telegram"
  if (artifacts && media) group = "uploads"
  else if (message.voice || (sounds && media)) group = "speech"
  return {
    lane,
    group,
  }
}

function createKeyedSemaphore(limit) {
  const groups = new Map()

  async function acquire(key) {
    let group = groups.get(key)
    if (!group) {
      group = { active: 0, waiters: [] }
      groups.set(key, group)
    }
    if (group.active < limit) {
      group.active += 1
    } else {
      await new Promise((resolve) => group.waiters.push(resolve))
    }
    return () => release(key, group)
  }

  function release(key, group) {
    const next = group.waiters.shift()
    if (next) {
      next()
      return
    }
    group.active -= 1
    if (!group.active) groups.delete(key)
  }

  return { acquire }
}

export function parseCommand(text) {
  const match = text.match(/^\/([^\s@]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/u)
  if (!match) return { name: "", args: "" }
  return { name: match[1], args: match[2] || "" }
}

function artifactTopicCommandAllowed(commandName) {
  return ["artifacts_here", "session", "update", "lang", "help", "start", "menu", "notify_on", "notify_off", "notify_status"].includes(commandName)
}

function soundsTopicCommandAllowed(commandName) {
  return ["sounds_here", "sounds_off", "sounds_status", "session", "update", "lang", "help", "start", "menu", "notify_on", "notify_off", "notify_status"].includes(commandName)
}

async function delay(ms, signal) {
  try { await sleep(ms, undefined, { signal }) } catch (error) {
    if (error.name !== "AbortError") throw error
  }
}
