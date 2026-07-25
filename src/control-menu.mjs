import { getLanguage, t } from "./i18n/index.mjs"
import { logErrorEvent, logInfo, logWarn } from "./logger.mjs"
import { escapeHtml, telegramMessageLink, topicId } from "./telegram.mjs"

const CALLBACK_PREFIX = "panel:"
const INPUT_TTL_MS = 5 * 60 * 1000
const LINK_MESSAGE_TTL_MS = 30 * 1000
const MAX_VISIBLE_SESSIONS = 12
const MIN_LENGTH_OPTIONS = [0, 200, 300, 500, 1000, 2000]

export class ControlMenu {
  constructor({ config, state, telegram, promptQueue, finalVoice, createSession, refreshCommandMenu }) {
    this.config = config
    this.state = state
    this.telegram = telegram
    this.promptQueue = promptQueue
    this.finalVoice = finalVoice
    this.createSession = createSession
    this.refreshCommandMenu = refreshCommandMenu
    this.pendingInputs = new Map()
  }

  async start() {
    if (!this.chatId()) return null
    const existing = this.state.controlMenuMessage()
    const message = await this.ensureMenu("home")
    if (existing) await this.pinMenu(message?.message_id)
    return message
  }

  async open(message, page = "home") {
    const panel = await this.ensureMenu(page, message?.from)
    if (!panel?.message_id) return null
    if (this.isGeneralMessage(message)) {
      await this.deleteQuietly(message.chat?.id, message.message_id)
      return panel
    }

    const linkMessage = await this.telegram.replyMessage({
      message,
      text: t("controlMenu.opened"),
      replyMarkup: {
        inline_keyboard: [[{ text: t("controlMenu.button.open"), url: telegramMessageLink(this.chatId(), panel.message_id) }]],
      },
    })
    this.scheduleDelete(linkMessage?.chat?.id, linkMessage?.message_id)
    return panel
  }

  async handleCallback(query) {
    const data = String(query?.data || "")
    if (!data.startsWith(CALLBACK_PREFIX)) return false

    const current = this.state.controlMenuMessage()
    if (!current || String(query.message?.chat?.id) !== String(current.chatId) || Number(query.message?.message_id) !== Number(current.messageId)) {
      await this.answer(query, t("controlMenu.stale"), true)
      return true
    }

    const action = data.slice(CALLBACK_PREFIX.length)
    try {
      await this.dispatch(query, action)
    } catch (error) {
      logErrorEvent("control_menu.callback.failed", error, { action, userId: query.from?.id })
      await this.answer(query, t("controlMenu.error"), true).catch(() => {})
    }
    return true
  }

  async handleMessage(message) {
    const userId = String(message?.from?.id || "")
    const pending = this.pendingInputs.get(userId)
    if (!pending) return false
    if (pending.expiresAt < Date.now()) {
      this.pendingInputs.delete(userId)
      return false
    }
    if (String(message.chat?.id) !== String(this.chatId()) || Number(message.reply_to_message?.message_id) !== Number(pending.promptMessageId)) return false

    const value = String(message.text || message.caption || "").trim()
    if (value === "/cancel") {
      this.pendingInputs.delete(userId)
      await this.cleanInputMessages(message, pending)
      await this.editMenu(pending.returnPage, message.from)
      return true
    }
    if (!value) {
      await this.telegram.replyMessage({ message, text: t("controlMenu.input.empty") })
      return true
    }

    const maxLength = pending.field === "intro" ? 1000 : 4000
    if (value.length > maxLength) {
      await this.telegram.replyMessage({ message, text: t("controlMenu.input.tooLong", { max: maxLength }) })
      return true
    }

    if (pending.field === "prompt") await this.finalVoice.patchSettings({ prompt: value })
    if (pending.field === "intro") await this.finalVoice.patchSettings({ introTemplate: value })
    this.pendingInputs.delete(userId)
    await this.cleanInputMessages(message, pending)
    await this.editMenu(pending.returnPage, message.from)
    logInfo("control_menu.input.applied", { field: pending.field, userId })
    return true
  }

  async dispatch(query, action) {
    if (["home", "sessions", "new", "voice", "voice-advanced", "personal", "system", "help"].includes(action)) {
      await this.answer(query)
      await this.editMenu(action, query.from)
      return
    }
    if (action === "refresh") {
      await this.answer(query, t("controlMenu.refreshed"))
      await this.editMenu("home", query.from)
      return
    }
    if (action === "new:create") {
      await this.answer(query, t("controlMenu.new.creating"))
      await this.createSession({ ...query.message, from: query.from }, "")
      await this.editMenu("home", query.from)
      return
    }
    if (action.startsWith("voice:auto:")) {
      const enabled = action.endsWith(":1")
      if (enabled) {
        if (!this.finalVoice.config.enabled) return this.answer(query, t("controlMenu.voice.disabled"), true)
        const readiness = this.finalVoice.readiness(this.finalVoice.settings().profile)
        if (!readiness.ready) return this.answer(query, plainText(readiness.reason), true)
      }
      await this.finalVoice.patchSettings({ enabled })
      await this.answer(query, enabled ? t("controlMenu.enabled") : t("controlMenu.disabled"))
      await this.editMenu("voice", query.from)
      return
    }
    if (action.startsWith("voice:profile:")) {
      const profiles = this.voiceProfiles()
      const selected = profiles[Number(action.split(":").at(-1))]
      if (!selected) return this.answer(query, t("controlMenu.invalidChoice"), true)
      const currentVoice = this.finalVoice.settings().voice
      const voice = selected.voices.includes(currentVoice) ? currentVoice : selected.defaultVoice
      await this.finalVoice.patchSettings({ profile: selected.id, voice })
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenu("voice", query.from)
      return
    }
    if (action === "voice:profiles") {
      await this.answer(query)
      await this.editMenu("voice-profiles", query.from)
      return
    }
    if (action === "voice:voices") {
      await this.answer(query)
      await this.editMenu("voice-voices", query.from)
      return
    }
    if (action.startsWith("voice:voice:")) {
      const profile = this.currentVoiceProfile()
      const voice = profile.voices[Number(action.split(":").at(-1))]
      if (!voice) return this.answer(query, t("controlMenu.invalidChoice"), true)
      await this.finalVoice.patchSettings({ voice })
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenu("voice", query.from)
      return
    }
    if (action.startsWith("voice:min:")) {
      const value = Number(action.split(":").at(-1))
      if (!Number.isSafeInteger(value) || value < 0) return this.answer(query, t("controlMenu.invalidChoice"), true)
      await this.finalVoice.patchSettings({ minFinalChars: value })
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenu("voice-advanced", query.from)
      return
    }
    if (action === "voice:prompt:edit" || action === "voice:intro:edit") {
      const field = action.includes(":prompt:") ? "prompt" : "intro"
      await this.answer(query)
      await this.startInput(query, field)
      return
    }
    if (action === "voice:prompt:reset" || action === "voice:intro:reset") {
      const prompt = action.includes(":prompt:")
      await this.finalVoice.patchSettings(prompt ? { prompt: null } : { introTemplate: null })
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenu("voice-advanced", query.from)
      return
    }
    if (action.startsWith("notify:")) {
      await this.setNotifications(query, action.endsWith(":1"))
      return
    }
    if (action.startsWith("context:")) {
      const count = Number(action.split(":").at(-1))
      if (!Number.isInteger(count) || count < 1 || count > 10) return this.answer(query, t("controlMenu.invalidChoice"), true)
      await this.state.setContextTurnsForUser(query.from?.id, count)
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenu("personal", query.from)
      return
    }
    if (action.startsWith("mirror:")) {
      const enabled = action.endsWith(":1")
      await this.state.setMirrorEnabled(enabled)
      await this.answer(query, enabled ? t("controlMenu.enabled") : t("controlMenu.disabled"))
      await this.editMenu("system", query.from)
      return
    }
    if (action.startsWith("mode:")) {
      const mode = action.split(":").at(-1)
      if (!["full", "economy"].includes(mode)) return this.answer(query, t("controlMenu.invalidChoice"), true)
      await this.state.setMirrorMode(mode)
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenu("system", query.from)
      return
    }
    if (action.startsWith("lang:")) {
      const language = action.split(":").at(-1)
      if (!["en", "ru"].includes(language)) return this.answer(query, t("controlMenu.invalidChoice"), true)
      await this.refreshCommandMenu(language)
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenu("system", query.from)
      return
    }
    await this.answer(query, t("controlMenu.invalidChoice"), true)
  }

  async setNotifications(query, enabled) {
    const userId = Number(query.from?.id)
    if (!this.notificationConfigured(userId)) {
      await this.answer(query, t("controlMenu.personal.notificationsUnavailable"), true)
      return
    }
    if (enabled) {
      try {
        await this.telegram.sendMessage({ chatId: userId, text: t("controlMenu.personal.notificationsDm") })
      } catch {
        await this.answer(query, t("controlMenu.personal.notificationsFailed"), true)
        return
      }
    }
    await this.state.setFinalNotificationsEnabledFor(userId, enabled)
    await this.answer(query, enabled ? t("controlMenu.enabled") : t("controlMenu.disabled"))
    await this.editMenu("personal", query.from)
  }

  async startInput(query, field) {
    const prompt = await this.telegram.sendMessage({
      chatId: this.chatId(),
      topicId: 0,
      text: t(field === "prompt" ? "controlMenu.input.prompt" : "controlMenu.input.intro"),
      replyToMessageId: query.message.message_id,
      replyMarkup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: t("controlMenu.input.placeholder"),
      },
    })
    this.pendingInputs.set(String(query.from?.id), {
      field,
      promptMessageId: prompt.message_id,
      returnPage: "voice-advanced",
      expiresAt: Date.now() + INPUT_TTL_MS,
    })
  }

  async ensureMenu(page = "home", actor) {
    const existing = this.state.controlMenuMessage()
    if (existing && String(existing.chatId) === String(this.chatId())) {
      const rendered = this.render(page, actor)
      try {
        const edited = await this.telegram.editMessageText({
          chatId: existing.chatId,
          messageId: existing.messageId,
          text: rendered.text,
          replyMarkup: rendered.replyMarkup,
        })
        return edited || { chat: { id: existing.chatId }, message_id: existing.messageId }
      } catch (error) {
        if (isMessageNotModified(error)) return { chat: { id: existing.chatId }, message_id: existing.messageId }
        if (!isMissingMessage(error)) throw error
        await this.state.setControlMenuMessage()
      }
    }

    const rendered = this.render(page, actor)
    const sent = await this.telegram.sendMessage({
      chatId: this.chatId(),
      topicId: 0,
      text: rendered.text,
      replyMarkup: rendered.replyMarkup,
      disableWebPagePreview: true,
    })
    await this.state.setControlMenuMessage({ chatId: this.chatId(), messageId: sent.message_id })
    await this.pinMenu(sent.message_id)
    logInfo("control_menu.created", { chatId: this.chatId(), messageId: sent.message_id })
    return sent
  }

  async editMenu(page, actor) {
    const current = this.state.controlMenuMessage()
    if (!current) return this.ensureMenu(page, actor)
    const rendered = this.render(page, actor)
    try {
      return await this.telegram.editMessageText({
        chatId: current.chatId,
        messageId: current.messageId,
        text: rendered.text,
        replyMarkup: rendered.replyMarkup,
      })
    } catch (error) {
      if (isMessageNotModified(error)) return null
      if (isMissingMessage(error)) {
        await this.state.setControlMenuMessage()
        return this.ensureMenu(page, actor)
      }
      throw error
    }
  }

  render(page, actor) {
    if (page === "sessions") return this.renderSessions()
    if (page === "new") return this.renderNew()
    if (page === "voice") return this.renderVoice()
    if (page === "voice-advanced") return this.renderVoiceAdvanced()
    if (page === "voice-profiles") return this.renderVoiceProfiles()
    if (page === "voice-voices") return this.renderVoiceVoices()
    if (page === "personal") return this.renderPersonal(actor)
    if (page === "system") return this.renderSystem()
    if (page === "help") return this.renderHelp()
    return this.renderHome()
  }

  renderHome() {
    const bindings = this.activeBindings()
    const queued = bindings.reduce((total, binding) => total + this.promptQueue.status(binding).length, 0)
    const busy = bindings.filter((binding) => this.promptQueue.isBusy(binding)).length
    const settings = this.finalVoice.settings()
    const voiceEnabled = this.finalVoice.config.enabled && settings.enabled
    const mirrorEnabled = this.state.mirrorEnabled(this.config)
    const text = [
      t("controlMenu.title"),
      "",
      t("controlMenu.home.healthy"),
      t("controlMenu.home.sessions", { busy, queued }),
      t("controlMenu.home.voice", { value: this.stateLabel(voiceEnabled) }),
      t("controlMenu.home.mirror", { value: this.stateLabel(mirrorEnabled), mode: this.state.mirrorMode() }),
      t("controlMenu.home.language", { value: getLanguage().toUpperCase() }),
      "",
      t("controlMenu.updated", { time: this.updatedTime() }),
    ].join("\n")
    return this.view(text, [
      [this.callback(t("controlMenu.button.new"), "new"), this.callback(t("controlMenu.button.sessions"), "sessions")],
      [this.callback(t("controlMenu.button.voice"), "voice"), this.callback(t("controlMenu.button.personal"), "personal")],
      [this.callback(t("controlMenu.button.system"), "system"), this.callback(t("controlMenu.button.help"), "help")],
      [this.callback(t("controlMenu.button.refresh"), "refresh")],
    ])
  }

  renderSessions() {
    const bindings = this.activeBindings()
    const visible = bindings.slice(0, MAX_VISIBLE_SESSIONS)
    const lines = [t("controlMenu.sessions.title"), ""]
    if (!visible.length) lines.push(t("controlMenu.sessions.empty"))
    for (const binding of visible) {
      const queued = this.promptQueue.status(binding).length
      const status = this.promptQueue.isBusy(binding)
        ? t("controlMenu.sessions.busy")
        : queued
          ? t("controlMenu.sessions.queued", { count: queued })
          : t("controlMenu.sessions.idle")
      lines.push(t("controlMenu.sessions.item", {
        title: escapeHtml(bindingTitle(binding)),
        server: escapeHtml(binding.serverID || "?"),
        status,
      }))
    }
    if (bindings.length > visible.length) lines.push(t("controlMenu.sessions.more", { count: bindings.length - visible.length }))
    lines.push("", t("controlMenu.updated", { time: this.updatedTime() }))

    const links = visible.map((binding) => ({
      text: `↗ ${truncate(bindingTitle(binding), 28)}`,
      url: telegramMessageLink(binding.chatId, binding.topicId),
    }))
    return this.view(lines.join("\n"), [
      ...rows(links, 2),
      [this.callback(t("controlMenu.button.back"), "home"), this.callback(t("controlMenu.button.refresh"), "sessions")],
    ])
  }

  renderNew() {
    const server = escapeHtml(this.config.defaultPrompt?.serverID || "default")
    return this.view([
      t("controlMenu.new.title"),
      "",
      t("controlMenu.new.description", { server }),
      t("controlMenu.new.hint"),
    ].join("\n"), [
      [this.callback(t("controlMenu.new.create"), "new:create")],
      [this.callback(t("controlMenu.button.back"), "home")],
    ])
  }

  renderVoice() {
    const settings = this.finalVoice.settings()
    const profile = this.currentVoiceProfile()
    const readiness = this.finalVoice.readiness(settings.profile)
    const text = [
      t("controlMenu.voice.title"),
      t("controlMenu.scope.global"),
      "",
      t("controlMenu.voice.automatic", { value: this.stateLabel(this.finalVoice.config.enabled && settings.enabled) }),
      t("controlMenu.voice.profile", { value: escapeHtml(profile.id) }),
      t("controlMenu.voice.voice", { value: escapeHtml(settings.voice || profile.defaultVoice) }),
      t("controlMenu.voice.minimum", { value: settings.minFinalChars }),
      t("controlMenu.voice.readiness", { value: readiness.ready ? t("controlMenu.ready") : escapeHtml(plainText(readiness.reason)) }),
      "",
      t("controlMenu.voice.speakHint"),
    ].join("\n")
    const automaticEnabled = this.finalVoice.config.enabled && settings.enabled
    const buttons = [
      [this.callback(automaticEnabled ? t("controlMenu.button.disable") : t("controlMenu.button.enable"), `voice:auto:${automaticEnabled ? 0 : 1}`)],
    ]
    if (this.voiceProfiles().length > 1) buttons.push([this.callback(t("controlMenu.voice.chooseProfile"), "voice:profiles")])
    if (profile.voices.length > 1) buttons.push([this.callback(t("controlMenu.voice.chooseVoice"), "voice:voices")])
    buttons.push(
      [this.callback(t("controlMenu.voice.advanced"), "voice-advanced")],
      [this.callback(t("controlMenu.button.back"), "home"), this.callback(t("controlMenu.button.refresh"), "voice")],
    )
    return this.view(text, buttons)
  }

  renderVoiceAdvanced() {
    const settings = this.finalVoice.settings()
    const prompt = settings.prompt
    const intro = settings.introTemplate || t("controlMenu.voice.introDisabled")
    const options = [...new Set([...MIN_LENGTH_OPTIONS, settings.minFinalChars])].sort((a, b) => a - b)
    return this.view([
      t("controlMenu.voice.advancedTitle"),
      t("controlMenu.scope.global"),
      "",
      t("controlMenu.voice.minimum", { value: settings.minFinalChars }),
      t("controlMenu.voice.promptPreview", { value: escapeHtml(truncate(prompt, 180)) }),
      t("controlMenu.voice.introPreview", { value: escapeHtml(truncate(intro, 180)) }),
    ].join("\n"), [
      ...rows(options.map((value) => this.callback(`${value === settings.minFinalChars ? "✓ " : ""}${value}`, `voice:min:${value}`)), 3),
      [this.callback(t("controlMenu.voice.editPrompt"), "voice:prompt:edit"), this.callback(t("controlMenu.button.reset"), "voice:prompt:reset")],
      [this.callback(t("controlMenu.voice.editIntro"), "voice:intro:edit"), this.callback(t("controlMenu.button.reset"), "voice:intro:reset")],
      [this.callback(t("controlMenu.button.back"), "voice")],
    ])
  }

  renderVoiceProfiles() {
    const settings = this.finalVoice.settings()
    const buttons = this.voiceProfiles().map((profile, index) => [
      this.callback(`${profile.id === settings.profile ? "✓ " : ""}${profile.id}`, `voice:profile:${index}`),
    ])
    buttons.push([this.callback(t("controlMenu.button.back"), "voice")])
    return this.view([t("controlMenu.voice.profilesTitle"), "", t("controlMenu.voice.profilesHint")].join("\n"), buttons)
  }

  renderVoiceVoices() {
    const settings = this.finalVoice.settings()
    const buttons = this.currentVoiceProfile().voices.map((voice, index) => [
      this.callback(`${voice === settings.voice ? "✓ " : ""}${voice}`, `voice:voice:${index}`),
    ])
    buttons.push([this.callback(t("controlMenu.button.back"), "voice")])
    return this.view([t("controlMenu.voice.voicesTitle"), "", t("controlMenu.voice.voicesHint")].join("\n"), buttons)
  }

  renderPersonal(actor) {
    const userId = Number(actor?.id)
    const configured = this.notificationConfigured(userId)
    const notifications = configured && this.state.finalNotificationsEnabledFor(userId)
    const contextTurns = this.state.contextTurnsForUser(userId, 3)
    const actorName = escapeHtml(actorLabel(actor))
    const notificationState = configured ? this.stateLabel(notifications) : t("controlMenu.unavailable")
    return this.view([
      t("controlMenu.personal.title", { user: actorName }),
      t("controlMenu.scope.personal"),
      "",
      t("controlMenu.personal.notifications", { value: notificationState }),
      t("controlMenu.personal.context", { value: contextTurns }),
      "",
      t("controlMenu.personal.hint"),
    ].join("\n"), [
      configured ? [this.callback(notifications ? t("controlMenu.button.disableNotifications") : t("controlMenu.button.enableNotifications"), `notify:${notifications ? 0 : 1}`)] : [],
      ...rows(Array.from({ length: 10 }, (_, index) => {
        const value = index + 1
        return this.callback(`${value === contextTurns ? "✓ " : ""}${value}`, `context:${value}`)
      }), 5),
      [this.callback(t("controlMenu.button.back"), "home"), this.callback(t("controlMenu.button.refresh"), "personal")],
    ].filter((row) => row.length))
  }

  renderSystem() {
    const mirrorEnabled = this.state.mirrorEnabled(this.config)
    const mode = this.state.mirrorMode()
    const language = getLanguage()
    const sounds = this.state.soundsTopic()
    const modeLabel = mode === "economy" ? t("controlMenu.system.modeEconomy") : t("controlMenu.system.modeFull")
    return this.view([
      t("controlMenu.system.title"),
      t("controlMenu.scope.global"),
      "",
      t("controlMenu.system.language", { value: language.toUpperCase() }),
      t("controlMenu.system.mirror", { value: this.stateLabel(mirrorEnabled) }),
      t("controlMenu.system.mode", { value: modeLabel }),
      t("controlMenu.system.sounds", { value: sounds ? escapeHtml(sounds.title) : t("controlMenu.unavailable") }),
      t("controlMenu.system.debug", { value: this.stateLabel(this.state.debugEnabled()) }),
    ].join("\n"), [
      [this.callback(`${language === "ru" ? "✓ " : ""}Русский`, "lang:ru"), this.callback(`${language === "en" ? "✓ " : ""}English`, "lang:en")],
      [this.callback(mirrorEnabled ? t("controlMenu.button.disableMirror") : t("controlMenu.button.enableMirror"), `mirror:${mirrorEnabled ? 0 : 1}`)],
      [this.callback(`${mode === "full" ? "✓ " : ""}${t("controlMenu.system.modeFull")}`, "mode:full"), this.callback(`${mode === "economy" ? "✓ " : ""}${t("controlMenu.system.modeEconomy")}`, "mode:economy")],
      [this.callback(t("controlMenu.button.back"), "home"), this.callback(t("controlMenu.button.refresh"), "system")],
    ])
  }

  renderHelp() {
    return this.view([t("controlMenu.help.title"), "", t("controlMenu.help.body")].join("\n"), [
      [this.callback(t("controlMenu.button.back"), "home")],
    ])
  }

  activeBindings() {
    return this.state.bindings()
      .filter((binding) => String(binding.chatId) === String(this.chatId()))
      .sort((left, right) => (
        bindingActivity(right) - bindingActivity(left)
        || bindingTitle(left).localeCompare(bindingTitle(right), getLanguage())
      ))
  }

  voiceProfiles() {
    return Object.values(this.finalVoice.config.tts.profiles)
  }

  currentVoiceProfile() {
    return this.finalVoice.config.tts.profiles[this.finalVoice.settings().profile] || this.voiceProfiles()[0]
  }

  notificationConfigured(userId) {
    return Boolean(this.config.finalNotifications?.enabled && this.config.finalNotifications.userIds.map(Number).includes(Number(userId)))
  }

  async cleanInputMessages(message, pending) {
    await Promise.all([
      this.deleteQuietly(message.chat?.id, pending.promptMessageId),
      this.deleteQuietly(message.chat?.id, message.message_id),
    ])
  }

  async pinMenu(messageId) {
    if (!messageId) return
    try {
      await this.telegram.pinChatMessage({ chatId: this.chatId(), messageId, disableNotification: true })
      logInfo("control_menu.pinned", { chatId: this.chatId(), messageId })
    } catch (error) {
      logWarn("control_menu.pin.failed", { chatId: this.chatId(), messageId, error: error.message })
    }
  }

  async answer(query, text, showAlert = false) {
    return this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text, showAlert })
  }

  async deleteQuietly(chatId, messageId) {
    if (!chatId || !messageId) return
    await this.telegram.deleteMessage({ chatId, messageId, suppressFailureLog: true }).catch(() => {})
  }

  scheduleDelete(chatId, messageId) {
    if (!chatId || !messageId) return
    const timer = setTimeout(() => this.deleteQuietly(chatId, messageId), LINK_MESSAGE_TTL_MS)
    timer.unref?.()
  }

  chatId() {
    return this.state.chatId || this.config.telegram.chatId
  }

  isGeneralMessage(message) {
    const messageTopicId = topicId(message)
    return String(message?.chat?.id) === String(this.chatId()) && (!message?.is_topic_message || messageTopicId === 0 || messageTopicId === 1)
  }

  stateLabel(enabled) {
    return enabled ? t("controlMenu.state.on") : t("controlMenu.state.off")
  }

  updatedTime() {
    return new Intl.DateTimeFormat(getLanguage() === "ru" ? "ru-RU" : "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date())
  }

  callback(text, action) {
    return { text, callback_data: `${CALLBACK_PREFIX}${action}` }
  }

  view(text, inlineKeyboard) {
    return { text, replyMarkup: { inline_keyboard: inlineKeyboard } }
  }
}

function bindingTitle(binding) {
  return String(binding.topicTitle || binding.title || binding.topicBaseTitle || `Topic ${binding.topicId}`)
}

function bindingActivity(binding) {
  const value = Date.parse(binding.lastActiveAt || binding.createdAt || "")
  return Number.isFinite(value) ? value : 0
}

function actorLabel(actor) {
  if (!actor) return "user"
  if (actor.username) return `@${actor.username}`
  return [actor.first_name, actor.last_name].filter(Boolean).join(" ") || String(actor.id)
}

function rows(items, width) {
  const result = []
  for (let index = 0; index < items.length; index += width) result.push(items.slice(index, index + width))
  return result
}

function truncate(value, maxLength) {
  const text = String(value || "")
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

function plainText(value) {
  return String(value || "").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim()
}

function isMessageNotModified(error) {
  return /message is not modified/i.test(String(error?.message || ""))
}

function isMissingMessage(error) {
  return /message to edit not found|message can't be edited|message identifier is not specified/i.test(String(error?.message || ""))
}
