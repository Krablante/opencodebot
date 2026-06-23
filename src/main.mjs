import { assertRuntimeConfig, loadConfig } from "./config.mjs"
import { AttachmentBuffer, cleanupUploads, downloadTelegramFiles, extractTelegramFiles } from "./attachments.mjs"
import { createBackendRequester, formatDuration } from "./backend-backoff.mjs"
import { applyChatTemplate, parseNewTopicArgs } from "./chat-templates.mjs"
import { createTelegramCommandHandlers, telegramBotCommands } from "./commands.mjs"
import { OpenCodeClient, profileFromMessages, profileFromSession, promptPayload, textFromPrompt, titleFromText } from "./opencode.mjs"
import { MultipartPromptBuffer } from "./multipart-prompts.mjs"
import { PromptQueue } from "./prompt-queue.mjs"
import { formatToolLine, MirrorRenderer } from "./render.mjs"
import { StateStore, promptHash } from "./state.mjs"
import { escapeHtml, isAllowedMessage, TelegramClient, telegramMessageLink, topicId } from "./telegram.mjs"
import { durationMs, logErrorEvent, logInfo, shouldLogSlow } from "./logger.mjs"

const config = loadConfig()
assertRuntimeConfig(config)

const state = new StateStore(config.paths.statePath)
await state.load()
if (config.telegram.chatId && !state.chatId) await state.setChatId(config.telegram.chatId)

const telegram = new TelegramClient(config.telegram.token)
const botInfo = await telegram.getMe()
const opencode = new OpenCodeClient(config)
const promptFeedbackMessages = new Map()
const renderer = new MirrorRenderer({ telegram, state, config, onMirrorMessage: clearPromptFeedback, onFinalMessage: notifyFinalAnswerReady })
const abort = new AbortController()
let shutdownRequested = false
const backendRequester = createBackendRequester()
const skippedBackendRequest = backendRequester.skipped
const backendRequest = backendRequester.request
const activityPersistedAt = new Map()
const multipartPrompts = new MultipartPromptBuffer(config.multipartPrompts, flushTelegramPrompt, logError)
const attachmentBuffer = new AttachmentBuffer({
  settings: config.attachments,
  uploadDir: config.paths.uploadsDir,
  flushPrompt: flushTelegramPrompt,
  onExpire: notifyAttachmentExpired,
  onError: logError,
})
const promptQueue = new PromptQueue(sendTelegramPrompt)
const commandHandlers = createTelegramCommandHandlers({ config, state, telegram, promptQueue, multipartPrompts, createPendingTopic })

process.once("SIGINT", () => requestShutdown("SIGINT"))
process.once("SIGTERM", () => requestShutdown("SIGTERM"))

await telegram.deleteWebhook()
await syncTelegramCommandMenu()
await cleanupUploads(config.paths.uploadsDir, config.attachments.cleanupAfterMs).catch(logError)
setInterval(() => cleanupUploads(config.paths.uploadsDir, config.attachments.cleanupAfterMs).catch(logError), 60 * 60 * 1000).unref?.()
console.log(`[opencodebot] starting ${config.opencode.servers.length} OpenCodez event streams`)

for (const server of config.opencode.servers) {
  opencode.subscribeEvents(server.id, handleOpenCodeEvent, abort.signal)
}

reconcileLoop().catch(logError)

await pollTelegram()

async function syncTelegramCommandMenu() {
  const scopes = telegramCommandScopes()
  try {
    for (const scope of scopes) {
      await telegram.setMyCommands(telegramBotCommands, scope ? { scope } : {})
    }
    logInfo("telegram.commands.synced", { count: telegramBotCommands.length, scopes: scopes.map((scope) => scope?.type || "default") })
  } catch (error) {
    logErrorEvent("telegram.commands.sync.failed", error)
  }
}

function telegramCommandScopes() {
  const scopes = [null, { type: "all_private_chats" }, { type: "all_group_chats" }, { type: "all_chat_administrators" }]
  const chatId = state.chatId || config.telegram.chatId
  if (chatId) {
    scopes.push({ type: "chat", chat_id: chatId }, { type: "chat_administrators", chat_id: chatId })
    for (const userID of config.telegram.allowedUserIds || []) {
      scopes.push({ type: "chat_member", chat_id: chatId, user_id: userID })
    }
  }
  return scopes
}

async function pollTelegram() {
  let offset = state.data.runtime.telegramUpdateOffset || undefined
  while (!abort.signal.aborted) {
    try {
      const updates = await telegram.getUpdates(offset, 25, { signal: abort.signal })
      for (const update of updates) {
        if (update.message) await handleTelegramMessage(update.message)
        offset = update.update_id + 1
        await state.update((data) => {
          data.runtime.telegramUpdateOffset = offset
        })
      }
    } catch (error) {
      if (abort.signal.aborted) break
      logError(error)
      await delay(2500, abort.signal).catch(() => {})
    }
  }
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

  const promptKey = multipartPromptKey(message)
  if (files.length) {
    await handleAttachmentMessage(message, promptKey, files, caption)
    return
  }
  if (!text) return
  if (attachmentBuffer.has(promptKey) && !text.startsWith("/")) {
    await flushAttachmentText(message, promptKey, text)
    return
  }

  const command = parseCommand(text)

  if (await commandHandlers.handle(message, command, promptKey)) return
  if (text.startsWith("/")) {
    await multipartPrompts.flushKey(promptKey)
    await telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: "Unknown command. Send /help for available commands." })
    return
  }

  const binding = state.findBindingByTopic(message.chat.id, topicId(message))
  if (binding) {
    await queueTelegramPrompt(promptKey, text, { message, binding })
    return
  }

  const pending = state.pendingTopic(topicId(message))
  if (pending) {
    await queueTelegramPrompt(promptKey, text, { message, pending })
    return
  }
  await sendPromptFeedback({
    chatId: message.chat.id,
    topicId: topicId(message),
    text: "🔴 Topic is not bound\n🧭 Use /new, then send the prompt in the new topic",
    kind: "error",
  })
}

async function queueTelegramPrompt(key, text, context) {
  await multipartPrompts.push(key, text, context)
}

async function flushTelegramPrompt(context, text, files = []) {
  if (context.binding) {
    await sendTelegramPrompt(context.binding, text, files)
    return
  }
  if (!context.pending) return
  const session = await opencode.createSession(context.pending.serverID)
  await applyChatTemplate(opencode, context.pending.serverID, session.id, context.pending.chatTemplate)
  const newBinding = {
    chatId: context.message.chat.id,
    topicId: topicId(context.message),
    serverID: context.pending.serverID,
    sessionID: session.id,
    title: context.pending.title || titleFromText(text || files[0]?.filename || "Attachments"),
    titleSource: context.pending.titleSource || "auto",
    chatTemplateName: context.pending.chatTemplateName,
    agent: context.pending.chatTemplate?.agent,
    model: context.pending.chatTemplate?.model,
  }
  await state.bindTopic(newBinding)
  await state.markSeenSession(newBinding.serverID, newBinding.sessionID)
  await activateBindingForPrompt(newBinding, "telegram-new-topic")
  await sendTelegramPrompt(newBinding, text, files)
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
  try {
    const downloads = await downloadTelegramFiles(telegram, files, config.paths.uploadsDir, config.attachments)
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

async function createPendingTopic(message, args) {
  const { serverID, title, titleSource, chatTemplateName, chatTemplate } = parseNewTopicArgs(args, {
    servers: opencode.servers,
    defaultServerID: config.defaultPrompt.serverID,
    chatTemplates: config.chatTemplates,
  })
  const chatId = state.chatId || message.chat.id
  const topic = await telegram.createForumTopic({ chatId, name: title, iconCustomEmojiId: await randomTopicIcon() })
  await state.addPendingTopic(topic.message_thread_id, { serverID, title, titleSource, chatTemplateName, chatTemplate })
  const suffix = chatTemplateName ? ` using <code>${escapeHtml(chatTemplateName)}</code>` : ""
  await telegram.sendMessage({
    chatId,
    topicId: topic.message_thread_id,
    text: `New OpenCodez topic for <code>${escapeHtml(serverID)}</code>${suffix}. Send the first prompt here.`,
  })
}

async function sendTelegramPrompt(binding, text, files = []) {
  promptQueue.markBusy(binding)
  await activateBindingForPrompt(binding, "telegram-prompt")
  await sendPromptFeedback({ binding, text: promptFeedbackStartingText(), kind: "accepted" })
  try {
    const profile = await currentProfile(binding)
    await state.addPendingPrompt({
      serverID: binding.serverID,
      sessionID: binding.sessionID,
      hash: promptHash(text),
    })
    await opencode.promptAsync(binding.serverID, binding.sessionID, promptPayload(text, profile, files))
    await updatePromptFeedback(binding, promptFeedbackAcceptedText()).catch(logError)
    scheduleReconcile(binding, 8000)
  } catch (error) {
    promptQueue.markIdle(binding)
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

function scheduleReconcile(binding, delayMs) {
  if (config.reconcile.enabled === false) return
  setTimeout(() => {
    const current = state.findBinding(binding.serverID, binding.sessionID) || binding
    reconcileBinding(current).catch(logError)
  }, delayMs).unref?.()
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

async function notifyFinalAnswerReady(binding, { assistantMessageID, messageId }) {
  if (config.finalNotifications?.enabled === false) return
  if (!messageId) return
  if (state.finalNotificationSent(binding.serverID, binding.sessionID, assistantMessageID, messageId)) return
  const configuredUserIds = new Set((config.finalNotifications?.userIds || []).map(String))
  const userIds = state.finalNotificationUserIds().filter((userId) => configuredUserIds.has(String(userId)))
  if (!userIds.length) return
  const link = telegramMessageLink(binding.chatId, messageId)
  const title = binding.title || `Topic ${binding.topicId}`
  const text = finalNotificationText({ title, link, serverID: binding.serverID })
  for (const userId of userIds) {
    try {
      await telegram.sendMessage({ chatId: userId, text, disablePreview: true })
      logInfo("final_notification.sent", { userId, serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId, messageId })
    } catch (error) {
      logErrorEvent("final_notification.failed", error, { userId, serverID: binding.serverID, sessionID: binding.sessionID, topicId: binding.topicId, messageId })
    }
  }
  await state.markFinalNotificationSent(binding.serverID, binding.sessionID, assistantMessageID, messageId, config.finalNotifications.maxSentMarkers)
}

function finalNotificationText({ title, link, serverID }) {
  const topic = link ? `<a href="${escapeHtml(link)}">${escapeHtml(title)}</a>` : `<b>${escapeHtml(title)}</b>`
  return [
    "🏁 Final answer is ready",
    `🧵 ${topic}`,
    `🖥️ Server: <code>${escapeHtml(serverID)}</code>`,
  ].join("\n")
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

async function handleTopicLifecycleMessage(message) {
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

async function currentProfile(binding) {
  const bindingProfile = {}
  if (binding.agent) bindingProfile.agent = binding.agent
  if (binding.model) bindingProfile.model = binding.model
  if (bindingProfile.agent || bindingProfile.model) return { ...config.defaultPrompt, ...bindingProfile }
  try {
    const session = await opencode.getSession(binding.serverID, binding.sessionID)
    const fromSession = profileFromSession(session)
    if (fromSession.model || fromSession.agent) return { ...config.defaultPrompt, ...fromSession }
  } catch {}
  try {
    const messages = await opencode.messages(binding.serverID, binding.sessionID)
    const fromMessages = profileFromMessages(messages)
    if (fromMessages.model || fromMessages.agent) return { ...config.defaultPrompt, ...fromMessages }
  } catch {}
  return config.defaultPrompt
}

async function handleOpenCodeEvent(server, event) {
  const startedAt = Date.now()
  const properties = event.properties || {}
  const sessionID = properties.sessionID
  if (!sessionID || !state.mirrorEnabled(config)) return

  let binding = state.findBinding(server.id, sessionID)
  if (!binding && event.type === "session.next.prompted" && config.telegram.autocreateTopics) {
    binding = await createTopicForWebSession(server.id, sessionID, textFromPrompt(properties.prompt))
  }
  if (!binding || binding.disabled) return
  if (event.type === "session.next.prompted") await activateBindingForPrompt(binding, "web-prompt")
  else await maybeExtendBindingActivity(binding, "opencode-event")
  const fields = () => ({
    source: server.id,
    sessionID,
    topicId: binding.topicId,
    type: event.type,
    assistantMessageID: properties.assistantMessageID,
    messageID: properties.messageID,
    partID: properties.partID,
  })

  try {
    switch (event.type) {
      case "session.next.prompted": {
        promptQueue.markBusy(binding)
        const text = textFromPrompt(properties.prompt)
        if (!text) return
        const consumed = await state.consumePendingPrompt(server.id, sessionID, text)
        if (!consumed) await renderer.userPrompt(binding, text, "web")
        if (properties.messageID) await state.markUserMirrored(server.id, sessionID, properties.messageID)
        break
      }
      case "session.next.text.delta":
        await renderer.textDelta(binding, properties)
        break
      case "session.next.text.ended":
        await renderer.textEnded(binding, properties)
        break
      case "session.next.step.ended":
        if (properties.finish === "stop") {
          await renderer.pinFinalAssistantMessage(binding, properties.assistantMessageID)
          await promptQueue.complete(binding)
        }
        await state.markAssistantMirrored(server.id, sessionID, properties.assistantMessageID)
        break
      case "session.next.step.failed":
        await state.markAssistantMirrored(server.id, sessionID, properties.assistantMessageID)
        await notifyRunFailed(binding, properties, promptQueue.clear(binding))
        break
      case "session.error":
        await notifySessionError(binding, properties)
        break
      case "session.next.tool.called":
        await renderer.toolCalled(binding, properties)
        break
      case "session.next.tool.success":
        await renderer.toolResult(binding, properties, true)
        break
      case "session.next.tool.failed":
        await renderer.toolResult(binding, properties, false)
        break
    }
  } catch (error) {
    logErrorEvent("mirror.event.failed", error, fields())
    await handleMirrorError(binding, error)
  }
  const elapsedMs = durationMs(startedAt)
  if (isMirrorMilestone(event.type) || shouldLogSlow(elapsedMs)) logInfo("mirror.event.handled", { ...fields(), durationMs: elapsedMs })
}

async function reconcileLoop() {
  if (config.reconcile.enabled === false) return
  await seedExistingSessions()
  while (!abort.signal.aborted) {
    await delay(config.reconcile.intervalMs, abort.signal).catch(() => {})
    if (abort.signal.aborted) break
    if (!state.mirrorEnabled(config)) continue
    await reconcileSessions().catch(logError)
    for (const binding of [...state.data.bindings].filter((item) => !item.disabled)) {
      if (!reconcileWindow(binding)) continue
      try {
        await reconcileBinding(binding)
      } catch (error) {
        await handleMirrorError(binding, error).catch(logError)
      }
    }
  }
}

async function seedExistingSessions() {
  const seen = []
  for (const server of config.opencode.servers) {
    const sessions = await backendRequest(server.id, "seed sessions", () => opencode.listSessions(server.id))
    if (sessions === skippedBackendRequest) continue
    for (const session of sessions) seen.push([server.id, session.id])
  }
  const seeded = await state.seedSeenSessions(seen)
  if (seeded) console.log(`[opencodebot] seeded ${seen.length} existing OpenCodez sessions`)
}

async function reconcileSessions() {
  const chatId = state.chatId || config.telegram.chatId
  if (!chatId || !config.telegram.autocreateTopics) return
  for (const server of config.opencode.servers) {
    const sessions = await backendRequest(server.id, "list sessions", () => opencode.listSessions(server.id))
    if (sessions === skippedBackendRequest) continue
    for (const session of sessions) {
      const binding = state.findBinding(server.id, session.id)
      if (isInternalSession(session)) {
        await state.markSeenSession(server.id, session.id)
        if (binding && !binding.disabled) await state.disableBinding(server.id, session.id, "internal subagent session")
        continue
      }
      if (binding) {
        await maybeSyncTopicTitle(binding, session.title)
        continue
      }
      if (state.hasSeenSession(server.id, session.id)) continue
      await state.markSeenSession(server.id, session.id)
      await createTopicForSession(server.id, session)
    }
  }
}

async function maybeSyncTopicTitle(binding, title) {
  if (!title || title === binding.title) return
  if (binding.titleSource === "user") return
  if (title.startsWith("New session -") && binding.title && !binding.title.startsWith("New session -")) return
  try {
    await telegram.editForumTopic({ chatId: binding.chatId, topicId: binding.topicId, name: title })
    await state.updateBindingTitle(binding.serverID, binding.sessionID, title)
  } catch (error) {
    console.warn(`[opencodebot] topic title sync failed for ${binding.serverID}/${binding.sessionID}: ${error.message}`)
  }
}

async function reconcileBinding(binding) {
  const window = reconcileWindow(binding)
  if (!window) return
  const startedAt = Date.now()
  let mirroredUsers = 0
  let mirroredAssistants = 0
  const messages = await backendRequest(binding.serverID, "session messages", () => opencode.messages(binding.serverID, binding.sessionID))
  if (messages === skippedBackendRequest) return
  for (const message of messages) {
    const info = message.info || message
    if (!messageInReconcileWindow(info, window)) continue
    if (info.role === "user") {
      const text = textFromStoredMessage(message)
      if (text && info.id && !state.isUserMirrored(binding.serverID, binding.sessionID, info.id)) {
        const consumed = await state.consumePendingPrompt(binding.serverID, binding.sessionID, text)
        if (!consumed) await renderer.userPrompt(binding, text, "web")
        await state.markUserMirrored(binding.serverID, binding.sessionID, info.id)
        mirroredUsers += 1
      }
      continue
    }
    if (info.role !== "assistant" || !info.id) continue
    if (!isCompleted(info)) continue
    if (state.isAssistantMirrored(binding.serverID, binding.sessionID, info.id)) continue
    await renderStoredAssistantMessage(binding, message)
    await state.markAssistantMirrored(binding.serverID, binding.sessionID, info.id)
    mirroredAssistants += 1
    if (info.finish === "stop") await promptQueue.complete(binding)
  }
  const elapsedMs = durationMs(startedAt)
  if (mirroredUsers || mirroredAssistants || shouldLogSlow(elapsedMs)) {
    logInfo("reconcile.binding.done", {
      serverID: binding.serverID,
      sessionID: binding.sessionID,
      topicId: binding.topicId,
      messages: messages.length,
      mirroredUsers,
      mirroredAssistants,
      reconcileAfter: new Date(window.afterMs).toISOString(),
      durationMs: elapsedMs,
    })
  }
}

async function handleMirrorError(binding, error) {
  if (isUnavailableTopicError(error)) {
    await state.disableBinding(binding.serverID, binding.sessionID, error.message || "Telegram topic unavailable")
    console.warn(`[opencodebot] disabled unavailable Telegram topic binding ${binding.serverID}/${binding.sessionID}: ${error.message}`)
    return
  }
  throw error
}

function isUnavailableTopicError(error) {
  return /message thread not found|forum topic .*not found|topic .*not found|topic .*deleted|topic .*closed|message thread .*closed/i.test(
    error.message || "",
  )
}

async function notifyRunFailed(binding, properties, clearedQueue) {
  const errorText = stepFailureText(properties)
  const lines = ["<b>Run finished with an error.</b>"]
  if (errorText) lines.push(escapeHtml(errorText))
  if (clearedQueue.length) {
    lines.push("", "<b>Cleared queued prompts:</b>")
    lines.push(...clearedQueue.map((item) => `${item.index}. <code>${escapeHtml(item.summary)}</code>`))
  }
  await telegram.sendMessage({
    chatId: binding.chatId,
    topicId: binding.topicId,
    text: lines.join("\n"),
  })
}

async function notifySessionError(binding, properties) {
  const text = sessionErrorText(properties)
  await telegram.sendMessage({
    chatId: binding.chatId,
    topicId: binding.topicId,
    text: `<b>OpenCodez session error.</b>${text ? `\n${escapeHtml(text)}` : ""}`,
  })
}

function stepFailureText(properties) {
  const error = properties.error || properties.exception || properties.reason
  if (typeof error === "string") return error
  if (error?.message) return error.message
  if (properties.message) return properties.message
  return ""
}

function sessionErrorText(properties) {
  const error = properties.error || properties.exception || properties.reason
  if (typeof error === "string") return error
  if (error?.message) return error.message
  if (properties.message) return String(properties.message)
  return ""
}

async function renderStoredAssistantMessage(binding, message) {
  const info = message.info || message
  const parts = message.parts || []
  const toolLines = []
  const textParts = []
  for (const part of parts) {
    if (part?.type === "text" && part.text) textParts.push(part.text)
    const toolLine = compactStoredToolLine(part)
    if (toolLine) toolLines.push(toolLine)
  }
  await renderer.compactTools(binding, toolLines)
  await renderer.assistantMessage(binding, textParts.join("\n\n"), { pin: info.finish === "stop", assistantMessageID: info.id })
}

function textFromStoredMessage(message) {
  return (message.parts || [])
    .filter((part) => part?.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n")
}

function compactStoredToolLine(part) {
  if (!part || part.type !== "tool") return ""
  const tool = part.name || part.tool || "tool"
  if (!renderer.shouldMirrorTool(tool)) return ""
  const status = part.state?.status || part.state
  const failed = status === "error" || status === "failed" || part.state?.error
  const ok = !failed && (status === "completed" || status === "success")
  if (!failed && !ok) return ""
  return formatToolLine(tool, part.state?.input || part.input || {}, ok, failed ? part.state?.error?.message || "failed" : "")
}

function isMirrorMilestone(type) {
  return type === "session.next.step.ended" || type === "session.next.step.failed" || type === "session.idle"
}

function reconcileWindow(binding) {
  if (config.reconcile.enabled === false) return null
  const afterMs = Date.parse(binding.reconcileAfter || "")
  const untilMs = Date.parse(binding.reconcileUntil || "")
  if (!Number.isFinite(afterMs) || !Number.isFinite(untilMs)) return null
  if (untilMs < Date.now()) return null
  return { afterMs, untilMs }
}

function messageInReconcileWindow(info, window) {
  const timeMs = messageTimeMs(info)
  return timeMs > 0 && timeMs >= window.afterMs
}

function messageTimeMs(info) {
  const direct = info?.time?.created || info?.time?.completed
  if (Number.isFinite(direct)) return direct
  for (const value of [info?.createdAt, info?.created, info?.updatedAt]) {
    const parsed = Date.parse(value || "")
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function isCompleted(info) {
  return Boolean(info.time?.completed || info.time?.failed || info.finished || info.completed)
}

async function randomTopicIcon() {
  if (!config.telegram.randomTopicIcon) return undefined
  try {
    const stickers = await telegram.getForumTopicIconStickers()
    const ids = stickers.map((sticker) => sticker.custom_emoji_id).filter(Boolean)
    if (!ids.length) return undefined
    return ids[Math.floor(Math.random() * ids.length)]
  } catch (error) {
    console.warn(`[opencodebot] random topic icon unavailable: ${error.message}`)
    return undefined
  }
}

function parseCommand(text) {
  const match = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/)
  if (!match) return { name: "", args: "" }
  return { name: match[1], args: match[2] || "" }
}

async function cleanupOwnPinServiceMessage(message) {
  if (config.mirror.deletePinServiceMessages === false) return
  const configuredChatId = state.chatId || config.telegram.chatId
  if (!message?.pinned_message || String(message.chat?.id) !== String(configuredChatId)) return
  if (message.pinned_message.from?.id !== botInfo.id) return
  try {
    await telegram.deleteMessage({ chatId: message.chat.id, messageId: message.message_id })
  } catch (error) {
    console.warn(`[opencodebot] failed to delete pin service message: ${error.message}`)
  }
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
  const topic = await telegram.createForumTopic({ chatId, name: title, iconCustomEmojiId: await randomTopicIcon() })
  const binding = { chatId, topicId: topic.message_thread_id, serverID, sessionID, title, titleSource: "auto" }
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
  const topic = await telegram.createForumTopic({ chatId, name: title, iconCustomEmojiId: await randomTopicIcon() })
  const binding = {
    chatId,
    topicId: topic.message_thread_id,
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

function isInternalSession(session) {
  return Boolean(session?.parentID || /\(@.+ subagent\)/i.test(session?.title || ""))
}

function logError(error) {
  console.error(`[opencodebot] ${error.stack || error.message || error}`)
}

function requestShutdown(signalName) {
  if (shutdownRequested) return
  shutdownRequested = true
  console.info(`[opencodebot] received ${signalName}, shutting down`)
  abort.abort()
  setTimeout(() => {
    console.info("[opencodebot] shutdown grace elapsed, exiting")
    process.exit(0)
  }, 2000).unref?.()
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    function done() {
      signal?.removeEventListener?.("abort", onAbort)
      resolve()
    }
    signal?.addEventListener?.("abort", onAbort, { once: true })
  })
}

function abortError() {
  const error = new Error("aborted")
  error.name = "AbortError"
  return error
}
