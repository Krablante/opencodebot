import { logErrorEvent, logInfo, logWarn } from "./logger.mjs"
import { t } from "./i18n/index.mjs"
import { messageText, topicId } from "./telegram.mjs"
import { normalizeTelegramRichMessage } from "./telegram-rich-message.mjs"

const FINAL_VOICE_STATE_LIMIT = 512
const TELEGRAM_TEXT_LIMIT = 3900

export class FinalVoiceModule {
  constructor({ config, state, telegram, signal }) {
    this.config = config
    this.state = state
    this.telegram = telegram
    this.pending = []
    this.inFlight = new Set()
    this.active = 0
    this.controllers = new Set()
    this.stopping = false
    this.lastError = null
    signal?.addEventListener("abort", () => this.stop(), { once: true })
  }

  async start() {
    await this.state.update((data) => {
      if (isFinalVoiceState(data.finalVoice)) return false
      data.finalVoice = normalizeFinalVoiceState(data.finalVoice)
    })
    logInfo("final_voice.ready", {
      enabled: this.config.enabled,
      profiles: Object.keys(this.config.tts.profiles).join(","),
      summaryConfigured: this.summaryReady(),
    })
  }

  stop() {
    if (this.stopping) return
    this.stopping = true
    this.pending = []
    for (const controller of this.controllers) controller.abort()
  }

  enqueueAutomatic(details = {}) {
    if (!this.config.enabled || this.stopping) return false
    const finalText = String(details.finalText || "").trim()
    if (!finalText) return false
    const settings = this.settings()
    if (!settings.enabled || finalText.length < settings.minFinalChars) return false
    const key = `final:${details.serverID}:${details.sessionID}:${details.assistantMessageID}`
    return this.enqueueJob({
      key,
      kind: "automatic",
      input: finalText,
      chatId: details.telegramChatID,
      topicId: details.telegramTopicID,
      replyToMessageId: details.telegramFinalMessageID,
      serverID: details.serverID,
      topicTitle: details.telegramTopicTitle,
      settings,
    })
  }

  commandHandlers() {
    return {
      tts: (message, args) => this.handleTTS(message, args),
      озвучка: (message, args) => this.handleTTS(message, args),
      status: (message) => this.sendStatus(message),
      статус: (message) => this.sendStatus(message),
      prompt: (message, args) => this.handlePrompt(message, args),
      промпт: (message, args) => this.handlePrompt(message, args),
      prompt_reset: (message) => this.resetPrompt(message),
      промпт_сброс: (message) => this.resetPrompt(message),
      voice: (message, args) => this.handleVoice(message, args),
      голос: (message, args) => this.handleVoice(message, args),
      engine: (message, args) => this.handleEngine(message, args),
      движок: (message, args) => this.handleEngine(message, args),
      minlength: (message, args) => this.handleMinLength(message, args),
      минимум: (message, args) => this.handleMinLength(message, args),
      steps: (message) => this.handleSteps(message),
      шаги: (message) => this.handleSteps(message),
      intro: (message, args) => this.handleIntro(message, args),
      стартовый: (message, args) => this.handleIntro(message, args),
      speak: (message) => this.handleSpeak(message),
      озвучь: (message) => this.handleSpeak(message),
      помощь: (message) => this.reply(message, this.helpText()),
    }
  }

  helpSummary() {
    return t("finalVoice.helpSummary")
  }

  helpText() {
    return t("finalVoice.help")
  }

  async handleTTS(message, args) {
    const tokens = splitArgs(args)
    const action = String(tokens.shift() || "").toLowerCase()
    if (!action) return this.setGlobalEnabled(message, !this.settings().enabled)
    if (["on", "enable", "вкл", "включить"].includes(action)) return this.setGlobalEnabled(message, true)
    if (["off", "disable", "выкл", "выключить"].includes(action)) return this.setGlobalEnabled(message, false)
    if (["status", "статус"].includes(action)) return this.sendStatus(message)
    if (["help", "помощь"].includes(action)) return this.reply(message, this.helpText())
    if (["prompt", "промпт"].includes(action)) return this.handlePrompt(message, tokens.join(" "))
    if (["voice", "голос"].includes(action)) return this.handleVoice(message, tokens.join(" "))
    if (["engine", "движок"].includes(action)) return this.handleEngine(message, tokens.join(" "))
    if (["minlength", "minimum", "минимум"].includes(action)) return this.handleMinLength(message, tokens.join(" "))
    if (["intro", "стартовый"].includes(action)) return this.handleIntro(message, tokens.join(" "))
    if (["steps", "шаги"].includes(action)) return this.handleSteps(message)
    return this.reply(message, t("finalVoice.unknownSubcommand"))
  }

  async setGlobalEnabled(message, enabled) {
    if (enabled && !this.config.enabled) {
      return this.reply(message, t("finalVoice.deploymentDisabled"))
    }
    const readiness = this.readiness(this.settings().profile)
    if (enabled && !readiness.ready) {
      return this.reply(message, t("finalVoice.notReady", { reason: readiness.reason }))
    }
    await this.patchSettings({ enabled })
    return this.reply(message, t(enabled ? "finalVoice.automaticEnabled" : "finalVoice.automaticDisabled"))
  }

  async sendStatus(message) {
    const settings = this.settings()
    const profile = this.config.tts.profiles[settings.profile]
    const readiness = this.readiness(settings.profile)
    return this.reply(message, t("finalVoice.status", {
      deployment: t(this.config.enabled ? "common.enabled" : "common.disabled"),
      readiness: readiness.ready ? t("finalVoice.ready") : t("finalVoice.notReadyStatus", { reason: readiness.reason }),
      automatic: t(settings.enabled ? "finalVoice.globallyEnabled" : "finalVoice.globallyDisabled"),
      summary: this.config.summary.model,
      reasoning: this.config.summary.requestBody?.reasoning_effort || t("finalVoice.valueNotSet"),
      profile: `${settings.profile}${profile?.label ? ` — ${profile.label}` : ""}`,
      model: profile?.model || t("finalVoice.valueNotSet"),
      voice: settings.voice || t("finalVoice.valueNotSet"),
      minimum: settings.minFinalChars,
      prompt: t(settings.promptOverride ? "finalVoice.promptCustom" : "finalVoice.promptDefault"),
      intro: t(settings.introTemplate ? "common.enabled" : "common.disabled"),
      active: this.active,
      pending: this.pending.length,
      lastError: this.lastError,
    }))
  }

  async handlePrompt(message, args) {
    const value = String(args || "").trim()
    if (!value) {
      const settings = this.settings()
      const label = t(settings.promptOverride ? "finalVoice.promptTitleCustom" : "finalVoice.promptTitleDefault")
      return this.reply(message, `${label}:\n\n${clampText(settings.prompt, 3400)}`)
    }
    if (["reset", "сброс"].includes(value.toLowerCase())) return this.resetPrompt(message)
    if (value.length > 12_000) return this.reply(message, t("finalVoice.promptTooLong"))
    await this.patchSettings({ prompt: value })
    return this.reply(message, t("finalVoice.promptUpdated"))
  }

  async resetPrompt(message) {
    await this.patchSettings({ prompt: null })
    return this.reply(message, t("finalVoice.promptReset"))
  }

  async handleVoice(message, args) {
    const settings = this.settings()
    const profile = this.config.tts.profiles[settings.profile]
    if (!profile) return this.reply(message, t("finalVoice.profileMissing"))
    const requested = String(args || "").trim().toLowerCase()
    if (!requested) return this.reply(message, t("finalVoice.voices", { voices: profile.voices.join(", "), current: settings.voice }))
    const voice = profile.voices.find((item) => item.toLowerCase() === requested)
    if (!voice) return this.reply(message, t("finalVoice.voiceUnknown", { voices: profile.voices.join(", ") }))
    await this.patchSettings({ voice })
    return this.reply(message, t("finalVoice.voiceSelected", { voice }))
  }

  async handleEngine(message, args) {
    const settings = this.settings()
    const requested = String(args || "").trim().toLowerCase()
    const profileIDs = Object.keys(this.config.tts.profiles)
    if (!requested) return this.reply(message, t("finalVoice.profiles", { profiles: profileIDs.join(", "), current: settings.profile }))
    const profile = this.config.tts.profiles[requested]
    if (!profile) return this.reply(message, t("finalVoice.profileUnknown", { profiles: profileIDs.join(", ") }))
    await this.patchSettings({ profile: requested, voice: profile.defaultVoice })
    return this.reply(message, t("finalVoice.profileSelected", { profile: requested, voice: profile.defaultVoice }))
  }

  async handleMinLength(message, args) {
    const value = String(args || "").trim()
    if (!value) return this.reply(message, t("finalVoice.minimumCurrent", { value: this.settings().minFinalChars }))
    if (!/^\d+$/.test(value)) return this.reply(message, t("finalVoice.minimumInteger"))
    const minFinalChars = Number(value)
    if (minFinalChars < 100 || minFinalChars > 100_000) return this.reply(message, t("finalVoice.minimumRange"))
    await this.patchSettings({ minFinalChars })
    return this.reply(message, t("finalVoice.minimumUpdated", { value: minFinalChars }))
  }

  async handleIntro(message, args) {
    const value = String(args || "").trim()
    const settings = this.settings()
    if (!value) return this.reply(message, settings.introTemplate
      ? t("finalVoice.introCurrent", { value: settings.introTemplate })
      : t("finalVoice.introDisabled"))
    if (["off", "выкл", "выключить"].includes(value.toLowerCase())) {
      await this.patchSettings({ introTemplate: "" })
      return this.reply(message, t("finalVoice.introDisabledGlobally"))
    }
    if (["reset", "сброс"].includes(value.toLowerCase())) {
      await this.patchSettings({ introTemplate: null })
      return this.reply(message, t("finalVoice.introReset"))
    }
    if (value.length > 1_000) return this.reply(message, t("finalVoice.introTooLong"))
    await this.patchSettings({ introTemplate: value })
    return this.reply(message, t("finalVoice.introUpdated"))
  }

  async handleSteps(message) {
    return this.reply(message, t("finalVoice.stepsUnsupported"))
  }

  async handleSpeak(message) {
    if (!this.config.enabled) return this.reply(message, t("finalVoice.deploymentDisabled"))
    const source = message.reply_to_message
    const richContent = normalizeTelegramRichMessage(source?.rich_message)
    const text = String((source ? messageText(source, richContent) : "") || message.quote?.text || "").trim()
    if (!text) return this.reply(message, t("finalVoice.speakReplyRequired"))
    const settings = this.settings()
    const readiness = this.readiness(settings.profile)
    if (!readiness.ready) return this.reply(message, t("finalVoice.notReady", { reason: readiness.reason }))
    const key = `manual:${message.chat.id}:${message.message_id}`
    if (this.wasSent(key) || this.inFlight.has(key)) return this.reply(message, t("finalVoice.alreadyQueued"))
    if (this.pending.length >= this.config.queue.maxPending) return this.reply(message, t("finalVoice.queueFull"))
    const status = await this.reply(message, t("finalVoice.preparing"))
    const currentTopicId = topicId(message)
    const binding = this.bindingFor(message.chat.id, currentTopicId)
    const queued = this.enqueueJob({
      key,
      kind: "manual",
      input: text,
      chatId: message.chat.id,
      topicId: currentTopicId,
      replyToMessageId: source?.message_id || message.message_id,
      serverID: binding?.serverID,
      topicTitle: binding?.topicTitle || binding?.title || message.external_reply?.chat?.title || message.chat?.title,
      settings,
      statusMessageId: status?.message_id,
    })
    if (!queued && status?.message_id) {
      await this.telegram.editMessageText({
        chatId: message.chat.id,
        messageId: status.message_id,
        text: t("finalVoice.queueFailed"),
        format: "plain",
      }).catch(() => undefined)
    }
  }

  enqueueJob(job) {
    if (this.stopping || this.wasSent(job.key) || this.inFlight.has(job.key)) return false
    const readiness = this.readiness(job.settings.profile)
    if (!readiness.ready) {
      logWarn("final_voice.skipped", { key: job.key, reason: readiness.reason })
      return false
    }
    if (this.pending.length >= this.config.queue.maxPending) {
      logWarn("final_voice.queue_full", { key: job.key, pending: this.pending.length })
      return false
    }
    this.inFlight.add(job.key)
    this.pending.push(job)
    logInfo("final_voice.queued", { key: job.key, kind: job.kind, pending: this.pending.length })
    queueMicrotask(() => this.drain())
    return true
  }

  drain() {
    while (!this.stopping && this.active < this.config.queue.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()
      this.active += 1
      this.runJob(job)
        .catch((error) => this.failJob(job, error))
        .finally(() => {
          this.active -= 1
          this.inFlight.delete(job.key)
          this.drain()
        })
    }
  }

  async runJob(job) {
    const startedAt = Date.now()
    const profile = this.config.tts.profiles[job.settings.profile]
    const summary = await this.createSummary(job.input, job.settings.prompt)
    const speechText = this.withIntro(summary, job)
    const audio = await this.createSpeech(speechText, profile, job.settings.voice)
    const sent = await this.telegram.sendVoice({
      chatId: job.chatId,
      topicId: job.topicId,
      replyToMessageId: job.replyToMessageId,
      bytes: audio.bytes,
      filename: `final-voice-${Date.now()}.${audio.extension}`,
      contentType: audio.contentType,
    })
    await this.markSent(job.key, sent?.message_id)
    if (job.statusMessageId) {
      await this.telegram.deleteMessage({ chatId: job.chatId, messageId: job.statusMessageId, suppressFailureLog: true }).catch(() => undefined)
    }
    this.lastError = null
    logInfo("final_voice.sent", {
      key: job.key,
      kind: job.kind,
      summaryChars: summary.length,
      audioBytes: audio.bytes.length,
      elapsedMs: Date.now() - startedAt,
    })
  }

  async failJob(job, error) {
    this.lastError = friendlyError(error)
    logErrorEvent("final_voice.failed", error, { key: job.key, kind: job.kind })
    if (job.statusMessageId) {
      await this.telegram.editMessageText({
        chatId: job.chatId,
        messageId: job.statusMessageId,
        text: t("finalVoice.jobFailed"),
        format: "plain",
      }).catch(() => undefined)
    }
  }

  async createSummary(input, prompt) {
    const config = this.config.summary
    const controller = this.requestController(config.timeoutMs)
    try {
      const response = await fetch(joinEndpoint(config.baseURL, "chat/completions"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...config.requestBody,
          model: config.model,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: clampInput(input, config.maxInputChars) },
          ],
          stream: false,
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Summary provider returned HTTP ${response.status}`)
      const bytes = await readLimited(response, config.maxResponseBytes)
      let payload
      try {
        payload = JSON.parse(bytes.toString("utf8"))
      } catch {
        throw new Error("Summary provider returned invalid JSON")
      }
      const content = payload?.choices?.[0]?.message?.content
      const summary = normalizeSummary(content, config.maxOutputChars)
      if (!summary) throw new Error("Summary provider returned empty content")
      return summary
    } finally {
      this.releaseController(controller)
    }
  }

  async createSpeech(input, profile, voice) {
    const controller = this.requestController(profile.timeoutMs)
    try {
      const headers = { "content-type": "application/json" }
      if (profile.apiKey) headers.authorization = `Bearer ${profile.apiKey}`
      const response = await fetch(joinEndpoint(profile.baseURL, "audio/speech"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: profile.model,
          input,
          voice,
          response_format: profile.responseFormat,
          speed: profile.speed,
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`TTS provider returned HTTP ${response.status}`)
      const bytes = await readLimited(response, profile.maxResponseBytes)
      return validateAudio(bytes, response.headers.get("content-type"), profile.responseFormat)
    } finally {
      this.releaseController(controller)
    }
  }

  requestController(timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("Provider request timed out")), timeoutMs)
    timer.unref?.()
    controller.timeout = timer
    this.controllers.add(controller)
    return controller
  }

  releaseController(controller) {
    clearTimeout(controller.timeout)
    this.controllers.delete(controller)
  }

  withIntro(summary, job) {
    const template = job.settings.introTemplate
    if (!template) return summary
    const binding = this.bindingFor(job.chatId, job.topicId)
    const topicName = job.topicTitle || binding?.topicTitle || binding?.title || "топика Оупенкод"
    const serverID = job.serverID || binding?.serverID || "основном сервере"
    const intro = template
      .replaceAll("{topicname}", topicName)
      .replaceAll("{server}", serverID)
      .trim()
    return intro ? `${intro}\n\n${summary}` : summary
  }

  readiness(profileID) {
    if (!this.summaryReady()) return { ready: false, reason: t("finalVoice.reason.missingKey", { env: this.config.summary.apiKeyEnv }) }
    const profile = this.config.tts.profiles[profileID]
    if (!profile) return { ready: false, reason: t("finalVoice.reason.profileMissing") }
    if (!profile.baseURL || !profile.model || !profile.defaultVoice) return { ready: false, reason: t("finalVoice.reason.profileIncomplete") }
    return { ready: true }
  }

  summaryReady() {
    return Boolean(this.config.summary.baseURL && this.config.summary.model && this.config.summary.apiKey)
  }

  settings() {
    const override = this.store().settings
    const profileID = this.config.tts.profiles[override.profile]
      ? override.profile
      : this.config.tts.defaultProfile
    const profile = this.config.tts.profiles[profileID]
    const voice = profile?.voices.includes(override.voice) ? override.voice : profile?.defaultVoice
    const promptOverride = typeof override.prompt === "string" && override.prompt.trim() ? override.prompt.trim() : null
    const introTemplate = override.introTemplate === null || override.introTemplate === undefined
      ? this.config.defaults.introTemplate
      : String(override.introTemplate)
    return {
      enabled: typeof override.enabled === "boolean" ? override.enabled : this.config.defaults.enabled,
      profile: profileID,
      voice,
      minFinalChars: Number.isInteger(override.minFinalChars) ? override.minFinalChars : this.config.defaults.minFinalChars,
      promptOverride,
      prompt: promptOverride || this.config.summary.defaultPrompt,
      introTemplate,
    }
  }

  async patchSettings(patch) {
    await this.state.update((data) => {
      data.finalVoice = normalizeFinalVoiceState(data.finalVoice)
      const next = { ...data.finalVoice.settings, ...patch }
      for (const [field, value] of Object.entries(next)) {
        if (value === null || value === undefined) delete next[field]
      }
      data.finalVoice.settings = next
    })
  }

  bindingFor(chatId, topicId) {
    return this.state.findBindingByTopic(chatId, topicId) || this.state.findAnyBindingByTopic(chatId, topicId)
  }

  store() {
    if (!isFinalVoiceState(this.state.data.finalVoice)) this.state.data.finalVoice = normalizeFinalVoiceState(this.state.data.finalVoice)
    return this.state.data.finalVoice
  }

  wasSent(key) {
    return this.store().sent.some((item) => item.key === key)
  }

  async markSent(key, telegramMessageId) {
    await this.state.update((data) => {
      data.finalVoice = normalizeFinalVoiceState(data.finalVoice)
      data.finalVoice.sent = [
        ...data.finalVoice.sent.filter((item) => item.key !== key),
        { key, telegramMessageId, sentAt: new Date().toISOString() },
      ].slice(-FINAL_VOICE_STATE_LIMIT)
    })
  }

  async reply(message, text) {
    return this.telegram.replyMessage({
      chatId: message.chat.id,
      topicId: message.message_thread_id,
      replyToMessageId: message.message_id,
      text: clampText(text, TELEGRAM_TEXT_LIMIT),
      format: "plain",
    })
  }
}

function normalizeFinalVoiceState(value) {
  return {
    settings: isObject(value?.settings) ? value.settings : migrateTopicSettings(value?.topics),
    sent: Array.isArray(value?.sent) ? value.sent.filter((item) => item?.key).slice(-FINAL_VOICE_STATE_LIMIT) : [],
  }
}

function isFinalVoiceState(value) {
  return value && isObject(value.settings) && Array.isArray(value.sent) && !Object.hasOwn(value, "topics")
}

function migrateTopicSettings(topics) {
  if (!isObject(topics)) return {}
  const overrides = Object.values(topics).filter(isObject)
  const settings = {}
  if (overrides.some((item) => item.enabled === true)) settings.enabled = true
  else if (overrides.some((item) => item.enabled === false)) settings.enabled = false
  for (const field of ["prompt", "profile", "voice", "minFinalChars", "introTemplate"]) {
    const source = overrides.find((item) => Object.hasOwn(item, field))
    if (source) settings[field] = source[field]
  }
  return settings
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function splitArgs(value) {
  return String(value || "").trim().split(/\s+/u).filter(Boolean)
}

function joinEndpoint(baseURL, path) {
  const base = String(baseURL || "").replace(/\/+$/, "")
  const suffix = String(path || "").replace(/^\/+/, "")
  return `${base}/${suffix}`
}

function clampInput(value, maxChars) {
  const text = String(value || "")
  if (text.length <= maxChars) return text
  const beginning = Math.floor(maxChars * 0.8)
  const ending = maxChars - beginning
  return `${text.slice(0, beginning)}\n\n[середина ответа опущена из-за ограничения длины]\n\n${text.slice(-ending)}`
}

function normalizeSummary(value, maxChars) {
  let text = String(value || "")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/!?(?:\[([^\]]+)\])\([^\s)]+\)/gu, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gmu, "")
    .replace(/[\t ]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
  if (text.length <= maxChars) return text
  const candidate = text.slice(0, maxChars)
  const boundary = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("! "), candidate.lastIndexOf("? "), candidate.lastIndexOf("\n"))
  text = boundary >= Math.floor(maxChars * 0.6) ? candidate.slice(0, boundary + 1) : candidate
  return text.trim()
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0)
  if (declared > maxBytes) throw new Error(`Provider response exceeds ${maxBytes} bytes`)
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxBytes) throw new Error(`Provider response exceeds ${maxBytes} bytes`)
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`Provider response exceeds ${maxBytes} bytes`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

function validateAudio(bytes, rawContentType, requestedFormat) {
  const contentType = String(rawContentType || "").split(";", 1)[0].trim().toLowerCase()
  const format = String(requestedFormat || "").toLowerCase()
  if (format === "opus" || format === "ogg") {
    if (!["audio/ogg", "audio/opus", "application/ogg"].includes(contentType)) throw new Error(`Unexpected TTS content type: ${contentType || "missing"}`)
    if (bytes.subarray(0, 4).toString("ascii") !== "OggS" || bytes.indexOf(Buffer.from("OpusHead")) === -1) throw new Error("TTS response is not OGG/Opus audio")
    return { bytes, contentType: "audio/ogg", extension: "ogg" }
  }
  if (format === "mp3") {
    const isMP3 = bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    if (contentType !== "audio/mpeg" || !isMP3) throw new Error("TTS response is not MP3 audio")
    return { bytes, contentType: "audio/mpeg", extension: "mp3" }
  }
  if (["m4a", "aac"].includes(format)) {
    const isMP4 = bytes.subarray(4, 8).toString("ascii") === "ftyp"
    if (!["audio/mp4", "audio/x-m4a", "audio/aac"].includes(contentType) || !isMP4) throw new Error("TTS response is not M4A audio")
    return { bytes, contentType: "audio/mp4", extension: "m4a" }
  }
  throw new Error(`Unsupported TTS response format: ${format}`)
}

function clampText(value, maxChars) {
  const text = String(value || "")
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars - 24)}\n\n…текст сокращён…`
}

function friendlyError(error) {
  if (error?.name === "AbortError") return t("finalVoice.error.aborted")
  return String(error?.message || t("finalVoice.error.unknown")).slice(0, 160)
}
