import { logErrorEvent, logInfo, logWarn } from "./logger.mjs"

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
    return [
      "Final Voice:",
      "/tts — toggle automatic voice globally",
      "/tts status — current configuration",
      "/tts help — all voice commands",
      "/speak — reply to a message and voice its summary",
    ].join("\n")
  }

  helpText() {
    return [
      "🎙️ Final Voice",
      "",
      "/tts — включить или выключить автоозвучку глобально",
      "/tts on|off — включить или выключить явно",
      "/tts status — показать состояние",
      "/tts prompt — показать промпт",
      "/tts prompt <текст> — изменить общий промпт",
      "/tts prompt reset — вернуть промпт по умолчанию",
      "/tts voice [имя] — показать или выбрать голос",
      "/tts engine [имя] — показать или выбрать TTS-профиль",
      "/tts minlength [число] — минимальная длина финала",
      "/tts intro [текст|off|reset] — вступительная фраза",
      "/speak — ответьте этой командой на текст для ручной озвучки",
      "",
      "Старые команды /озвучка, /промпт, /голос, /движок, /минимум, /стартовый, /озвучь и их английские аналоги тоже работают.",
    ].join("\n")
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
    return this.reply(message, "Неизвестная подкоманда. Используйте /tts help.")
  }

  async setGlobalEnabled(message, enabled) {
    if (enabled && !this.config.enabled) {
      return this.reply(message, "Final Voice выключен оператором в конфигурации deployment.")
    }
    const readiness = this.readiness(this.settings().profile)
    if (enabled && !readiness.ready) {
      return this.reply(message, `Final Voice пока не готов: ${readiness.reason}.`)
    }
    await this.patchSettings({ enabled })
    return this.reply(message, enabled
      ? "🔊 Автоозвучка включена глобально."
      : "🔇 Автоозвучка выключена глобально.")
  }

  async sendStatus(message) {
    const settings = this.settings()
    const profile = this.config.tts.profiles[settings.profile]
    const readiness = this.readiness(settings.profile)
    const promptMode = settings.promptOverride ? "настроен глобально" : "по умолчанию"
    const intro = settings.introTemplate ? "включено" : "выключено"
    const reasoning = this.config.summary.requestBody?.reasoning_effort || "не задан"
    const lines = [
      "🎙️ Final Voice",
      "",
      `Deployment: ${this.config.enabled ? "включён" : "выключен"}`,
      `Готовность: ${readiness.ready ? "готов" : `не готов — ${readiness.reason}`}`,
      `Автоозвучка: ${settings.enabled ? "включена глобально" : "выключена глобально"}`,
      `Summary: ${this.config.summary.model}`,
      `Reasoning: ${reasoning}`,
      `TTS-профиль: ${settings.profile}${profile?.label ? ` — ${profile.label}` : ""}`,
      `Модель: ${profile?.model || "не настроена"}`,
      `Голос: ${settings.voice || "не настроен"}`,
      `Минимум: ${settings.minFinalChars} символов`,
      `Промпт: ${promptMode}`,
      `Вступление: ${intro}`,
      `Очередь: ${this.active} выполняется, ${this.pending.length} ожидает`,
    ]
    if (this.lastError) lines.push(`Последняя ошибка: ${this.lastError}`)
    return this.reply(message, lines.join("\n"))
  }

  async handlePrompt(message, args) {
    const value = String(args || "").trim()
    if (!value) {
      const settings = this.settings()
      const label = settings.promptOverride ? "Общий промпт" : "Промпт по умолчанию"
      return this.reply(message, `${label}:\n\n${clampText(settings.prompt, 3400)}`)
    }
    if (["reset", "сброс"].includes(value.toLowerCase())) return this.resetPrompt(message)
    if (value.length > 12_000) return this.reply(message, "Промпт слишком длинный. Максимум — двенадцать тысяч символов.")
    await this.patchSettings({ prompt: value })
    return this.reply(message, "✅ Общий промпт обновлён для всех топиков.")
  }

  async resetPrompt(message) {
    await this.patchSettings({ prompt: null })
    return this.reply(message, "✅ Для всех топиков используется промпт по умолчанию.")
  }

  async handleVoice(message, args) {
    const settings = this.settings()
    const profile = this.config.tts.profiles[settings.profile]
    if (!profile) return this.reply(message, "Текущий TTS-профиль не найден в конфигурации.")
    const requested = String(args || "").trim().toLowerCase()
    if (!requested) return this.reply(message, `Доступные голоса: ${profile.voices.join(", ")}\nСейчас: ${settings.voice}`)
    const voice = profile.voices.find((item) => item.toLowerCase() === requested)
    if (!voice) return this.reply(message, `Неизвестный голос. Доступны: ${profile.voices.join(", ")}`)
    await this.patchSettings({ voice })
    return this.reply(message, `✅ Голос ${voice} выбран глобально.`)
  }

  async handleEngine(message, args) {
    const settings = this.settings()
    const requested = String(args || "").trim().toLowerCase()
    const profileIDs = Object.keys(this.config.tts.profiles)
    if (!requested) return this.reply(message, `Доступные TTS-профили: ${profileIDs.join(", ")}\nСейчас: ${settings.profile}`)
    const profile = this.config.tts.profiles[requested]
    if (!profile) return this.reply(message, `Профиль не настроен. Доступны: ${profileIDs.join(", ")}`)
    await this.patchSettings({ profile: requested, voice: profile.defaultVoice })
    return this.reply(message, `✅ TTS-профиль ${requested} и голос ${profile.defaultVoice} выбраны глобально.`)
  }

  async handleMinLength(message, args) {
    const value = String(args || "").trim()
    if (!value) return this.reply(message, `Сейчас глобально: ${this.settings().minFinalChars} символов.`)
    if (!/^\d+$/.test(value)) return this.reply(message, "Укажите целое число от ста до ста тысяч.")
    const minFinalChars = Number(value)
    if (minFinalChars < 100 || minFinalChars > 100_000) return this.reply(message, "Допустимый диапазон: от ста до ста тысяч символов.")
    await this.patchSettings({ minFinalChars })
    return this.reply(message, `✅ Глобальная минимальная длина финала: ${minFinalChars} символов.`)
  }

  async handleIntro(message, args) {
    const value = String(args || "").trim()
    const settings = this.settings()
    if (!value) return this.reply(message, settings.introTemplate
      ? `Текущее вступление:\n${settings.introTemplate}`
      : "Вступительная фраза выключена.")
    if (["off", "выкл", "выключить"].includes(value.toLowerCase())) {
      await this.patchSettings({ introTemplate: "" })
      return this.reply(message, "✅ Вступительная фраза выключена глобально.")
    }
    if (["reset", "сброс"].includes(value.toLowerCase())) {
      await this.patchSettings({ introTemplate: null })
      return this.reply(message, "✅ Для всех топиков восстановлено вступление по умолчанию.")
    }
    if (value.length > 1_000) return this.reply(message, "Вступление слишком длинное. Максимум — тысяча символов.")
    await this.patchSettings({ introTemplate: value })
    return this.reply(message, "✅ Общая вступительная фраза обновлена для всех топиков.")
  }

  async handleSteps(message) {
    return this.reply(message, "Параметр «шаги» сохранён как совместимая команда, но OpenAI-compatible Silero его не использует.")
  }

  async handleSpeak(message) {
    if (!this.config.enabled) return this.reply(message, "Final Voice выключен оператором в конфигурации deployment.")
    const source = message.reply_to_message
    const text = String(source?.text || source?.caption || "").trim()
    if (!source?.message_id || !text) return this.reply(message, "Ответьте командой /speak или /озвучь на текстовое сообщение.")
    const settings = this.settings()
    const readiness = this.readiness(settings.profile)
    if (!readiness.ready) return this.reply(message, `Final Voice пока не готов: ${readiness.reason}.`)
    const key = `manual:${message.chat.id}:${message.message_id}`
    if (this.wasSent(key) || this.inFlight.has(key)) return this.reply(message, "Это сообщение уже поставлено на озвучку.")
    if (this.pending.length >= this.config.queue.maxPending) return this.reply(message, "Очередь озвучки заполнена. Попробуйте чуть позже.")
    const status = await this.reply(message, "🎙️ Готовлю краткую озвучку…")
    const binding = this.bindingFor(message.chat.id, message.message_thread_id)
    const queued = this.enqueueJob({
      key,
      kind: "manual",
      input: text,
      chatId: message.chat.id,
      topicId: message.message_thread_id,
      replyToMessageId: source.message_id,
      serverID: binding?.serverID,
      settings,
      statusMessageId: status?.message_id,
    })
    if (!queued && status?.message_id) {
      await this.telegram.editMessageText({
        chatId: message.chat.id,
        messageId: status.message_id,
        text: "❌ Не удалось поставить озвучку в очередь. Попробуйте чуть позже.",
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
        text: "❌ Не удалось подготовить озвучку. Текстовое сообщение не затронуто; попробуйте ещё раз позже.",
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
    const intro = template
      .replaceAll("{topicname}", binding?.topicTitle || "топика Оупенкод")
      .replaceAll("{server}", binding?.serverID || job.serverID || "основном сервере")
      .trim()
    return intro ? `${intro}\n\n${summary}` : summary
  }

  readiness(profileID) {
    if (!this.summaryReady()) return { ready: false, reason: `не задан ${this.config.summary.apiKeyEnv}` }
    const profile = this.config.tts.profiles[profileID]
    if (!profile) return { ready: false, reason: "не найден TTS-профиль" }
    if (!profile.baseURL || !profile.model || !profile.defaultVoice) return { ready: false, reason: "TTS-профиль настроен не полностью" }
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
    return Object.values(this.state.data.bindings || {}).find((binding) => (
      String(binding.chatId) === String(chatId) && String(binding.topicId) === String(topicId)
    ))
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
  if (error?.name === "AbortError") return "таймаут или остановка запроса"
  return String(error?.message || "неизвестная ошибка").slice(0, 160)
}
