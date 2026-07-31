import { logErrorEvent, logInfo } from "./logger.mjs"
import { isAllowedMessage, messageText, topicId } from "./telegram.mjs"
import { formatArtifactUploadHelp } from "./artifact-uploads.mjs"
import { normalizeTelegramRichMessage } from "./telegram-rich-message.mjs"
import { t } from "./i18n/index.mjs"

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
  maxPendingUpdates = 100,
  maxUncommittedUpdates = 1_000,
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

  async function poll({ shouldStop }) {
    let offset = state.data.runtime.telegramUpdateOffset || undefined
    const dispatcher = createUpdateDispatcher({
      state,
      config,
      handleUpdate,
      persistOffset,
      logError,
      maxPendingUpdates,
      maxUncommittedUpdates,
      maxConcurrentUpdatesPerGroup,
      slowUpdateMs,
    })
    while (!shouldStop()) {
      try {
        const updates = await telegram.getUpdates(offset, 25)
        for (const update of updates) {
          await dispatcher.waitForCapacity()
          offset = update.update_id + 1
          dispatcher.enqueue(update, offset)
        }
      } catch (error) {
        if (shouldStop()) break
        logError(error)
        await delay(2500)
      }
    }
  }

  async function handleUpdate(update) {
    if (update.callback_query) await handleCallbackQuery(update.callback_query)
    if (update.message) await handleTelegramMessage(update.message)
  }

  async function persistOffset(offset) {
    await state.update((data) => {
      if (data.runtime.telegramUpdateOffset === offset) return false
      data.runtime.telegramUpdateOffset = offset
      return true
    })
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
  persistOffset,
  logError,
  maxPendingUpdates,
  maxUncommittedUpdates,
  maxConcurrentUpdatesPerGroup,
  slowUpdateMs,
}) {
  const acknowledgements = []
  const lanes = new Map()
  const capacityWaiters = []
  const semaphore = createKeyedSemaphore(maxConcurrentUpdatesPerGroup)
  let persistRunning = false
  let unfinishedUpdates = 0

  async function waitForCapacity() {
    while (unfinishedUpdates >= maxPendingUpdates || acknowledgements.length >= maxUncommittedUpdates) {
      await new Promise((resolve) => capacityWaiters.push(resolve))
    }
  }

  function enqueue(update, offset) {
    const routing = updateRouting(update, state, config)
    const acknowledgement = { offset, done: false }
    acknowledgements.push(acknowledgement)
    unfinishedUpdates += 1

    const previous = lanes.get(routing.lane) || Promise.resolve()
    const task = previous.then(async () => {
      const release = await semaphore.acquire(routing.group)
      const startedAt = Date.now()
      try {
        await handleUpdate(update)
      } catch (error) {
        logError(error)
      } finally {
        release()
        const durationMs = Date.now() - startedAt
        if (durationMs >= slowUpdateMs) {
          logInfo("telegram.update.slow", {
            updateId: update.update_id,
            lane: routing.lane,
            group: routing.group,
            durationMs,
          })
        }
      }
    })
    const settled = task.catch(logError).finally(() => {
      acknowledgement.done = true
      unfinishedUpdates -= 1
      while (capacityWaiters.length) capacityWaiters.shift()()
      if (lanes.get(routing.lane) === settled) lanes.delete(routing.lane)
      void persistCompletedPrefix()
    })
    lanes.set(routing.lane, settled)
  }

  async function persistCompletedPrefix() {
    if (persistRunning) return
    persistRunning = true
    try {
      while (true) {
        let completed = 0
        let offset
        while (acknowledgements[completed]?.done) {
          offset = acknowledgements[completed].offset
          completed += 1
        }
        if (!completed) return
        try {
          await persistOffset(offset)
        } catch (error) {
          logError(error)
          await delay(2500)
          continue
        }
        acknowledgements.splice(0, completed)
        while (capacityWaiters.length) capacityWaiters.shift()()
      }
    } finally {
      persistRunning = false
      if (acknowledgements[0]?.done) void persistCompletedPrefix()
    }
  }

  return { enqueue, waitForCapacity }
}

function updateRouting(update, state, config) {
  const message = update.message || update.callback_query?.message || {}
  const chatId = message.chat?.id ?? update.callback_query?.from?.id ?? "unknown"
  const currentTopicId = topicId(message)
  const bootstrapPending = !state.chatId && !config.telegram.chatId && config.telegram.allowChatBootstrap
  const lane = bootstrapPending ? "bootstrap" : `${chatId}:${currentTopicId}`
  const binding = state.findBindingByTopic?.(chatId, currentTopicId)
  const pending = state.pendingTopic?.(currentTopicId)
  return {
    lane,
    group: binding?.serverID || pending?.serverID || "telegram",
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
