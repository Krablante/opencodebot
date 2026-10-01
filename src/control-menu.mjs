import { getLanguage, t } from "./i18n/index.mjs"
import { logErrorEvent, logInfo, logWarn } from "./logger.mjs"
import { escapeHtml, telegramMessageLink, topicId } from "./telegram.mjs"
import { createBackendRequester } from "./backend-backoff.mjs"
import { richView, menuTable, localText } from "./menu-format.mjs"
import { guidePage } from "./user-guide.mjs"
import fs from "node:fs/promises"

const CALLBACK_PREFIX = "panel:"
const INPUT_TTL_MS = 5 * 60 * 1000
const LINK_MESSAGE_TTL_MS = 30 * 1000
const MAX_VISIBLE_SESSIONS = 6
const MIN_LENGTH_OPTIONS = [0, 200, 300, 500, 1000, 2000]
const SESSION_STATUS_TIMEOUT_MS = 3000

export class ControlMenu {
  constructor({ config, state, telegram, opencode, promptQueue, finalVoice, launchMenu, setup, topicExists, refreshCommandMenu, backendRequester = createBackendRequester() }) {
    this.config = config
    this.state = state
    this.telegram = telegram
    this.opencode = opencode
    this.promptQueue = promptQueue
    this.finalVoice = finalVoice
    this.launchMenu = launchMenu
    this.setup = setup
    this.topicExists = topicExists
    this.refreshCommandMenu = refreshCommandMenu
    this.pendingInputs = new Map()
    this.currentPage = "home"
    this.currentActor = null
    this.statusRefreshTimer = null
    this.statusRefreshPending = false
    this.backendRequester = backendRequester
    this.statusSnapshotPromise = null
    this.menuOperation = Promise.resolve()
    this.cachedSessionSnapshot = null
    this.statusEvents = new Map()
    this.serverConnections = new Map((config.opencode?.servers || []).map((server) => [server.id, "connecting"]))
  }

  async start() {
    if (!this.chatId()) return null
    const existing = this.state.controlMenuMessage()
    const message = await this.ensureMenu("home", null, { replace: Boolean(existing && (!existing.createdAt || Date.now() - existing.createdAt >= 24 * 60 * 60_000)) })
    if (existing) await this.pinMenu(message?.message_id)
    this.scheduleRotation()
    this.scheduleAnswerDayRefresh()
    return message
  }

  async open(message, page = "home", options = {}) {
    const panel = await this.ensureMenu(page, message?.from, options)
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
    if (await this.launchMenu?.handleCallback(query)) return true
    if (await this.setup?.handleCallback(query)) return true
    const data = String(query?.data || "")
    if (!data.startsWith(CALLBACK_PREFIX)) return false
    return this.runMenuOperation(() => this.handleCurrentCallback(query, data))
  }

  async handleCurrentCallback(query, data) {
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
    if (await this.launchMenu?.handleMessage(message)) return true
    if (await this.setup?.handleMessage(message)) return true
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
    if (action === "guide:pdf") {
      await this.answer(query)
      const language = getLanguage()
      const bytes = await fs.readFile(new URL(`../assets/guide-${language}.pdf`, import.meta.url))
      await this.telegram.sendDocument({ chatId: query.message.chat.id, topicId: 0, file: { bytes, filename: `OpenCodeBot-guide-${language}.pdf`, contentType: "application/pdf" } })
      return
    }
    if (action === "new" || action === "profiles") {
      await this.answer(query)
      await this.launchMenu.open(query, action)
      return
    }
    if (action === "setup") { await this.answer(query); await this.setup.open({ ...query.message, from: query.from }); return }
    if (/^help:\d+$/.test(action)) { await this.answer(query); await this.editMenuUnlocked(action, query.from); return }
    if (action === "sessions:refresh") {
      await this.answer(query)
      await this.editMenuUnlocked("sessions", query.from, undefined, { forceTopicCheck: true })
      return
    }
    if (["home", "sessions", "settings", "voice", "voice-advanced", "personal", "system", "help"].includes(action)) {
      await this.answer(query)
      await this.editMenuUnlocked(action, query.from)
      return
    }
    if (action === "refresh") {
      await this.answer(query, t("controlMenu.refreshed"))
      await this.editMenuUnlocked("home", query.from)
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
      await this.editMenuUnlocked("voice", query.from)
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
      await this.editMenuUnlocked("voice", query.from)
      return
    }
    if (action === "voice:profiles") {
      await this.answer(query)
      await this.editMenuUnlocked("voice-profiles", query.from)
      return
    }
    if (action === "voice:voices") {
      await this.answer(query)
      await this.editMenuUnlocked("voice-voices", query.from)
      return
    }
    if (action.startsWith("voice:voice:")) {
      const profile = this.currentVoiceProfile()
      const voice = profile.voices[Number(action.split(":").at(-1))]
      if (!voice) return this.answer(query, t("controlMenu.invalidChoice"), true)
      await this.finalVoice.patchSettings({ voice })
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenuUnlocked("voice", query.from)
      return
    }
    if (action.startsWith("voice:min:")) {
      const value = Number(action.split(":").at(-1))
      if (!Number.isSafeInteger(value) || value < 0) return this.answer(query, t("controlMenu.invalidChoice"), true)
      await this.finalVoice.patchSettings({ minFinalChars: value })
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenuUnlocked("voice-advanced", query.from)
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
      await this.editMenuUnlocked("voice-advanced", query.from)
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
      await this.editMenuUnlocked("personal", query.from)
      return
    }
    if (action.startsWith("mirror:")) {
      const enabled = action.endsWith(":1")
      await this.state.setMirrorEnabled(enabled)
      await this.answer(query, enabled ? t("controlMenu.enabled") : t("controlMenu.disabled"))
      await this.editMenuUnlocked("system", query.from)
      return
    }
    if (action.startsWith("mode:")) {
      const mode = action.split(":").at(-1)
      if (!["full", "economy"].includes(mode)) return this.answer(query, t("controlMenu.invalidChoice"), true)
      await this.state.setMirrorMode(mode)
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenuUnlocked("system", query.from)
      return
    }
    if (action.startsWith("reminder:")) {
      await this.state.setReminderEnabled(action.endsWith(":1"))
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenuUnlocked("system", query.from)
      return
    }
    if (action.startsWith("topicnames:")) {
      await this.state.setRandomTopicNamesEnabled(action.endsWith(":1"))
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenuUnlocked("settings", query.from)
      return
    }
    if (action.startsWith("debug:")) {
      await this.state.setDebugEnabled(action.endsWith(":1"))
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenuUnlocked("system", query.from)
      return
    }
    if (action.startsWith("lang:")) {
      const language = action.split(":").at(-1)
      if (!["en", "ru"].includes(language)) return this.answer(query, t("controlMenu.invalidChoice"), true)
      await this.refreshCommandMenu(language)
      await this.answer(query, t("controlMenu.saved"))
      await this.editMenuUnlocked("system", query.from)
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
    await this.editMenuUnlocked("personal", query.from)
  }

  async startInput(query, field) {
    const prompt = await this.telegram.sendMessage({
      chatId: this.chatId(),
      topicId: 0,
      text: `${t(field === "prompt" ? "controlMenu.input.prompt" : "controlMenu.input.intro")}\n<a href="tg://user?id=${query.from.id}">${escapeHtml(t("controlMenu.input.placeholder"))}</a>`,
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

  runMenuOperation(operation) {
    const result = this.menuOperation.then(operation)
    this.menuOperation = result.catch(() => {})
    return result
  }

  ensureMenu(page = "home", actor, options = {}) {
    return this.runMenuOperation(() => this.ensureMenuUnlocked(page, actor, options))
  }

  async ensureMenuUnlocked(page = "home", actor, { replace = false } = {}) {
    this.rememberPage(page, actor)
    const existing = this.state.controlMenuMessage()
    if (!replace && existing && String(existing.chatId) === String(this.chatId())) {
      const rendered = await this.render(page, actor)
      try {
        const edited = await this.telegram.editRichMessage({
          chatId: existing.chatId,
          messageId: existing.messageId,
          html: richView(rendered.text, rendered.replyMarkup),
        })
        this.lastRendered = { messageId: existing.messageId, html: richView(rendered.text, rendered.replyMarkup) }
        return edited || { chat: { id: existing.chatId }, message_id: existing.messageId }
      } catch (error) {
        if (isMessageNotModified(error)) return { chat: { id: existing.chatId }, message_id: existing.messageId }
        if (!isMissingMessage(error)) throw error
        await this.state.setControlMenuMessage()
      }
    }

    const rendered = await this.render(page, actor)
    const sent = await this.telegram.sendRichMessage({
      chatId: this.chatId(),
      topicId: 0,
      html: richView(rendered.text, rendered.replyMarkup),
      disableNotification: true,
    })
    await this.state.setControlMenuMessage({ chatId: this.chatId(), messageId: sent.message_id })
    this.lastRendered = { messageId: sent.message_id, html: richView(rendered.text, rendered.replyMarkup) }
    if (existing) await this.retireMenu(existing)
    await this.pinMenu(sent.message_id)
    this.scheduleRotation()
    this.scheduleAnswerDayRefresh()
    logInfo("control_menu.created", { chatId: this.chatId(), messageId: sent.message_id })
    return sent
  }

  editMenu(page, actor) {
    return this.runMenuOperation(() => this.editMenuUnlocked(page, actor))
  }

  async editMenuUnlocked(page, actor, snapshot, options) {
    this.rememberPage(page, actor)
    const current = this.state.controlMenuMessage()
    if (!current) return this.ensureMenuUnlocked(page, actor)
    const rendered = await this.render(page, actor, snapshot, options)
    if (this.currentPage !== page || this.currentActor !== (actor || null)) return null
    const html = richView(rendered.text, rendered.replyMarkup)
    if (this.lastRendered?.messageId === current.messageId && this.lastRendered.html === html) return null
    try {
      const result = await this.telegram.editRichMessage({
        chatId: current.chatId,
        messageId: current.messageId,
        html,
      })
      this.lastRendered = { messageId: current.messageId, html }
      return result
    } catch (error) {
      if (isMessageNotModified(error)) return null
      if (isMissingMessage(error)) {
        await this.state.setControlMenuMessage()
        return this.ensureMenuUnlocked(page, actor)
      }
      throw error
    }
  }

  async render(page, actor, snapshot, { forceTopicCheck = false } = {}) {
    // Only explicit navigation checks Telegram. SSE refreshes use their snapshot.
    if (page === "sessions" && !snapshot && this.topicExists) {
      let visible = 0, checked = 0
      for (const binding of this.activeBindings()) {
        if (++checked > MAX_VISIBLE_SESSIONS * 3) break
        try {
          if (!await this.topicExists(binding, { force: forceTopicCheck, receiverUserId: actor?.id })) continue
        } catch (error) {
          // Transport and permission errors do not prove deletion. Keep the topic.
          logWarn("control_menu.topic_check.failed", { error: error.message })
          break
        }
        if (++visible >= MAX_VISIBLE_SESSIONS) break
      }
    }
    const sessionSnapshot = ["home", "sessions"].includes(page) ? snapshot || await this.sessionStatusSnapshot() : null
    if (page === "sessions") return this.renderSessions(sessionSnapshot)
    if (page === "settings") return this.renderSettings()
    if (page === "voice") return this.renderVoice()
    if (page === "voice-advanced") return this.renderVoiceAdvanced()
    if (page === "voice-profiles") return this.renderVoiceProfiles()
    if (page === "voice-voices") return this.renderVoiceVoices()
    if (page === "personal") return this.renderPersonal(actor)
    if (page === "system") return this.renderSystem()
    if (page === "help" || page.startsWith("help:")) return this.renderHelp(Number(page.split(":")[1] || 0))
    return this.renderHome(sessionSnapshot)
  }

  renderHome(sessionSnapshot) {
    const bindings = this.activeBindings()
    const queued = bindings.reduce((total, binding) => total + this.promptQueue.status(binding).length, 0)
    const unknown = (binding) => sessionSnapshot?.failedServers.has(binding.serverID) || this.serverConnections.get(binding.serverID) === "unavailable"
    const busy = bindings.filter((binding) => !unknown(binding) && this.sessionIsBusy(binding, sessionSnapshot)).length
    const L = (ru, en) => localText(ru, en, getLanguage())
    const text = `<h2>✦ OpenCodeBot</h2>` + menuTable([
      [L("В работе", "Running"), String(busy)], [L("В очереди", "Queued"), String(queued)],
      [L("Ответов сегодня", "Answers today"), String(this.state.answersToday())],
    ].map(([label, value]) => [label, `<b>${value}</b>`])) + `<p>${this.serverSummary()}</p>` + this.answerStatsPeriod()
    return this.view(text, [
      [{ ...this.callback(L("＋ Новая тема", "＋ New topic"), "new"), style: "primary" }],
      [this.callback(L("Недавние темы", "Recent topics"), "sessions"), this.callback(L("Профили", "Profiles"), "profiles")],
      [this.callback(L("Настройки", "Settings"), "settings"), this.callback(L("Как пользоваться", "How to use"), "help")],
    ])
  }

  serverSummary() {
    const states = [...this.serverConnections]
    const available = states.filter(([, status]) => status === "available").length
    const offline = states.filter(([, status]) => status === "unavailable").map(([id]) => id)
    const checking = states.filter(([, status]) => status === "connecting").map(([id]) => id)
    const L = (ru, en) => localText(ru, en, getLanguage())
    return `${L("Серверы", "Servers")}: ${L(`${available} из ${states.length}`, `${available} of ${states.length}`)}`
      + (offline.length ? ` · ${escapeHtml(offline.join(", "))} ${L(offline.length === 1 ? "недоступен" : "недоступны", "unavailable")}` : "")
      + (checking.length ? ` · ${escapeHtml(checking.join(", "))}: ${L("проверяется", "checking")}` : "")
  }

  answerStatsPeriod() {
    const startedAt = this.state.data.answerStats?.startedAt
    if (!startedAt || !this.state.answerDayFormatter || this.state.answerDay(startedAt) !== this.state.answerDay()) return ""
    const time = new Intl.DateTimeFormat(getLanguage() === "ru" ? "ru-RU" : "en-GB", { timeZone: this.state.answerDayFormatter.resolvedOptions().timeZone, hour: "2-digit", minute: "2-digit" }).format(startedAt)
    return `<footer>${localText("Учёт ответов с", "Answer tracking since", getLanguage())} ${escapeHtml(time)}</footer>`
  }

  setServerConnection(serverID, status) {
    if (!this.serverConnections.has(serverID) || this.serverConnections.get(serverID) === status) return
    this.serverConnections.set(serverID, status)
    logInfo("control_menu.server_connection", { serverID, status })
    if (status === "unavailable") this.cachedSessionSnapshot?.failedServers.add(serverID)
    this.scheduleStatusRefresh()
  }

  renderSettings() {
    const L = (ru, en) => localText(ru, en, getLanguage())
    const randomNames = this.state.randomTopicNamesEnabled()
    return this.view(`<h2>⚙ ${L("Настройки", "Settings")}</h2><p>${L("Подключения и параметры бота", "Connections and bot preferences")}</p><p>${L("Случайные названия — древнерусские слова для новых тем. Своё название можно вписать при создании.", "Random names use Old Russian words for new topics. You can enter your own title when creating a topic.")}</p>`, [
      [this.callback(`${L("Случайные названия", "Random topic names")}: ${randomNames ? L("вкл", "on") : L("выкл", "off")}`, `topicnames:${randomNames ? "0" : "1"}`)],
      [this.callback(L("FILES · AUDIO · Setup", "FILES · AUDIO · Setup"), "setup")],
      [this.callback(L("Уведомления и контекст", "Notifications and context"), "personal")],
      [this.callback(L("Озвучка ответов", "Spoken answers"), "voice")],
      [this.callback(L("Язык и дополнительные настройки", "Language and advanced settings"), "system")],
      [this.callback(t("controlMenu.button.back"), "home")],
    ])
  }

  renderSessions(sessionSnapshot) {
    const bindings = this.activeBindings()
    const visible = bindings.slice(0, MAX_VISIBLE_SESSIONS)
    const L = (ru, en) => localText(ru, en, getLanguage())
    const lines = [`<h2>📂 ${L("Недавние темы", "Recent topics")}</h2>`,
      `<p>${L("Нажми на название, чтобы открыть тему.", "Tap a title to open its topic.")}</p>`]
    if (!visible.length) lines.push(`<p>${t("controlMenu.sessions.empty")}</p>`)
    for (const binding of visible) {
      const queued = this.promptQueue.status(binding).length
      const status = sessionSnapshot?.failedServers.has(binding.serverID)
        ? L("◌ Нет связи", "◌ Unavailable")
        : this.sessionIsBusy(binding, sessionSnapshot)
          ? L("● В работе", "● Running")
          : queued
            ? L(`◷ В очереди: ${queued}`, `◷ Queued: ${queued}`)
            : L("○ Свободна", "○ Ready")
      const title = String(binding.topicBaseTitle || binding.title || bindingTitle(binding))
      const url = telegramMessageLink(binding.chatId, binding.topicId)
      lines.push(`<p><a href="${escapeHtml(url)}"><b>${escapeHtml(title)}</b></a><br><code>${escapeHtml(binding.serverID || "?")}</code> · ${status}</p>`)
    }
    if (bindings.length > visible.length) lines.push(`<footer>${L("Остальные темы — в списке топиков Telegram.", "Find other topics in Telegram’s topic list.")}</footer>`)
    return this.view(lines.join(""), [
      [this.callback(t("controlMenu.button.back"), "home"), this.callback(t("controlMenu.button.refresh"), "sessions:refresh")],
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
      [this.callback(localText(this.state.reminderEnabled() ? "Выключить напоминания после compaction" : "Включить напоминания после compaction", this.state.reminderEnabled() ? "Disable compaction reminders" : "Enable compaction reminders", language), `reminder:${this.state.reminderEnabled() ? 0 : 1}`)],
      [this.callback(localText(this.state.debugEnabled() ? "Скрывать диагностику в уведомлениях" : "Добавлять диагностику в уведомления", this.state.debugEnabled() ? "Hide notification diagnostics" : "Show notification diagnostics", language), `debug:${this.state.debugEnabled() ? 0 : 1}`)],
      [this.callback(t("controlMenu.button.back"), "home"), this.callback(t("controlMenu.button.refresh"), "system")],
    ])
  }

  renderHelp(page = 0) {
    const guide = guidePage(page, getLanguage())
    return this.view(guide.html, [
      [...(page > 0 ? [this.callback("‹", `help:${page - 1}`)] : []), ...(page + 1 < guide.total ? [this.callback("›", `help:${page + 1}`)] : [])],
      [this.callback(localText("Скачать PDF", "Download PDF", getLanguage()), "guide:pdf")],
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

  sessionStatusSnapshot() {
    this.statusSnapshotPromise ||= this.loadSessionStatusSnapshot().finally(() => { this.statusSnapshotPromise = null })
    return this.statusSnapshotPromise
  }

  async loadSessionStatusSnapshot() {
    const startedAt = Date.now()
    const groups = Map.groupBy(this.activeBindings(), (binding) => binding.serverID)
    const statuses = new Map()
    const failedServers = new Set()
    await Promise.all([...groups].map(async ([serverID, bindings]) => {
      try {
        for (const directory of new Set(bindings.map((binding) => binding.directory || this.opencode.server(serverID).home))) {
          const result = await this.backendRequester.request(serverID, "control menu status", () =>
            this.opencode.sessionStatuses(serverID, { directory, timeoutMs: SESSION_STATUS_TIMEOUT_MS }))
          if (result === this.backendRequester.skipped) {
            failedServers.add(serverID)
            break
          }
          for (const [sessionID, status] of Object.entries(result || {})) statuses.set(`${serverID}:${sessionID}`, status)
        }
      } catch (error) {
        failedServers.add(serverID)
        logWarn("control_menu.session_status.failed", { serverID, error: error.message })
      }
    }))
    const activeKeys = new Set(this.activeBindings().map((binding) => `${binding.serverID}:${binding.sessionID}`))
    for (const [key, event] of this.statusEvents) {
      if (!activeKeys.has(key)) { this.statusEvents.delete(key); continue }
      if (event.at >= startedAt) statuses.set(key, event.status)
    }
    for (const key of statuses.keys()) if (!activeKeys.has(key)) statuses.delete(key)
    this.cachedSessionSnapshot = { statuses, failedServers }
    return this.cachedSessionSnapshot
  }

  observeStatus(binding, status) {
    const key = `${binding.serverID}:${binding.sessionID}`
    this.statusEvents.set(key, { at: Date.now(), status })
    this.cachedSessionSnapshot ||= { statuses: new Map(), failedServers: new Set() }
    this.cachedSessionSnapshot.statuses.set(key, status)
    this.cachedSessionSnapshot.failedServers.delete(binding.serverID)
    this.scheduleStatusRefresh()
  }

  sessionIsBusy(binding, snapshot) {
    const status = snapshot?.statuses.get(`${binding.serverID}:${binding.sessionID}`)
    if (status) return status.type !== "idle"
    return !snapshot || snapshot.failedServers.has(binding.serverID) ? this.promptQueue.isBusy(binding) : false
  }

  scheduleStatusRefresh() {
    if (this.statusRefreshPending || !["home", "sessions"].includes(this.currentPage)) return
    clearTimeout(this.statusRefreshTimer)
    this.statusRefreshTimer = setTimeout(() => {
      this.statusRefreshPending = true
      this.runMenuOperation(() => {
        if (!["home", "sessions"].includes(this.currentPage)) return null
        return this.editMenuUnlocked(this.currentPage, this.currentActor, this.cachedSessionSnapshot)
      }).catch((error) => {
        logErrorEvent("control_menu.status_refresh.failed", error, { page: this.currentPage })
      }).finally(() => {
        this.statusRefreshPending = false
      })
    }, 500)
    this.statusRefreshTimer.unref?.()
  }

  rememberPage(page, actor) {
    this.currentPage = page
    this.currentActor = actor || null
  }

  voiceProfiles() {
    return Object.values(this.finalVoice.config.tts.profiles)
  }

  currentVoiceProfile() {
    return this.finalVoice.config.tts.profiles[this.finalVoice.settings().profile] || this.voiceProfiles()[0] || { id: "—", voices: [], defaultVoice: "" }
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

  async retireMenu({ chatId, messageId }) {
    try {
      await this.telegram.deleteMessage({ chatId, messageId, suppressFailureLog: true })
      return
    } catch (error) {
      if (/message to delete not found/i.test(String(error?.message || ""))) return
      // Telegram may refuse deletion of an old message; keep it inert instead.
    }
    await Promise.all([
      this.telegram.editRichMessage({ chatId, messageId, html: `<p>${localText("Это меню заменено. Открой /menu.", "This menu was replaced. Open /menu.", getLanguage())}</p>` }).catch((error) => {
        if (!isMessageNotModified(error) && !isMissingMessage(error)) logWarn("control_menu.retire.keyboard.failed", { error: error.message })
      }),
      this.telegram.request("unpinChatMessage", { chat_id: chatId, message_id: messageId }, 0, { suppressFailureLog: true })
        .catch((error) => logWarn("control_menu.retire.unpin.failed", { error: error.message })),
    ])
  }

  async answer(query, text, showAlert = false) {
    return this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text, showAlert })
  }

  scheduleRotation() {
    clearTimeout(this.rotationTimer)
    const createdAt = this.state.controlMenuMessage()?.createdAt || Date.now()
    this.rotationTimer = setTimeout(() => {
      this.ensureMenu("home", null, { replace: true }).catch((error) => {
        logErrorEvent("control_menu.rotation_failed", error)
        this.rotationTimer = setTimeout(() => this.scheduleRotation(), 60_000)
        this.rotationTimer.unref?.()
      })
    }, Math.max(1000, createdAt + 24 * 60 * 60_000 - Date.now()))
    this.rotationTimer.unref?.()
  }

  scheduleAnswerDayRefresh() {
    clearTimeout(this.answerDayTimer)
    const at = this.state.nextAnswerDayAt()
    if (!at) return
    this.answerDayTimer = setTimeout(() => {
      this.runMenuOperation(() => this.currentPage === "home"
        ? this.editMenuUnlocked("home", this.currentActor, this.cachedSessionSnapshot) : null)
        .catch((error) => logErrorEvent("control_menu.day_refresh.failed", error))
        .finally(() => this.scheduleAnswerDayRefresh())
    }, Math.max(1000, at - Date.now()))
    this.answerDayTimer.unref?.()
  }

  stop() { clearTimeout(this.rotationTimer); clearTimeout(this.statusRefreshTimer); clearTimeout(this.answerDayTimer) }

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
