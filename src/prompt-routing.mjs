import { randomUUID } from "node:crypto"
import { formatDuration } from "./backend-backoff.mjs"
import { AttachmentBuffer, cleanupFiles, downloadTelegramFiles } from "./attachments.mjs"
import { applyChatTemplate } from "./chat-templates.mjs"
import { logErrorEvent, logInfo } from "./logger.mjs"
import { MultipartPromptBuffer } from "./multipart-prompts.mjs"
import { profileFromMessages, profileFromSession, promptPayload, titleFromText } from "./opencode.mjs"
import { PromptQueue } from "./prompt-queue.mjs"
import { promptHash } from "./state.mjs"
import { escapeHtml, topicId } from "./telegram.mjs"
import { prepareSavedFilesForServer } from "./upload-transfer.mjs"

export function createPromptRouter({ config, state, telegram, opencode, renderer, scheduleReconcile, logError }) {
  const promptFeedbackMessages = new Map()
  const activityPersistedAt = new Map()
  const multipartPrompts = new MultipartPromptBuffer(config.multipartPrompts, flushTelegramPrompt, logError)
  const attachmentBuffer = new AttachmentBuffer({
    settings: config.attachments,
    uploadDir: config.paths.uploadsDir,
    flushPrompt: flushTelegramPrompt,
    onExpire: notifyAttachmentExpired,
    onError: logError,
  })
  const promptQueue = new PromptQueue(sendTelegramPrompt, { onDrop: cleanupFiles })

  async function queueTelegramPrompt(key, text, context) {
    if (context?.rewindError) {
      await sendRewindError(context.message, context.rewindError)
      return
    }
    await multipartPrompts.push(key, text, context)
  }

  async function flushTelegramPrompt(context, text, files = []) {
    if (context.rewindError) {
      await cleanupFiles(files)
      await sendRewindError(context.message, context.rewindError)
      return
    }
    if (context.rewind) {
      await rewindTelegramPrompt(context, text, files)
      return
    }
    const sourceMessageId = context.message?.message_id
    if (context.binding) {
      await sendTelegramPrompt(context.binding, text, files, { sourceMessageId })
      return
    }
    if (!context.pending) return
    const directory = context.pending.directory || opencode.defaultNewSessionDirectory(context.pending.serverID)
    const session = await opencode.createSession(context.pending.serverID, { directory })
    await applyChatTemplate(opencode, context.pending.serverID, session.id, context.pending.chatTemplate, { directory })
    const newBinding = {
      chatId: context.message.chat.id,
      topicId: topicId(context.message),
      topicTitle: context.pending.topicTitle || context.pending.title,
      topicIconCustomEmojiId: context.pending.topicIconCustomEmojiId,
      topicIconEmoji: context.pending.topicIconEmoji,
      serverID: context.pending.serverID,
      sessionID: session.id,
      directory: session.directory || directory,
      title: context.pending.title || titleFromText(text || files[0]?.filename || "Attachments"),
      titleSource: context.pending.titleSource || "auto",
      chatTemplateName: context.pending.chatTemplateName,
      agent: context.pending.chatTemplate?.agent,
      model: context.pending.chatTemplate?.model,
    }
    await state.bindTopic(newBinding)
    await state.markSeenSession(newBinding.serverID, newBinding.sessionID)
    await activateBindingForPrompt(newBinding, "telegram-new-topic")
    await sendTelegramPrompt(newBinding, text, files, { sourceMessageId })
  }

  async function handleAttachmentMessage(message, promptKey, files, caption) {
    if (config.attachments.enabled === false) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Attachments are disabled for this bot." })
      return
    }
    const context = promptContext(message)
    if (context?.rewindError) {
      await sendRewindError(message, context.rewindError)
      return
    }
    if (!context) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "No OpenCodez session is bound to this topic. Create one with /new, then send files here." })
      return
    }
    const queued = parseQueueCaption(caption)
    if (queued && !context.binding) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "No bound OpenCodez session is active yet, so attachments cannot be queued here. Create one with /new first." })
      return
    }
    if (queued && !queued.text) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Usage: <code>/q prompt text</code> as the file caption." })
      return
    }
    try {
      const downloads = await downloadTelegramFiles(telegram, files, config.paths.uploadsDir, config.attachments)
      if (queued) {
        await attachmentBuffer.addFiles(promptKey, context, downloads, { text: queued.text, mediaGroupID: message.media_group_id || "", flushPrompt: queueAttachmentPrompt })
        return
      }
      await attachmentBuffer.addFiles(promptKey, context, downloads, { text: caption, mediaGroupID: message.media_group_id || "" })
    } catch (error) {
      await telegram.sendMessage({
        chatId: message.chat.id,
        topicId: topicId(message),
        text: `Could not attach file. <code>${escapeHtml(error.message)}</code>`,
      })
    }
  }

  async function flushAttachmentText(message, promptKey, text) {
    const context = promptContext(message)
    if (context?.rewindError) {
      await attachmentBuffer.discard(promptKey)
      await sendRewindError(message, context.rewindError)
      return
    }
    if (!context) {
      await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "No OpenCodez session is bound to this topic. Create one with /new first." })
      return
    }
    await attachmentBuffer.addText(promptKey, context, text)
  }

  async function notifyAttachmentExpired(context, files) {
    await telegram.sendMessage({
      chatId: context.message.chat.id,
      topicId: topicId(context.message),
      text: `Attachment batch expired: no prompt text arrived within ${formatDuration(config.attachments.promptIdleMs)} (${files.length} file${files.length === 1 ? "" : "s"}).`,
    })
  }

  async function queueAttachmentPrompt(context, text, files = []) {
    const result = await promptQueue.enqueue(context.binding, text, files, { sourceMessageId: context.message?.message_id })
    await telegram.sendMessage({ chatId: context.message.chat.id, topicId: topicId(context.message), text: queueAttachmentFeedback(result, files.length) })
  }

  function promptContext(message) {
    const binding = state.findBindingByTopic(message.chat.id, topicId(message))
    const rewind = resolveReplyRewind(message, binding)
    if (rewind.error) return { message, rewindError: rewind.error }
    if (binding) return { message, binding, rewind: rewind.origin ? rewind : undefined }
    const pending = state.pendingTopic(topicId(message))
    if (pending) return { message, pending }
    return null
  }

  function resolveReplyRewind(message, binding) {
    const replied = message.reply_to_message
    const telegramMessageID = Number(replied?.message_id)
    if (!Number.isSafeInteger(telegramMessageID)) return {}

    const origin = state.findPromptOrigin({
      chatID: message.chat.id,
      topicID: topicId(replied),
      telegramMessageID,
    })
    if (!origin) return {}
    if (String(topicId(message) ?? "") !== String(topicId(replied) ?? "")) {
      return { error: "This reply points to a prompt from another topic, so nothing was sent." }
    }
    if (origin.status !== "active") {
      return { error: "This prompt is already part of an undone branch. Nothing was sent." }
    }
    if (!binding || origin.serverID !== binding.serverID || origin.sessionID !== binding.sessionID) {
      return { error: "This prompt belongs to an earlier session. Nothing was sent to the current session." }
    }
    return { origin }
  }

  function multipartPromptKey(message) {
    return `${message.chat.id}:${topicId(message)}:${message.from?.id || 0}`
  }

  async function sendTelegramPrompt(binding, text, files = [], { sourceMessageId } = {}) {
    promptQueue.markBusy(binding)
    await activateBindingForPrompt(binding, "telegram-prompt")
    const feedbackMessage = await sendPromptFeedback({ binding, text: promptFeedbackStartingText(), kind: "accepted" })
    try {
      const profile = await currentProfile(binding)
      const preparedFiles = await prepareSavedFilesForServer(files, { server: opencode.server(binding.serverID), sessionID: binding.sessionID })
      const opencodeMessageID = telegramPromptMessageID()
      await state.addPendingPrompt({
        serverID: binding.serverID,
        sessionID: binding.sessionID,
        hash: promptHash(text),
        messageId: sourceMessageId,
      })
      await opencode.promptAsync(binding.serverID, binding.sessionID, promptPayload(text, profile, preparedFiles, opencodeMessageID), { directory: binding.directory })
      await state.recordPromptOrigin({
        chatID: binding.chatId,
        topicID: binding.topicId,
        telegramMessageID: sourceMessageId,
        serverID: binding.serverID,
        sessionID: binding.sessionID,
        opencodeMessageID,
      })
      if (await pinTelegramPromptMessage(binding, sourceMessageId, "telegram-prompt", { serviceMessageAfterId: feedbackMessage?.message_id })) {
        await state.markPendingPromptPinned(binding.serverID, binding.sessionID, text, sourceMessageId).catch(logError)
      }
      await updatePromptFeedback(binding, promptFeedbackAcceptedText()).catch(logError)
      scheduleReconcile(binding, 8000)
    } catch (error) {
      promptQueue.markSendFailed(binding)
      await state.removePendingPrompt(binding.serverID, binding.sessionID, text).catch(logError)
      await reportPromptFeedbackError(binding, error).catch(logError)
      throw error
    }
  }

  async function rewindTelegramPrompt(context, text, files) {
    const { message, rewind } = context
    const binding = state.findBindingByTopic(message.chat.id, topicId(message))
    const currentOrigin = state.findPromptOrigin({
      chatID: message.chat.id,
      topicID: topicId(message.reply_to_message),
      telegramMessageID: message.reply_to_message?.message_id,
    })
    if (
      !binding ||
      !currentOrigin ||
      currentOrigin.status !== "active" ||
      currentOrigin.opencodeMessageID !== rewind.origin.opencodeMessageID ||
      currentOrigin.serverID !== binding.serverID ||
      currentOrigin.sessionID !== binding.sessionID
    ) {
      await cleanupFiles(files)
      await sendRewindError(message, "This prompt no longer belongs to the active session. Nothing was sent.")
      return
    }
    await telegram.sendMessage({
      chatId: message.chat.id,
      topicId: topicId(message),
      text: "↩️ Rewinding this branch and sending the replacement prompt…",
    })

    promptQueue.discardPending(binding)
    const status = await opencode.sessionStatus(binding.serverID, binding.sessionID, { directory: binding.directory })
    if (status.type !== "idle") {
      promptQueue.markExpectedStop(binding, 45_000)
      await opencode.abortSession(binding.serverID, binding.sessionID, { directory: binding.directory })
      await opencode.waitForSessionIdle(binding.serverID, binding.sessionID, { directory: binding.directory, timeoutMs: 45_000 })
      await promptQueue.waitForExpectedStop(binding)
    }
    await promptQueue.markBackendIdle(binding)
    await promptQueue.markTerminalMirrored(binding)
    await opencode.revertSession(binding.serverID, binding.sessionID, rewind.origin.opencodeMessageID, { directory: binding.directory })
    await state.markPromptOriginsRewound(binding.serverID, binding.sessionID, rewind.origin.opencodeMessageID)
    await promptQueue.sendNow(binding, text, files, { sourceMessageId: message.message_id })
  }

  async function sendRewindError(message, text) {
    await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: `⚠️ ${text}` })
  }

  async function activateBindingForPrompt(binding, reason) {
    if (config.reconcile.enabled === false) return
    const now = Date.now()
    await state.activateBinding(binding.serverID, binding.sessionID, {
      reconcileAfter: now - config.reconcile.lookbackMs,
      reconcileUntil: now + config.reconcile.activeWindowMs,
      reason,
    })
  }

  async function maybeExtendBindingActivity(binding, reason) {
    if (config.reconcile.enabled === false) return
    const key = `${binding.serverID}:${binding.sessionID}`
    const now = Date.now()
    const last = activityPersistedAt.get(key) || 0
    if (now - last < 60_000) return
    activityPersistedAt.set(key, now)
    await state.extendBindingActivity(binding.serverID, binding.sessionID, {
      reconcileUntil: now + config.reconcile.activeWindowMs,
      reason,
    })
  }

  async function sendPromptFeedback({ binding, chatId, topicId: targetTopicId, text, kind }) {
    if (config.promptFeedback.enabled === false) return
    if (kind === "accepted" && config.promptFeedback.accepted === false) return
    if (kind === "queued" && config.promptFeedback.queued === false) return
    if (kind === "error" && config.promptFeedback.errors === false) return
    if (kind === "accepted" && binding) await clearPromptFeedback(binding)
    const message = await telegram.sendMessage({
      chatId: binding?.chatId ?? chatId,
      topicId: binding?.topicId ?? targetTopicId,
      text,
    })
    if (kind === "accepted" && binding && message?.message_id) {
      promptFeedbackMessages.set(promptFeedbackKey(binding), { chatId: binding.chatId, messageId: message.message_id })
    }
    return message
  }

  async function updatePromptFeedback(binding, text) {
    const item = promptFeedbackMessages.get(promptFeedbackKey(binding))
    if (!item) return false
    await telegram.editMessageText({ chatId: item.chatId, messageId: item.messageId, text })
    return true
  }

  async function reportPromptFeedbackError(binding, error) {
    const text = `🔴 Prompt was not accepted\n🧯 ${escapeHtml(error.message)}`
    const updated = await updatePromptFeedback(binding, text).catch(() => false)
    if (!updated) await sendPromptFeedback({ binding, text, kind: "error" })
  }

  async function clearPromptFeedback(binding) {
    const key = promptFeedbackKey(binding)
    const item = promptFeedbackMessages.get(key)
    if (!item) return
    promptFeedbackMessages.delete(key)
    try {
      await telegram.deleteMessage({ chatId: item.chatId, messageId: item.messageId })
      logInfo("prompt_feedback.deleted", { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId, messageId: item.messageId })
    } catch (error) {
      if (!/message to delete not found|message can't be deleted|message not found/i.test(error.message)) {
        logErrorEvent("prompt_feedback.delete.failed", error, { serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId, messageId: item.messageId })
      }
    }
  }

  async function currentProfile(binding) {
    const bindingProfile = {}
    if (binding.agent) bindingProfile.agent = binding.agent
    if (binding.model) bindingProfile.model = binding.model
    if (bindingProfile.agent || bindingProfile.model) return { ...config.defaultPrompt, ...bindingProfile }
    try {
      const session = await opencode.getSession(binding.serverID, binding.sessionID, { directory: binding.directory })
      const fromSession = profileFromSession(session)
      if (fromSession.model || fromSession.agent) return { ...config.defaultPrompt, ...fromSession }
    } catch {}
    try {
      const messages = await opencode.messages(binding.serverID, binding.sessionID, { directory: binding.directory })
      const fromMessages = profileFromMessages(messages)
      if (fromMessages.model || fromMessages.agent) return { ...config.defaultPrompt, ...fromMessages }
    } catch {}
    return config.defaultPrompt
  }

  async function pinTelegramPromptMessage(binding, sourceMessageId, origin, fields = {}) {
    const messageId = Number(sourceMessageId)
    if (!renderer.shouldPinUserPrompts() || !Number.isSafeInteger(messageId) || messageId <= 0) return false
    return renderer.pinMessage(binding, messageId, { origin, ...fields })
  }

  return {
    activateBindingForPrompt,
    clearPromptFeedback,
    createPendingPromptQueue: () => promptQueue,
    flushAttachmentText,
    handleAttachmentMessage,
    discardAttachmentBatch: (key) => attachmentBuffer.discard(key),
    hasPendingAttachmentBatch: (key) => attachmentBuffer.has(key),
    maybeExtendBindingActivity,
    multipartPrompts,
    multipartPromptKey,
    promptContext,
    promptQueue,
    queueTelegramPrompt,
  }
}

function promptFeedbackKey(binding) {
  return `${binding.serverID}:${binding.sessionID}`
}

function promptFeedbackStartingText() {
  return "🟡 Prompt received\n🚀 Sending it to OpenCodez"
}

function promptFeedbackAcceptedText() {
  return "🟢 Accepted by OpenCodez\n🧠 Waiting for the first events"
}

function telegramPromptMessageID() {
  return `msg_tg_${randomUUID().replaceAll("-", "")}`
}

function parseQueueCaption(caption) {
  const value = String(caption || "").trim()
  if (!value) return null
  const match = value.match(/^\/q(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/)
  if (!match) return null
  return { text: String(match[1] || "").trim() }
}

function queueAttachmentFeedback(result, fileCount) {
  const files = `${fileCount} file${fileCount === 1 ? "" : "s"}`
  if (result.status === "sent") return `No active run; sent immediately with ${files}.`
  if (result.status === "queued") return `Queued prompt #${result.position} with ${files}.`
  return `Could not queue attachment prompt with ${files}.`
}
