import { logInfo } from "./logger.mjs"
import { titleFromText } from "./opencode.mjs"
import { topicId } from "./telegram.mjs"

export function createTopicLifecycle({ config, state, telegram, opencode, activateBindingForPrompt, clearPromptFeedback }) {
  async function handleTopicLifecycleMessage(message) {
    if (message.forum_topic_edited) {
      const metadata = { title: message.forum_topic_edited.name }
      if (Object.hasOwn(message.forum_topic_edited, "icon_custom_emoji_id")) {
        const topicIcon = await topicIconForId(message.forum_topic_edited.icon_custom_emoji_id)
        metadata.topicIconCustomEmojiId = topicIcon?.customEmojiId || message.forum_topic_edited.icon_custom_emoji_id
        metadata.topicIconEmoji = topicIcon?.emoji
      }
      await state.updateBindingTopicMetadata(message.chat.id, topicId(message), metadata)
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
      await clearPromptFeedback(binding)
      logInfo("telegram.topic.disabled_binding", { chatId, topicId: targetTopicId, serverID: binding.serverID, sessionID: binding.sessionID, reason })
    }
    if (state.pendingTopic(targetTopicId)) {
      await state.removePendingTopic(targetTopicId)
      logInfo("telegram.topic.removed_pending", { chatId, topicId: targetTopicId, reason })
    }
    return Boolean(binding)
  }

  async function createTopicForWebSession(serverID, sessionID, promptText) {
    const session = await opencode.getSession(serverID, sessionID).catch(() => null)
    if (session) {
      if (isInternalSession(session)) {
        await state.markSeenSession(serverID, sessionID)
        return null
      }
      return createTopicForSession(serverID, session, promptText)
    }
    const chatId = state.chatId || config.telegram.chatId
    if (!chatId) return null
    const title = titleFromText(promptText, `${serverID} ${sessionID}`)
    const topicIcon = await randomTopicIcon()
    const topic = await telegram.createForumTopic({ chatId, name: title, iconCustomEmojiId: topicIcon?.customEmojiId })
    const binding = { chatId, topicId: topic.message_thread_id, topicTitle: title, topicIconCustomEmojiId: topic.icon_custom_emoji_id || topicIcon?.customEmojiId, topicIconEmoji: topicIcon?.emoji, serverID, sessionID, title, titleSource: "auto" }
    await state.bindTopic(binding)
    await activateBindingForPrompt(binding, "web-topic-created")
    await state.markSeenSession(serverID, sessionID)
    return binding
  }

  async function createTopicForSession(serverID, session, fallbackText = "") {
    if (isInternalSession(session)) {
      await state.markSeenSession(serverID, session.id)
      return null
    }
    const chatId = state.chatId || config.telegram.chatId
    if (!chatId) return null
    const title = session.title || titleFromText(fallbackText, `${serverID} ${session.id}`)
    const topicIcon = await randomTopicIcon()
    const topic = await telegram.createForumTopic({ chatId, name: title, iconCustomEmojiId: topicIcon?.customEmojiId })
    const binding = {
      chatId,
      topicId: topic.message_thread_id,
      topicTitle: title,
      topicIconCustomEmojiId: topic.icon_custom_emoji_id || topicIcon?.customEmojiId,
      topicIconEmoji: topicIcon?.emoji,
      serverID,
      sessionID: session.id,
      title,
      titleSource: session.title ? "opencode" : "auto",
    }
    await state.bindTopic(binding)
    await activateBindingForPrompt(binding, "web-topic-created")
    await state.markSeenSession(serverID, session.id)
    return binding
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
    createTopicForSession,
    createTopicForWebSession,
    handleTopicLifecycleMessage,
    isInternalSession,
    randomTopicIcon,
  }
}

export function isInternalSession(session) {
  return Boolean(session?.parentID || /\(@.+ subagent\)/i.test(session?.title || ""))
}
