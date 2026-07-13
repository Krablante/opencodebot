import { logErrorEvent, logInfo } from "./logger.mjs"
import { isAllowedMessage, topicId } from "./telegram.mjs"

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
}) {
  async function syncCommandMenu() {
    const scopes = telegramCommandScopes()
    for (const scope of scopes) {
      try {
        await telegram.setMyCommands(commands, scope ? { scope } : {})
      } catch (error) {
        logErrorEvent("telegram.commands.sync_failed", error, { scope: JSON.stringify(scope) })
      }
    }
    logInfo("telegram.commands.synced", { count: commands.length, scopes: scopes.map((scope) => scope?.type || "default") })
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
    while (!shouldStop()) {
      try {
        const updates = await telegram.getUpdates(offset, 25)
        for (const update of updates) {
          try {
            if (update.callback_query) await handleCallbackQuery(update.callback_query)
            if (update.message) await handleTelegramMessage(update.message)
          } catch (error) {
            logError(error)
          }
          offset = update.update_id + 1
          await state.update((data) => {
            data.runtime.telegramUpdateOffset = offset
          })
        }
      } catch (error) {
        if (shouldStop()) break
        logError(error)
        await delay(2500)
      }
    }
  }

  async function handleCallbackQuery(query) {
    const message = query.message || {}
    const configuredChatId = state.chatId || config.telegram.chatId
    if (configuredChatId && String(configuredChatId) !== String(message.chat?.id)) return
    if (!isAllowedMessage({ from: query.from }, config)) {
      await telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "Not allowed", showAlert: true }).catch(() => {})
      return
    }
    if (await commandHandlers.handleCallback?.(query)) return
    await telegram.answerCallbackQuery({ callbackQueryId: query.id, text: "Unknown action", showAlert: true }).catch(() => {})
  }

  async function handleTelegramMessage(message) {
    await cleanupOwnPinServiceMessage(message)
    const configuredChatId = state.chatId || config.telegram.chatId
    if (configuredChatId && String(configuredChatId) !== String(message.chat.id)) return
    if (configuredChatId && (await handleTopicLifecycleMessage(message))) return
    if (!isAllowedMessage(message, config)) return
    const text = String(message.text || "").trim()
    const caption = String(message.caption || "").trim()
    const files = extractTelegramFiles(message)

    if (!configuredChatId && config.telegram.allowChatBootstrap) {
      await state.setChatId(message.chat.id)
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "OpenCodez mirror chat connected." })
    }

    const artifactsTopic = state.isArtifactsTopic(message.chat.id, topicId(message))
    // Artifact topics keep file-upload semantics; elsewhere voice notes are transcript-only drafts.
    if (!artifactsTopic && message.voice && (await handleVoiceMessage?.(message))) return

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
          await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "This topic is reserved for artifacts and file dropbox uploads. Use another topic for OpenCodez sessions." })
          return
        }
      }
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: "This topic is reserved for artifacts and file dropbox uploads. Text here is not mirrored to OpenCodez.",
      })
      return
    }
    if (state.isSoundsTopic(message.chat.id, topicId(message))) {
      if (text) {
        const command = parseCommand(text)
        if (soundsTopicCommandAllowed(command.name) && await commandHandlers.handle(message, command, promptKey)) return
        if (text.startsWith("/")) {
          await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "This topic is reserved for voice transcription. Use another topic for OpenCodez sessions." })
          return
        }
      }
      if (await handleSpeechMessage?.(message)) return
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: "This topic is reserved for voice transcription. Send voice or audio messages here.",
      })
      return
    }
    if (files.length) {
      await handleAttachmentMessage(message, promptKey, files, caption)
      return
    }
    if (!text) return
    if (hasPendingAttachmentBatch(promptKey) && !text.startsWith("/")) {
      await flushAttachmentText(message, promptKey, text)
      return
    }

    const command = parseCommand(text)

    if (await commandHandlers.handle(message, command, promptKey)) return
    if (text.startsWith("/")) {
      await flushPromptKey(promptKey)
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Unknown command. Send /help for available commands." })
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
      text: "🔴 Topic is not bound\n🧭 Use /new, then send the prompt in the new topic",
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

function parseCommand(text) {
  const match = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/)
  if (!match) return { name: "", args: "" }
  return { name: match[1], args: match[2] || "" }
}

function artifactTopicCommandAllowed(commandName) {
  return ["artifacts_here", "session", "help", "start", "notify_on", "notify_off", "notify_status"].includes(commandName)
}

function soundsTopicCommandAllowed(commandName) {
  return ["sounds_here", "sounds_off", "sounds_status", "session", "help", "start", "notify_on", "notify_off", "notify_status"].includes(commandName)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
