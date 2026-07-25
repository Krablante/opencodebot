import { assertRuntimeConfig, loadConfig } from "./config.mjs"
import { startArtifactGateway } from "./artifacts-gateway.mjs"
import { ArtifactUploadBuffer, handleArtifactUploadMessage } from "./artifact-uploads.mjs"
import { cleanupUploads, extractTelegramFiles } from "./attachments.mjs"
import { createBackendRequester } from "./backend-backoff.mjs"
import { parseNewTopicArgs } from "./prompt-profiles.mjs"
import { createTelegramCommandHandlers, telegramBotCommands } from "./commands.mjs"
import { createFinalNotifier } from "./final-notifications.mjs"
import { FinalVoiceModule } from "./final-voice.mjs"
import { ControlMenu } from "./control-menu.mjs"
import { configureI18n, setLanguage, t } from "./i18n/index.mjs"
import { OpenCodeClient } from "./opencode.mjs"
import { createPromptRouter } from "./prompt-routing.mjs"
import { createQuestionManager } from "./questions.mjs"
import { MirrorRenderer } from "./render.mjs"
import { createRunAlerter } from "./run-alerts.mjs"
import { createSessionReconciler } from "./session-reconcile.mjs"
import { SpeechModule } from "./speech/index.mjs"
import { StateStore } from "./state.mjs"
import { escapeHtml, TelegramClient } from "./telegram.mjs"
import { createTelegramPolling } from "./telegram-polling.mjs"
import { createTopicLifecycle } from "./topic-lifecycle.mjs"
import { managedTopicTitle } from "./topic-titles.mjs"
import { createUpdateManager } from "./update-manager.mjs"

const config = loadConfig()
assertRuntimeConfig(config)

const state = new StateStore(config.paths.statePath)
await state.load()
configureI18n({ state, defaultLanguage: config.ui.defaultLanguage })
if (config.telegram.chatId && !state.chatId) await state.setChatId(config.telegram.chatId)

const telegram = new TelegramClient(config.telegram.token, config.telegram.botApi)
const botInfo = await telegram.getMe()
const opencode = new OpenCodeClient(config)
const finalNotifier = createFinalNotifier({ config, state, telegram, opencode })
const notifyFinalAnswerReady = finalNotifier.notifyFinalAnswerReady
let promptRouter
let finalVoice
const renderer = new MirrorRenderer({
  telegram,
  state,
  config,
  onMirrorMessage: (...args) => promptRouter.clearPromptFeedback(...args),
  onFinalMessage: async (binding, details) => {
    finalVoice?.enqueueAutomatic({
      ...details,
      serverID: binding.serverID,
      sessionID: binding.sessionID,
      telegramChatID: binding.chatId,
      telegramTopicID: binding.topicId,
      telegramTopicTitle: binding.topicTitle || binding.title,
      telegramFinalMessageID: details.messageId,
    })
    await notifyFinalAnswerReady(binding, details)
  },
  onFinalAssistantMirrored: async (binding, assistantMessageID) => {
    await state.markAssistantMirrored(binding.serverID, binding.sessionID, assistantMessageID)
    await promptRouter.promptQueue.markTerminalMirrored(binding)
  },
})
let sessionReconciler
let controlMenu
promptRouter = createPromptRouter({
  config,
  state,
  telegram,
  opencode,
  renderer,
  scheduleReconcile: (...args) => sessionReconciler.scheduleReconcile(...args),
  logError,
})
const {
  activateBindingForPrompt,
  clearPromptFeedback,
  flushAttachmentText,
  handleAttachmentMessage,
  maybeExtendBindingActivity,
  multipartPrompts,
  multipartPromptKey,
  promptContext,
  promptQueue,
  queueTelegramPrompt,
} = promptRouter
const topicLifecycle = createTopicLifecycle({ config, state, telegram, opencode, activateBindingForPrompt, clearPromptFeedback })
const { createTopicForSession, createTopicForWebSession, handleTopicLifecycleMessage, isInternalSession, randomTopicIcon } = topicLifecycle
const abort = new AbortController()
let shutdownRequested = false
const backendRequester = createBackendRequester()
const skippedBackendRequest = backendRequester.skipped
const backendRequest = backendRequester.request
const speech = new SpeechModule({ config: config.speech, telegram, state, uploadDir: config.paths.uploadsDir, attachmentSettings: config.attachments })
finalVoice = new FinalVoiceModule({ config: config.finalVoice, state, telegram, signal: abort.signal })
const questionManager = createQuestionManager({
  config,
  state,
  telegram,
  opencode,
  backendRequest,
  skippedBackendRequest,
  logError,
})
const runAlerter = createRunAlerter({ config, state, telegram, logError })
const updateManager = createUpdateManager({ config, state, telegram })
const artifactUploads = new ArtifactUploadBuffer({
  settings: config.artifactUploads,
  flushUpload: ({ message, files }) => handleArtifactUploadMessage({ telegram, config, opencode, message, files }),
  onError: logError,
})
sessionReconciler = createSessionReconciler({
  config,
  state,
  telegram,
  opencode,
  renderer,
  promptQueue,
  questionManager,
  runAlerter,
  backendRequest,
  skippedBackendRequest,
  createTopicForSession,
  createTopicForWebSession,
  isInternalSession,
  activateBindingForPrompt,
  maybeExtendBindingActivity,
  clearPromptFeedback,
  logError,
  shouldStop: () => shutdownRequested,
  onSessionStatusChange: () => controlMenu?.scheduleStatusRefresh(),
})
let refreshCommandMenu = async () => {}
controlMenu = new ControlMenu({
  config,
  state,
  telegram,
  opencode,
  promptQueue,
  finalVoice,
  createSession: createPendingTopic,
  refreshCommandMenu: async (language) => {
    if (language) await setLanguage(language)
    await refreshCommandMenu()
  },
})
const commandHandlers = createTelegramCommandHandlers({
  config,
  state,
  telegram,
  opencode,
  promptQueue,
  multipartPrompts,
  createPendingTopic,
  discardAttachmentBatch: promptRouter.discardAttachmentBatch,
  detachBinding: sessionReconciler.detachBinding,
  speech,
  finalVoice,
  questionManager,
  updateManager,
  controlMenu,
  refreshCommandMenu: () => refreshCommandMenu(),
})
const telegramPolling = createTelegramPolling({
  config,
  commands: telegramBotCommands,
  state,
  telegram,
  commandHandlers,
  handleSpeechMessage: (message) => speech.handleMessage(message),
  handleVoiceMessage: (message) => speech.handleVoiceMessage(message),
  questionManager,
  handleTopicLifecycleMessage,
  handleAttachmentMessage,
  handleArtifactUploadMessage: ({ message, files }) => artifactUploads.add({ message, files }),
  extractTelegramFiles,
  hasPendingAttachmentBatch: promptRouter.hasPendingAttachmentBatch,
  queueTelegramPrompt,
  flushAttachmentText,
  promptContext,
  multipartPromptKey,
  flushPromptKey: (key) => multipartPrompts.flushKey(key),
  logError,
})
refreshCommandMenu = telegramPolling.syncCommandMenu

process.once("SIGINT", () => requestShutdown("SIGINT"))
process.once("SIGTERM", () => requestShutdown("SIGTERM"))

await telegram.deleteWebhook()
await finalVoice.start()
await telegramPolling.syncCommandMenu()
await controlMenu.start()
await updateManager.start()
await cleanupUploads(config.paths.uploadsDir, config.attachments.cleanupAfterMs).catch(logError)
setInterval(() => cleanupUploads(config.paths.uploadsDir, config.attachments.cleanupAfterMs).catch(logError), 60 * 60 * 1000).unref?.()
startArtifactGateway({ config, state, telegram, signal: abort.signal })
console.log(`[opencodebot] starting ${config.opencode.servers.length} OpenCodez event streams`)

for (const server of config.opencode.servers) {
  opencode.subscribeEvents(server.id, sessionReconciler.handleOpenCodeEvent, abort.signal, {
    onConnected: () => questionManager.reconcileServer(server.id),
  })
}

questionManager.reconcile().catch(logError)
sessionReconciler.reconcileLoop().catch(logError)

await telegramPolling.poll({ shouldStop: () => shutdownRequested })
await state.flushDeferred?.()

async function createPendingTopic(message, args) {
  let parsed
  try {
    parsed = parseNewTopicArgs(args, {
      servers: opencode.servers,
      defaultServerID: config.defaultPrompt.serverID,
      promptProfiles: config.promptProfiles,
    })
  } catch (error) {
    await telegram.sendMessage({ chatId: message.chat.id, topicId: message.message_thread_id, text: escapeHtml(error.message) })
    return
  }
  const { serverID, title, titleSource, promptProfileName, promptProfile, directory: requestedDirectory } = parsed
  const directory = requestedDirectory || opencode.defaultNewSessionDirectory(serverID)
  const chatId = state.chatId || message.chat.id
  const topicIcon = await randomTopicIcon()
  const titleFields = managedTopicTitle(title, serverID, opencode.servers)
  const topic = await telegram.createForumTopic({ chatId, name: titleFields.topicTitle, iconCustomEmojiId: topicIcon?.customEmojiId })
  await state.addPendingTopic(topic.message_thread_id, { serverID, ...titleFields, topicIconCustomEmojiId: topic.icon_custom_emoji_id || topicIcon?.customEmojiId, topicIconEmoji: topicIcon?.emoji, title: titleFields.topicBaseTitle, titleSource, promptProfileName, promptProfile, directory })
  const suffix = promptProfileName ? t("topic.profileSuffix", { profileHtml: escapeHtml(promptProfileName) }) : ""
  const directoryLine = directory ? t("topic.directoryLine", { directoryHtml: escapeHtml(directory) }) : ""
  await telegram.sendMessage({
    chatId,
    topicId: topic.message_thread_id,
    text: t("topic.created", { serverHtml: escapeHtml(serverID), suffix, directoryLine }),
  })
  return topic
}

function logError(error) {
  console.error(`[opencodebot] ${error.stack || error.message || error}`)
}

function requestShutdown(signalName) {
  if (shutdownRequested) return
  shutdownRequested = true
  console.info(`[opencodebot] received ${signalName}, shutting down`)
  updateManager.stop()
  finalVoice.stop()
  abort.abort()
  setTimeout(() => {
    console.info("[opencodebot] shutdown grace elapsed, exiting")
    process.exit(0)
  }, 2000).unref?.()
}
