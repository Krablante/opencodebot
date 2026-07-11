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
    await multipartPrompts.push(key, text, context)
  }

  async function flushTelegramPrompt(context, text, files = []) {
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
    if (binding) return { message, binding }
    const pending = state.pendingTopic(topicId(message))
    if (pending) return { message, pending }
    return null
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
      await state.addPendingPrompt({
        serverID: binding.serverID,
        sessionID: binding.sessionID,
        hash: promptHash(text),
        messageId: sourceMessageId,
      })
      await opencode.promptAsync(binding.serverID, binding.sessionID, promptPayload(text, profile, preparedFiles), { directory: binding.directory })
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
