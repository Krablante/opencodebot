import { assertRuntimeConfig, loadConfig } from "./config.mjs"
import { startArtifactGateway } from "./artifacts-gateway.mjs"
import { ArtifactUploadBuffer, handleArtifactUploadMessage } from "./artifact-uploads.mjs"
import { cleanupUploads, extractTelegramFiles } from "./attachments.mjs"
import { createBackendRequester } from "./backend-backoff.mjs"
import { createTelegramCommandHandlers, telegramBotCommands } from "./commands.mjs"
import { createFinalNotifier } from "./final-notifications.mjs"
import { FinalVoiceModule } from "./final-voice.mjs"
import { ControlMenu } from "./control-menu.mjs"
import { configureI18n, setLanguage } from "./i18n/index.mjs"
import { OpenCodeClient } from "./opencode.mjs"
import { createPromptRouter } from "./prompt-routing.mjs"
import { createQuestionManager } from "./questions.mjs"
import { MirrorRenderer } from "./render.mjs"
import { createRunAlerter } from "./run-alerts.mjs"
import { createSessionReconciler } from "./session-reconcile.mjs"
import { SpeechModule } from "./speech/index.mjs"
import { StateStore } from "./state.mjs"
import { TelegramClient } from "./telegram.mjs"
import { createTelegramPolling } from "./telegram-polling.mjs"
import { createTopicLifecycle } from "./topic-lifecycle.mjs"
import { createUpdateManager } from "./update-manager.mjs"
import { createRuntimeHealth } from "./runtime-health.mjs"
import { setMaxListeners } from "node:events"
import { UserSettings } from "./user-settings.mjs"
import { LaunchMenu } from "./launch-menu.mjs"
import { Setup } from "./setup.mjs"

const config = loadConfig()
assertRuntimeConfig(config)

const state = new StateStore(config.paths.statePath)
await state.load({ promptProfiles: config.promptProfiles })
configureI18n({ state, defaultLanguage: config.ui.defaultLanguage })
if (config.telegram.chatId && !state.chatId) await state.setChatId(config.telegram.chatId)

const abort = new AbortController()
setMaxListeners(0, abort.signal)
const health = createRuntimeHealth(config)
const telegram = new TelegramClient(config.telegram.token, { ...config.telegram.botApi, signal: abort.signal })
let artifactGateway
const botInfo = await telegram.getMe()
const opencode = new OpenCodeClient(config, { signal: abort.signal })
const settings = new UserSettings({ config, state, opencode })
await settings.initialize()
const finalNotifier = createFinalNotifier({ config, state, telegram, opencode })
const notifyFinalAnswerReady = finalNotifier.notifyFinalAnswerReady
let promptRouter
let finalVoice
let sessionReconciler
const renderer = new MirrorRenderer({
  telegram,
  state,
  config,
  onMirrorMessage: async (...args) => {
    sessionReconciler?.clearRetryStatus(args[0])
    await promptRouter.clearPromptFeedback(...args)
  },
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
let controlMenu
promptRouter = createPromptRouter({
  signal: abort.signal,
  config,
  state,
  telegram,
  opencode,
  renderer,
  scheduleReconcile: (...args) => sessionReconciler.scheduleReconcile(...args),
  onBindingRemoved: (...args) => sessionReconciler?.detachBinding(...args),
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
  showPromptFeedback,
} = promptRouter
const topicLifecycle = createTopicLifecycle({ config, state, telegram, opencode, settings, activateBindingForPrompt, clearPromptFeedback })
const { createPendingTopic, createTopicForSession, createTopicForWebSession, handleTopicLifecycleMessage, isInternalSession, randomTopicIcon } = topicLifecycle
let shutdownRequested = false
const backendRequester = createBackendRequester()
const skippedBackendRequest = backendRequester.skipped
const backendRequest = backendRequester.request
const speech = new SpeechModule({ config: config.speech, telegram, state, uploadDir: config.paths.uploadsDir, attachmentSettings: config.attachments })
const setup = new Setup({ config, state, telegram, settings, speech, randomTopicIcon,
  enableGateway: () => { artifactGateway ||= startArtifactGateway({ config, state, telegram, signal: abort.signal }) },
  onReady: (message) => controlMenu.ensureMenu("home", message.from),
})
const launchMenu = new LaunchMenu({ config, state, telegram, opencode, settings, createSession: createPendingTopic })
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
  flushUpload: ({ message, files }) => handleArtifactUploadMessage({ telegram, config, opencode, message, files, signal: abort.signal }),
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
  backendRetryDelay: backendRequester.retryAfterMs,
  createTopicForSession,
  createTopicForWebSession,
  isInternalSession,
  activateBindingForPrompt,
  maybeExtendBindingActivity,
  clearPromptFeedback,
  showPromptFeedback,
  logError,
  shouldStop: () => shutdownRequested,
  onProgress: () => health.beat("reconcile"),
  onSessionStatusChange: (binding, status) => controlMenu?.observeStatus(binding, status),
})
let refreshCommandMenu = async () => {}
controlMenu = new ControlMenu({
  config,
  state,
  telegram,
  opencode,
  promptQueue,
  finalVoice,
  backendRequester,
  launchMenu,
  setup,
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
  notifyLatestManualCompaction: sessionReconciler.notifyLatestManualCompaction,
  speech,
  finalVoice,
  questionManager,
  updateManager,
  controlMenu,
  setup,
  launchMenu,
  settings,
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
artifactGateway = startArtifactGateway({ config, state, telegram, signal: abort.signal })
console.log(`[opencodebot] starting ${config.opencode.servers.length} OpenCodez event streams`)

for (const server of config.opencode.servers) {
  opencode.subscribeEvents(server.id, sessionReconciler.handleOpenCodeEvent, abort.signal, {
    onConnected: () => {
      questionManager.reconcileServer(server.id).catch(logError)
      sessionReconciler.recoverServerBindings(server.id).catch(logError)
    },
  })
}

questionManager.reconcile().catch(logError)
sessionReconciler.reconcileLoop().catch((error) => {
  logError(error)
  void requestShutdown("session recovery stopped", 1)
})

await telegramPolling.poll({ shouldStop: () => shutdownRequested, signal: abort.signal, onProgress: (inbox) => health.beat("telegram", inbox) })
  .catch(async (error) => {
    logError(error)
    await requestShutdown("Telegram inbox stopped", 1)
  })
await state.flushDeferred?.()

function logError(error) {
  console.error(`[opencodebot] ${error.stack || error.message || error}`)
}

async function requestShutdown(signalName, exitCode = 0) {
  if (shutdownRequested) return
  shutdownRequested = true
  process.exitCode = exitCode
  console.info(`[opencodebot] received ${signalName}, shutting down`)
  updateManager.stop()
  controlMenu.stop()
  finalVoice.stop()
  abort.abort()
  setTimeout(() => {
    console.info("[opencodebot] shutdown grace elapsed, exiting")
    process.exit(exitCode)
  }, 8000).unref?.()
  await Promise.allSettled([health.stop(), state.flushDeferred?.(), state.markerQueue])
}
