import { logInfo } from "./logger.mjs"
import { isIgnoredSession, isInternalSession } from "./internal-sessions.mjs"
import { titleFromText } from "./opencode.mjs"
import { runSingleFlight } from "./single-flight.mjs"
import { escapeHtml, topicId } from "./telegram.mjs"
import { parseNewTopicArgs } from "./prompt-profiles.mjs"
import { t } from "./i18n/index.mjs"
import { baseTitleFromTelegramTitle, managedTopicTitle, topicBaseTitle } from "./topic-titles.mjs"

export function createTopicLifecycle({ config, state, telegram, opencode, settings, activateBindingForPrompt, clearPromptFeedback }) {
  const topicCreations = new Map()

  async function createPendingTopic(message, args) {
    let parsed
    try {
      parsed = typeof args === "object" ? args : parseNewTopicArgs(args, {
        servers: opencode.servers, defaultServerID: config.defaultPrompt.serverID, promptProfiles: config.promptProfiles,
      })
      if (!parsed.promptProfileName && config.defaultPrompt.profileName) {
        parsed.promptProfileName = config.defaultPrompt.profileName
        parsed.promptProfile = structuredClone(config.promptProfiles[parsed.promptProfileName])
      }
    } catch (error) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: message.message_thread_id, text: escapeHtml(error.message) })
      return
    }
    const { serverID, title, titleSource, promptProfileName, promptProfile, directory: requestedDirectory } = parsed
    const launchRequestKey = parsed.requestKey || (message.message_id ? `command:${message.chat.id}:${message.message_id}` : null)
    if (launchRequestKey) {
      const prior = [...Object.values(state.data.pendingTopics || {}), ...(state.data.bindings || [])].find((topic) => topic.launchRequestKey === launchRequestKey)
      if (prior?.topicId) return { message_thread_id: prior.topicId }
    }
    const directory = requestedDirectory || opencode.defaultNewSessionDirectory(serverID)
    const chatId = state.chatId || message.chat.id
    const topicIcon = await randomTopicIcon()
    const titleFields = managedTopicTitle(title, serverID, opencode.servers)
    const topic = await telegram.createForumTopic({ chatId, name: titleFields.topicTitle, iconCustomEmojiId: topicIcon?.customEmojiId })
    await state.addPendingTopic(topic.message_thread_id, { chatId, topicId: topic.message_thread_id, serverID, launchRequestKey, ...titleFields, topicIconCustomEmojiId: topic.icon_custom_emoji_id || topicIcon?.customEmojiId, topicIconEmoji: topicIcon?.emoji, title: titleFields.topicBaseTitle, titleSource, promptProfileName, promptProfile, directory })
    await settings?.used(promptProfileName)
    const suffix = promptProfileName ? t("topic.profileSuffix", { profileHtml: escapeHtml(promptProfileName) }) : ""
    const directoryLine = directory ? t("topic.directoryLine", { directoryHtml: escapeHtml(directory) }) : ""
    await telegram.sendMessage({ chatId, topicId: topic.message_thread_id,
      text: `${t("topic.created", { serverHtml: escapeHtml(serverID), suffix, directoryLine })}${promptProfile?.model?.modelID ? `\n🤖 <code>${escapeHtml(promptProfile.model.modelID)}</code> · ${escapeHtml(promptProfile.model.variant || "default")}` : ""}`,
    })
    return topic
  }

  async function handleTopicLifecycleMessage(message) {
    if (message.forum_topic_edited) {
      const metadata = { title: message.forum_topic_edited.name }
      const binding = state.findBindingByTopic(message.chat.id, topicId(message))
      const pending = binding ? null : state.pendingTopic(topicId(message))
      const record = state.topicRecord(message.chat.id, topicId(message)) || binding || pending
      if (record && metadata.title) {
        const expectedTitle = managedTopicTitle(topicBaseTitle(record), record.serverID, opencode.servers).topicTitle
        const userEdited = message.from?.is_bot !== true && metadata.title !== expectedTitle
        const baseTitle = userEdited
          ? baseTitleFromTelegramTitle(metadata.title, record.serverID, opencode.servers)
          : topicBaseTitle(record)
        const titleFields = managedTopicTitle(baseTitle, record.serverID, opencode.servers)
        metadata.title = titleFields.topicBaseTitle
        Object.assign(metadata, titleFields)
        if (userEdited) metadata.titleSource = "user"
        if (titleFields.topicTitle !== message.forum_topic_edited.name) {
          try {
            await telegram.editForumTopic({ chatId: message.chat.id, topicId: topicId(message), name: titleFields.topicTitle })
          } catch (error) {
            console.warn(`[opencodebot] managed topic suffix restore failed for ${record.serverID}/${record.sessionID || `pending:${topicId(message)}`}: ${error.message}`)
            metadata.topicTitle = message.forum_topic_edited.name
            metadata.topicServerSuffixManaged = false
          }
        }
      }
      if (Object.hasOwn(message.forum_topic_edited, "icon_custom_emoji_id")) {
        const topicIcon = await topicIconForId(message.forum_topic_edited.icon_custom_emoji_id)
        metadata.topicIconCustomEmojiId = topicIcon?.customEmojiId || message.forum_topic_edited.icon_custom_emoji_id
        metadata.topicIconEmoji = topicIcon?.emoji
      }
      if (binding || pending) await state.updateTopicMetadata(message.chat.id, topicId(message), metadata)
      return true
    }
    if (message.forum_topic_deleted) {
      await disableTopicMirror(message.chat.id, topicId(message), "Telegram topic deleted")
      return true
    }
    if (message.forum_topic_closed) {
      await disableTopicMirror(message.chat.id, topicId(message), "Telegram topic closed")
      return true
    }
    return false
  }

  async function disableTopicMirror(chatId, targetTopicId, reason) {
    const binding = state.findBindingByTopic(chatId, targetTopicId)
    if (binding) {
      await state.disableBinding(binding.serverID, binding.sessionID, reason)
      await clearPromptFeedback(binding, { force: true })
      logInfo("telegram.topic.disabled_binding", { chatId, topicId: targetTopicId, serverID: binding.serverID, sessionID: binding.sessionID, reason })
    }
    if (state.pendingTopic(targetTopicId)) {
      await state.removePendingTopic(targetTopicId)
      logInfo("telegram.topic.removed_pending", { chatId, topicId: targetTopicId, reason })
    }
    return Boolean(binding)
  }

  function createTopicForWebSession(serverID, sessionID, promptText) {
    return runTopicCreation(serverID, sessionID, () => createTopicForWebSessionNow(serverID, sessionID, promptText))
  }

  async function createTopicForWebSessionNow(serverID, sessionID, promptText) {
    const session = await opencode.getSession(serverID, sessionID).catch(() => null)
    if (!session) return null
    if (isInternalSession(session)) {
      if (!isIgnoredSession(session)) await state.markSeenSession(serverID, sessionID)
      return null
    }
    return createTopicForSessionNow(serverID, session, promptText)
  }

  function createTopicForSession(serverID, session, fallbackText = "") {
    return runTopicCreation(serverID, session.id, () => createTopicForSessionNow(serverID, session, fallbackText))
  }

  async function createTopicForSessionNow(serverID, session, fallbackText = "") {
    if (isInternalSession(session)) {
      if (!isIgnoredSession(session)) await state.markSeenSession(serverID, session.id)
      return null
    }
    const chatId = state.chatId || config.telegram.chatId
    if (!chatId) return null
    const title = session.title || titleFromText(fallbackText, `${serverID} ${session.id}`)
    const titleFields = managedTopicTitle(title, serverID, opencode.servers)
    const topicIcon = await randomTopicIcon()
    const topic = await telegram.createForumTopic({ chatId, name: titleFields.topicTitle, iconCustomEmojiId: topicIcon?.customEmojiId })
    const binding = {
      chatId,
      topicId: topic.message_thread_id,
      ...titleFields,
      topicIconCustomEmojiId: topic.icon_custom_emoji_id || topicIcon?.customEmojiId,
      topicIconEmoji: topicIcon?.emoji,
      serverID,
      sessionID: session.id,
      directory: session.directory,
      title: titleFields.topicBaseTitle,
      titleSource: session.title ? "opencode" : "auto",
    }
    await state.bindTopic(binding)
    await state.markSeenSession(serverID, session.id)
    await activateBindingForPrompt(binding, "web-topic-created")
    return binding
  }

  function runTopicCreation(serverID, sessionID, task) {
    return runSingleFlight(
      topicCreations,
      bindingKey(serverID, sessionID),
      () => state.findBinding(serverID, sessionID) || task(),
    )
  }

  async function randomTopicIcon() {
    if (!config.telegram.randomTopicIcon) return undefined
    try {
      const stickers = await telegram.getForumTopicIconStickers()
      const icons = stickers.map((sticker) => ({ customEmojiId: sticker.custom_emoji_id, emoji: sticker.emoji })).filter((icon) => icon.customEmojiId)
      if (!icons.length) return undefined
      return icons[Math.floor(Math.random() * icons.length)]
    } catch (error) {
      console.warn(`[opencodebot] random topic icon unavailable: ${error.message}`)
      return undefined
    }
  }

  async function topicIconForId(customEmojiId) {
    const id = String(customEmojiId || "").trim()
    if (!id) return undefined
    try {
      const stickers = await telegram.getForumTopicIconStickers()
      const sticker = stickers.find((item) => String(item.custom_emoji_id) === id)
      return { customEmojiId: id, emoji: sticker?.emoji }
    } catch (error) {
      console.warn(`[opencodebot] topic icon lookup unavailable: ${error.message}`)
      return { customEmojiId: id }
    }
  }

  return {
    createPendingTopic,
    createTopicForSession,
    createTopicForWebSession,
    handleTopicLifecycleMessage,
    isInternalSession,
    randomTopicIcon,
  }
}

function bindingKey(serverID, sessionID) {
  return `${serverID}:${sessionID}`
}
