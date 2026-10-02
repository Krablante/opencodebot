import { randomBytes } from "node:crypto"
import { getLanguage } from "./i18n/index.mjs"
import { escapeHtml, telegramMessageLink, topicId } from "./telegram.mjs"
import { buttonRows, menuTable, richButton, localText } from "./menu-format.mjs"
import { logErrorEvent, logInfo } from "./logger.mjs"
import { randomTopicTitle } from "./topic-titles.mjs"

const INPUT_TTL = 15 * 60_000
const CREATED_CARD_TTL = 2 * 60_000
const CARD_RETENTION = 48 * 60 * 60_000
const MODELS_PER_PAGE = 100

// Short-lived, actor-owned drafts. Saved profiles and launch snapshots belong to UserSettings/StateStore.
export class LaunchMenu {
  constructor({ config, state, telegram, opencode, settings, createSession }) {
    Object.assign(this, { config, state, telegram, opencode, settings, createSession })
    this.drafts = new Map()
    this.inputs = new Map()
    this.lanes = new Map()
    this.cleanupOperation = Promise.resolve()
  }

  text(ru, en) { return localText(ru, en, getLanguage()) }

  cards() { return this.state.data.telegram.launchCards || [] }

  async start() {
    // Drafts cannot resume after restart. Confirmations retain their original deadline.
    await this.state.update((data) => {
      const drafts = (data.telegram.launchCards || []).filter((card) => !card.deleted && card.kind === "draft")
      if (!drafts.length) return false
      for (const card of drafts) card.deleteAt = Date.now()
    })
    await this.cleanup()
  }

  stop() { this.stopped = true; clearTimeout(this.cleanupTimer) }

  scheduleCleanup(minDelay = 0) {
    clearTimeout(this.cleanupTimer)
    if (this.stopped || !this.cards().length) return
    const next = this.cards().reduce((next, card) => Math.min(next, card.deleted ? card.retainUntil : Math.min(card.deleteAt, card.retainUntil)), Infinity)
    this.cleanupTimer = setTimeout(() => {
      this.cleanup().catch((error) => logErrorEvent("launch_menu.cleanup_failed", error))
    }, Math.max(minDelay, next - Date.now()))
    this.cleanupTimer.unref()
  }

  cleanup() {
    const run = this.cleanupOperation.catch(() => {}).then(async () => {
      await this.state.update((data) => {
        const cards = this.cards().filter((card) => card.retainUntil > Date.now())
        if (cards.length === this.cards().length) return false
        data.telegram.launchCards = cards
      })
      for (const card of this.cards()) {
        if (this.stopped || card.deleted || card.deleteAt > Date.now()) continue
        for (const draft of this.drafts.values()) {
          if (String(draft.chatId) === String(card.chatId) && draft.messageId === card.messageId) this.forgetDraft(draft)
        }
        let retryAt
        try {
          await this.telegram.request("deleteMessage", { chat_id: card.chatId, message_id: card.messageId }, 0,
            { suppressFailureLog: true, timeoutMs: 10_000, retryRateLimit: false })
          logInfo("launch_menu.card_deleted", { kind: card.kind })
        } catch (error) {
          if (!/message to delete not found/i.test(error.message)) {
            retryAt = Date.now() + Math.max(60_000, (Number(error.retryAfter) || 0) * 1000 + 1000)
            logErrorEvent("launch_menu.delete_failed", error, { kind: card.kind, retryInMs: retryAt - Date.now() })
          }
        }
        await this.state.update(() => {
          if (retryAt) card.deleteAt = retryAt
          else card.deleted = true
        })
      }
    }).then(() => this.scheduleCleanup(), (error) => {
      this.scheduleCleanup(60_000)
      throw error
    })
    this.cleanupOperation = run
    return run
  }

  async rememberCard(d) {
    await this.state.update((data) => {
      data.telegram.launchCards ||= []
      let card = data.telegram.launchCards.find((card) => String(card.chatId) === String(d.chatId) && card.messageId === d.messageId)
      const kind = d.page === "created" ? "created" : "draft"
      const deleteAt = kind === "created" ? (card?.kind === "created" ? card.deleteAt : Date.now() + CREATED_CARD_TTL) : d.expires
      if (card && card.kind === kind && card.deleteAt === deleteAt && card.rev === d.rev) return false
      if (!card) {
        card = { chatId: d.chatId, topicId: d.topicId, messageId: d.messageId, userId: d.userId,
          id: d.id, retainUntil: Date.now() + CARD_RETENTION }
        data.telegram.launchCards.push(card)
      }
      Object.assign(card, { kind, deleteAt, rev: d.rev })
    })
    this.scheduleCleanup()
  }

  open(query, page = "new") {
    const key = `actor:${query.from.id}`
    const run = (this.lanes.get(key) || Promise.resolve()).catch(() => {}).then(() => this.openCurrent(query, page))
      .finally(() => { if (this.lanes.get(key) === run) this.lanes.delete(key) })
    this.lanes.set(key, run)
    return run
  }

  async openCurrent(query, page = "new") {
    this.expire()
    const userId = query.from.id
    for (const draft of this.drafts.values()) if (draft.userId === userId) await this.close(draft)
    for (const card of this.cards().filter((card) => card.userId === userId && !card.deleted)) await this.deleteCard(card)
    const serverID = this.config.defaultPrompt.serverID || this.config.opencode.servers[0].id
    const d = { id: randomBytes(4).toString("hex"), userId, chatId: query.message.chat.id, topicId: topicId(query.message),
      rev: 0, page, expires: Date.now() + INPUT_TTL, serverID,
      name: page === "new" && this.state.randomTopicNamesEnabled() ? randomTopicTitle() : "",
      directory: this.opencode.defaultNewSessionDirectory(serverID), profileName: this.settings.launchProfileName(),
    }
    this.drafts.set(d.id, d)
    try {
      if (page === "new" && !d.name) await this.ask(d, "title", this.text("Как назвать новую тему?", "What should the new topic be called?"))
      await this.sendCard(d)
    } catch (error) {
      await this.close(d)
      throw error
    }
    return d
  }

  async handleCallback(query) {
    if (!String(query.data || "").startsWith("launch:")) return false
    const [, id, rev, ...parts] = query.data.split(":")
    const action = parts.join(":")
    const prior = this.lanes.get(id) || Promise.resolve()
    const run = prior.catch(() => {}).then(async () => {
      let d = this.drafts.get(id)
      // A saved confirmation can still be closed after restart or a failed deletion.
      if (!d && action === "close") {
        const card = this.cards().find((card) => card.id === id && !card.deleted && card.kind === "created")
        if (card) d = { ...card, expires: card.retainUntil, allowedActions: new Set(["close"]) }
      }
      if (!d || d.expires < Date.now() || d.userId !== query.from.id || String(d.chatId) !== String(query.message?.chat?.id)
        || topicId(query.message) !== d.topicId || Number(query.message?.message_id) !== d.messageId || Number(rev) !== d.rev || !d.allowedActions?.has(action)) {
        await this.telegram.answerCallbackQuery({ callbackQueryId: query.id, text: this.text("Экран устарел. Открой меню снова.", "This screen expired. Open the menu again."), showAlert: true })
        return
      }
      await this.telegram.answerCallbackQuery({ callbackQueryId: query.id })
      d.expires = Date.now() + INPUT_TTL
      try {
        await this.act(d, action)
        if (this.drafts.has(id)) await this.draw(d)
      } catch (error) {
        logErrorEvent("launch_menu.action_failed", error, { action: parts[0] })
        const translated = {
          PROFILE_NAME: this.text("Название: 1–40 символов, буквы, цифры, _ и -.", "Use 1–40 letters, digits, _ or - for the profile name."),
          PROFILE_EXISTS: this.text("Профиль с таким названием уже существует.", "A profile with this name already exists."),
          PROFILE_ARCHIVED: this.text("Это название есть в удалённых профилях. Восстанови профиль или выбери другое название.", "This name is in Deleted. Restore it first or choose another name."),
        }
        d.error = this.text("Не удалось выполнить действие. ", "Unable to complete this action. ") + String(translated[error.code] || error.message).slice(0, 300)
        if (this.drafts.has(id)) await this.draw(d)
      }
    }).finally(() => { if (this.lanes.get(id) === run) this.lanes.delete(id) })
    this.lanes.set(id, run)
    await run
    return true
  }

  async act(d, action) {
    const [verb, arg] = action.split(":")
    if (verb === "close") return this.close(d)
    if (verb === "new") {
      d.page = "new"; d.editing = false
      if (!d.name && this.state.randomTopicNamesEnabled()) d.name = randomTopicTitle()
      return
    }
    if (verb === "title") return this.ask(d, "title", this.text("Название темы", "Topic title"))
    if (verb === "randomtitle") {
      const hadInput = this.inputs.get(d.userId)?.draftId === d.id
      d.name = randomTopicTitle(); this.inputs.delete(d.userId); delete d.inputRequest
      if (hadInput) return this.sendCard(d)
      return
    }
    if (verb === "profiles") { d.page = "profiles"; d.choosing = arg === "choose"; d.profilePage = 0; return }
    if (verb === "profilespage") { d.profilePage = Number(arg); return }
    if (verb === "profile") {
      const name = d.profileNames?.[Number(arg)]
      if (!name || !this.settings.data.profiles[name]) throw new Error("Profile is unavailable")
      if (d.choosing) { d.profileName = name; delete d.launchVariant; d.page = "new"; d.choosing = false; return }
      d.selectedProfile = name; d.page = "profile"; return
    }
    if (verb === "default") { await this.settings.setDefault(d.selectedProfile); d.notice = this.text("Профиль по умолчанию обновлён.", "Default profile updated."); return }
    if (verb === "delete") { d.page = "delete"; return }
    if (verb === "deleteconfirm") { await this.settings.deleteProfile(d.selectedProfile); d.page = "profiles"; return }
    if (verb === "deleted") { d.page = "deleted"; return }
    if (verb === "deletedpage") { d.deletedPage = Number(arg); return }
    if (verb === "restore") { await this.settings.restoreProfile(d.deletedNames?.[Number(arg)]); d.page = "profiles"; return }
    if (verb === "edit" || verb === "copy" || verb === "add") {
      d.editing = true
      d.previousName = verb === "edit" ? d.selectedProfile : null
      d.profile = verb === "add" ? { agent: "build" } : structuredClone(this.settings.data.profiles[d.selectedProfile])
      d.profileDraftName = verb === "edit" ? d.selectedProfile : verb === "copy" ? `${d.selectedProfile}-copy` : ""
      d.page = "edit"
      if (verb === "add") await this.ask(d, "profileName", this.text("Название профиля: например work или review. Оно также используется в /reset.", "Profile name, for example work or review. It can also be used with /reset."))
      return
    }
    if (verb === "name") return this.ask(d, "profileName", this.text("Название профиля (1–40 символов: буквы, цифры, _ и -)", "Profile name (1–40 letters, digits, _ and -)"))
    if (verb === "save") {
      if (!d.profile?.model?.modelID) throw new Error(this.text("Сначала выбери модель.", "Choose a model first."))
      await this.validate(d, d.profile)
      await this.settings.saveProfile(d.profileDraftName, d.profile, d.previousName)
      d.selectedProfile = d.profileDraftName; d.page = "profile"; d.editing = false
      return
    }
    if (verb === "directory") return this.ask(d, "directory", this.text("Абсолютный путь к рабочей папке на выбранном сервере. /default — домашняя папка.", "Absolute working directory on the selected server. /default uses the server home."))
    if (verb === "servers") { d.page = "servers"; return }
    if (verb === "server") {
      const server = this.config.opencode.servers[Number(arg)]
      if (!server) throw new Error("Server is unavailable")
      d.serverID = server.id; d.directory = this.opencode.defaultNewSessionDirectory(server.id); d.catalog = null
      delete d.launchVariant
      d.page = d.editing ? "edit" : "new"; return
    }
    if (verb === "models" || verb === "refresh") {
      d.catalog = await this.settings.catalog(d.serverID, d.directory, verb === "refresh")
      d.query = ""; d.modelPage = 0; d.page = "models"; return
    }
    if (verb === "search") return this.ask(d, "search", this.text("Название, ID, провайдер или семейство модели. /all — весь каталог.", "Model name, ID, provider or family. /all shows the complete catalog."))
    if (verb === "modelpage") { d.modelPage = Number(arg); return }
    if (verb === "modelsview") { d.expandAll = arg === "open"; return }
    if (verb === "model") {
      const model = d.visibleModels?.[Number(arg)]
      if (!model) throw new Error("Model is unavailable")
      d.profile.model = { providerID: model.providerID, modelID: model.id }
      d.chosenModel = model; d.page = "variants"; return
    }
    if (verb === "variants") {
      d.catalog ||= await this.settings.catalog(d.serverID, d.directory)
      const profile = d.editing ? d.profile : d.launchProfile
      d.chosenModel = d.catalog.models.find((m) => m.id === profile?.model?.modelID && m.providerID === profile?.model?.providerID)
      d.page = "variants"; return
    }
    if (verb === "variant") {
      const value = d.variants?.[Number(arg)]
      if (!d.editing) { d.launchVariant = value; d.page = "new"; return }
      if (value) d.profile.model.variant = value
      else delete d.profile.model.variant
      d.page = "edit"; return
    }
    if (verb === "system") {
      d.catalog ||= await this.settings.catalog(d.serverID, d.directory)
      d.page = "system"; return
    }
    if (verb === "systempick") {
      const entry = d.systems?.[Number(arg)]
      if (entry) d.profile.opencodezSystem = entry.id
      else delete d.profile.opencodezSystem
      d.page = "edit"; return
    }
    if (verb === "systempage") { d.systemPage = Number(arg); return }
    if (verb === "agent") return this.ask(d, "agent", this.text("Имя агента OpenCodez, например build или plan.", "OpenCodez agent name, for example build or plan."))
    if (verb === "editback") { d.page = "edit"; return }
    if (verb === "create") {
      if (!d.name) return this.ask(d, "title", this.text("Как назвать тему?", "What should the topic be called?"))
      if (d.profileName && !this.settings.data.profiles[d.profileName]) throw new Error(this.text("Профиль удалён или переименован. Выбери другой профиль.", "This profile was deleted or renamed. Choose another profile."))
      const saved = this.settings.data.profiles[d.profileName]
      if (!saved?.model?.providerID || !saved?.model?.modelID) throw new Error(this.text("Выбери профиль с конкретной моделью.", "Choose a profile with a specific model."))
      if (d.confirmedProfile !== JSON.stringify(saved)) {
        d.notice = this.text("Настройки профиля изменились. Проверь модель и подтверди создание ещё раз.", "The profile settings changed. Check the model and confirm creation again.")
        return
      }
      if (!d.launchReady || !d.launchProfile) throw new Error(this.text("Проверь настройки запуска на карточке.", "Check the launch settings shown on the card."))
      const profile = structuredClone(d.launchProfile)
      await this.validate(d, profile)
      const topic = await this.createSession({ chat: { id: d.chatId }, from: { id: d.userId } }, {
        serverID: d.serverID, title: d.name, titleSource: "user", directory: d.directory,
        requestKey: `wizard:${d.id}`,
        promptProfileName: d.profileName || null, promptProfile: structuredClone(profile),
      })
      if (!topic?.message_thread_id) throw new Error("Topic was not created")
      this.inputs.delete(d.userId)
      d.page = "created"; d.topicLink = telegramMessageLink(d.chatId, topic.message_thread_id)
      return
    }
  }

  async validate(d, profile) {
    const catalog = await this.settings.catalog(d.serverID, d.directory)
    if (!profile.model?.modelID) return
    const model = catalog.models.find((m) => m.id === profile.model.modelID && m.providerID === profile.model.providerID)
    if (!model) throw new Error(this.text("Модель отсутствует на выбранном сервере. Подключи провайдера в OpenCodez или выбери другой профиль.", "The model is unavailable on this server. Connect its provider in OpenCodez or choose another profile."))
    if (profile.model.variant && !model.variants.includes(profile.model.variant)) throw new Error(this.text("Этот уровень reasoning недоступен для модели.", "This reasoning variant is unavailable for the model."))
    if (profile.opencodezSystem && profile.opencodezSystem !== "default" && profile.opencodezSystem !== "none"
      && !catalog.entries.some((e) => e.id === profile.opencodezSystem || e.name === profile.opencodezSystem)) throw new Error(this.text("System prompt профиля отсутствует на этом сервере. Выбери другой профиль или сервер.", "The profile's System prompt is unavailable on this server. Choose another profile or server."))
  }

  async prepareLaunch(d) {
    const saved = this.settings.data.profiles[d.profileName]
    d.confirmedProfile = JSON.stringify(saved)
    d.launchProfile = saved && structuredClone(saved)
    d.launchReady = false
    d.launchError = ""
    d.launchNeedsVariant = false
    d.launchReasoning = saved?.model?.variant || this.text("Выбери уровень", "Choose a level")
    if (!saved?.model?.providerID || !saved?.model?.modelID) {
      d.launchError = this.text("Выбери или создай профиль с конкретной моделью.", "Choose or create a profile with a specific model.")
      return
    }
    if (d.launchVariant) d.launchProfile.model.variant = d.launchVariant
    try {
      const catalog = await this.settings.catalog(d.serverID, d.directory)
      const model = catalog.models.find((m) => m.id === saved.model.modelID && m.providerID === saved.model.providerID)
      if (!model) throw new Error(this.text("Этой модели нет на выбранном сервере. Выбери другой профиль или сервер.", "This model is unavailable on the selected server. Choose another profile or server."))
      if (!model.variants?.length) d.launchReasoning = this.text("Не применяется", "Not applicable")
      else {
        d.launchReasoning = d.launchProfile.model.variant || this.text("Выбери уровень", "Choose a level")
        if (!d.launchProfile.model.variant || !model.variants.includes(d.launchProfile.model.variant)) {
          d.launchNeedsVariant = true
          if (d.launchProfile.model.variant) d.launchError = this.text("Этот уровень reasoning недоступен на выбранном сервере. Выбери доступный уровень для темы.", "This reasoning level is unavailable on the selected server. Choose a supported level for the topic.")
          return
        }
      }
      await this.validate(d, d.launchProfile)
      d.launchReady = true
    } catch (error) {
      d.launchError = this.text("Запуск недоступен: ", "Launch unavailable: ") + String(error.message).slice(0, 250)
    }
  }

  async ask(d, field, text) {
    d.inputRequest = { field, prompt: text }
  }

  async sendCard(d) {
    const oldMessageId = d.messageId
    const input = d.inputRequest
    // Telegram cannot toggle Force Reply through an edit. A fresh card
    // activates each input request; retire the previous card only after success.
    const sent = await this.telegram.sendRichMessage({ chatId: d.chatId, topicId: d.topicId, html: await this.render(d), disableNotification: true,
      ...(input ? { replyMarkup: { force_reply: true, input_field_placeholder: input.prompt.slice(0, 64) } } : {}),
    })
    if (!sent?.message_id) throw new Error("Telegram did not return the card message ID")
    d.messageId = sent.message_id
    await this.rememberCard(d)
    if (input) this.inputs.set(d.userId, { ...input, draftId: d.id, messageId: d.messageId })
    delete d.inputRequest
    if (oldMessageId && oldMessageId !== d.messageId) await this.deleteCard(d, oldMessageId)
    return sent
  }

  async deleteCard(d, messageId = d.messageId) {
    const card = this.cards().find((card) => String(card.chatId) === String(d.chatId) && card.messageId === messageId && !card.deleted)
    if (!card) return
    await this.state.update(() => { card.deleteAt = Date.now() })
    await this.cleanup()
  }

  async deleteInputMessage(d, message) {
    if (message.message_id) await this.telegram.deleteMessage({ chatId: d.chatId, messageId: message.message_id }).catch(() => {})
  }

  async handleMessage(message) {
    const replyId = message.reply_to_message?.message_id
    const menuReply = this.cards().some((card) => String(card.chatId) === String(message.chat.id) && card.messageId === replyId)
    const input = this.inputs.get(message.from?.id)
    const d = input && this.drafts.get(input.draftId)
    if (!d || d.expires < Date.now() || String(message.chat.id) !== String(d.chatId) || topicId(message) !== d.topicId) return menuReply
    const cancel = message.text === "/cancel"
    if ((!cancel || replyId !== undefined) && Number(replyId) !== input.messageId) return menuReply
    const value = String(message.text || "").trim()
    try {
      if (!value) throw new Error(this.text("Введи текст в строке сообщения.", "Enter text in the message input."))
      if (value !== "/cancel") {
        if (input.field === "title") { if (value.length > 100) throw new Error(this.text("Название должно быть не длиннее 100 символов.", "Use at most 100 characters.")); d.name = value }
        if (input.field === "profileName") { if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u.test(value)) throw new Error(this.text("Используй буквы, цифры, _ и -; не больше 40 символов.", "Use letters, digits, _ and -; at most 40 characters.")); d.profileDraftName = value }
        if (input.field === "search") { d.query = value === "/all" ? "" : value.slice(0, 100); d.modelPage = 0; d.page = "models" }
        if (input.field === "agent") { if (!/^[\p{L}\p{N}_.-]{1,80}$/u.test(value)) throw new Error(this.text("Некорректное имя агента.", "Invalid agent name.")); d.profile.agent = value }
        if (input.field === "directory") {
          if (value !== "/default" && !/^\/|^[a-zA-Z]:[\\/]|^\\\\/.test(value)) throw new Error(this.text("Нужен абсолютный путь.", "An absolute path is required."))
          d.directory = value === "/default" ? this.opencode.defaultNewSessionDirectory(d.serverID) : value
          d.catalog = null
          delete d.launchVariant
        }
      }
      await this.deleteInputMessage(d, message)
      this.inputs.delete(d.userId)
      await this.draw(d)
    } catch (error) {
      await this.deleteInputMessage(d, message)
      d.error = error.message
      await this.ask(d, input.field, input.prompt)
      await this.draw(d)
    }
    return true
  }

  async draw(d) {
    if (d.inputRequest) return this.sendCard(d)
    const html = await this.render(d)
    try { await this.telegram.editRichMessage({ chatId: d.chatId, messageId: d.messageId, html }) }
    catch (error) { if (!/message is not modified/i.test(error.message)) throw error }
    if (this.drafts.get(d.id) === d) await this.rememberCard(d)
  }

  async render(d) {
    d.rev += 1
    d.allowedActions = new Set()
    const b = (text, action, style) => { d.allowedActions.add(action); return { text, callback_data: `launch:${d.id}:${d.rev}:${action}`, style } }
    const back = b(this.text("‹ Назад", "‹ Back"), d.editing ? "editback" : "new")
    const close = b(this.text("Закрыть", "Close"), "close")
    const currentInput = this.inputs.get(d.userId)
    const input = d.inputRequest || (currentInput?.draftId === d.id ? currentInput : null)
    let body = "", rows = []
    if (d.page === "new") {
      await this.prepareLaunch(d)
      const server = this.config.opencode.servers.find((s) => s.id === d.serverID)
      const serverLabel = server?.label && server.label !== d.serverID ? `${server.label} · ${d.serverID}` : d.serverID
      body = `<h2>✦ ${this.text("Новая тема", "New topic")}</h2><p>${escapeHtml(d.name || (input?.field === "title" ? input.prompt : this.text("Выбери название и начни работу", "Choose a name and start working")))}</p>` + this.profileTable(d.profileName, d.launchProfile, true, d.launchReasoning)
      body += `<p>${this.text("Сервер", "Server")}: <b>${escapeHtml(serverLabel)}</b></p>`
      body += `<details><summary>${this.text("Рабочая папка", "Working directory")}</summary><code>${escapeHtml(d.directory || this.text("По умолчанию", "Server default"))}</code></details>`
      if (d.launchError) body += `<blockquote>${escapeHtml(d.launchError)}</blockquote>`
      rows = [[d.launchReady ? b(this.text("Создать тему", "Create topic"), "create", "success") : { text: this.text("Создать тему", "Create topic"), disabled: true }],
        [b(this.text("Название", "Title"), "title"), b(this.text("Профиль", "Profile"), "profiles:choose")],
        ...(this.state.randomTopicNamesEnabled() ? [[b(this.text("🎲 Другое слово", "🎲 Another word"), "randomtitle")]] : []),
        ...(this.config.opencode.servers.length > 1 ? [[b(`${this.text("Сервер", "Server")}: ${d.serverID} ▾`, "servers")]] : []),
        ...(d.launchNeedsVariant ? [[b(this.text("Выбрать reasoning", "Choose reasoning"), "variants")]] : []),
        [b(this.text("Рабочая папка", "Working directory"), "directory"), close]]
    }
    if (d.page === "profiles") {
      const profiles = this.settings.profiles()
      d.profileNames = profiles.map(([name]) => name)
      const pages = Math.max(1, Math.ceil(profiles.length / 12))
      d.profilePage = Math.max(0, Math.min(d.profilePage || 0, pages - 1))
      const start = d.profilePage * 12
      body = `<h2>🎛 ${this.text("Профили", "Profiles")}</h2><p>${this.text("Сохранённые настройки запуска. Недавно использованные — первыми.", "Saved launch settings. Recently used profiles appear first.")}</p>` + menuTable(profiles.slice(start, start + 12).map(([name, p], i) => [richButton(b(`${name}${name === this.settings.data.defaultProfile ? " ★" : ""}`, `profile:${start + i}`)), `<b>${escapeHtml(p.model?.modelID || this.text("Автовыбор", "Automatic"))}</b><br>${escapeHtml(p.model?.variant || "default")}`]), [this.text("Профиль", "Profile"), this.text("Модель · reasoning", "Model · reasoning")])
      if (pages > 1) rows.push([...(d.profilePage ? [b("‹", `profilespage:${d.profilePage - 1}`)] : []), ...(d.profilePage + 1 < pages ? [b("›", `profilespage:${d.profilePage + 1}`)] : [])])
      if (!d.choosing) rows.push([b(this.text("Создать профиль", "Create profile"), "add", "primary"), b(this.text("Удалённые", "Deleted"), "deleted")])
      rows.push([back, close])
    }
    if (d.page === "profile" || d.page === "delete") {
      const p = this.settings.data.profiles[d.selectedProfile]
      body = `<h2>🎛 ${escapeHtml(d.selectedProfile)}</h2>` + this.profileTable(d.selectedProfile, p)
      if (d.page === "delete") { body += `<blockquote>${this.text("Убрать профиль из списка? Существующие темы сохранят свои настройки. Профиль можно восстановить.", "Remove this profile? Existing topics keep their settings. You can restore the profile later.")}</blockquote>`; rows = [[b(this.text("Удалить профиль", "Delete profile"), "deleteconfirm", "danger"), b(this.text("Отмена", "Cancel"), "profiles")]] }
      else rows = [[b(this.text("Изменить", "Edit"), "edit"), b(this.text("Копировать", "Copy"), "copy")], [b(this.text("По умолчанию", "Make default"), "default"), b(this.text("Удалить", "Delete"), "delete", "danger")], [b(this.text("‹ Профили", "‹ Profiles"), "profiles"), close]]
    }
    if (d.page === "deleted") {
      d.deletedNames = Object.keys(this.settings.data.deletedProfiles)
      const pages = Math.max(1, Math.ceil(d.deletedNames.length / 12))
      d.deletedPage = Math.max(0, Math.min(d.deletedPage || 0, pages - 1))
      const start = d.deletedPage * 12
      body = `<h2>${this.text("Удалённые профили", "Deleted profiles")}</h2>`
      rows = d.deletedNames.slice(start, start + 12).map((name, i) => [b(this.text(`Восстановить ${name}`, `Restore ${name}`), `restore:${start + i}`)])
      rows.push([...(d.deletedPage ? [b("‹", `deletedpage:${d.deletedPage - 1}`)] : []), ...(d.deletedPage + 1 < pages ? [b("›", `deletedpage:${d.deletedPage + 1}`)] : [])])
      rows.push([b(this.text("‹ Профили", "‹ Profiles"), "profiles")])
    }
    if (d.page === "edit") {
      body = `<h2>✎ ${escapeHtml(d.profileDraftName || this.text("Новый профиль", "New profile"))}</h2>` + this.profileTable(d.profileDraftName, d.profile)
      rows = [[b(this.text("Сохранить", "Save"), "save", "success")], [b(this.text("Название", "Name"), "name"), b(this.text("Модель", "Model"), "models")], [b("Reasoning", "variants"), b("System", "system"), b(this.text("Агент", "Agent"), "agent")], [b(this.text("Сервер каталога", "Catalog server"), "servers"), b(this.text("‹ Профили", "‹ Profiles"), "profiles"), close]]
    }
    if (d.page === "models") {
      const query = (d.query || "").toLowerCase()
      const models = d.catalog.models.filter((m) => `${m.name} ${m.id} ${m.providerName} ${m.providerID} ${m.family}`.toLowerCase().includes(query))
      const largest = models.reduce((max, m) => Math.max(max, String(m.name || m.id).length + m.id.length + String(m.variants?.join(" · ") || "").length + String(m.providerName || m.providerID).length + String(m.family || "").length + 40), 1)
      const perPage = Math.max(1, Math.min(MODELS_PER_PAGE, Math.floor(24000 / largest)))
      const pages = Math.max(1, Math.ceil(models.length / perPage))
      d.modelPage = Math.max(0, Math.min(d.modelPage || 0, pages - 1))
      d.visibleModels = models.slice(d.modelPage * perPage, (d.modelPage + 1) * perPage)
      body = `<h2>🧭 ${this.text("Каталог моделей", "Model catalog")}</h2><p>${escapeHtml(d.serverID)} · ${this.text("Модели", "Models")}: ${models.length} · ${d.modelPage + 1}/${pages}</p>`
      if (query) body += `<p>${this.text("Поиск", "Search")}: <b>${escapeHtml(d.query)}</b></p>`
      body += buttonRows([[b(this.text("Поиск", "Search"), "search"), b(this.text("Обновить", "Refresh"), "refresh")]])
      const groups = new Map()
      d.visibleModels.forEach((m, i) => { const key = `${m.providerName || m.providerID} · ${m.family || this.text("Другие", "Other")}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push([m, i]) })
      for (const [group, entries] of groups) body += `<details${query || d.expandAll || models.length <= 12 ? " open" : ""}><summary>${escapeHtml(group)} · ${entries.length}</summary>` + menuTable(entries.map(([m, i]) => [richButton(b(m.name || m.id, `model:${i}`, "link")), `<code>${escapeHtml(m.id)}</code><br>${escapeHtml(m.variants?.join(" · ") || "default")}`]), [this.text("Модель", "Model"), "ID · reasoning"]) + "</details>"
      body += `<footer>${this.text("Каталог подключённых провайдеров. Доступ может зависеть от тарифа и квоты аккаунта.", "Connected-provider catalog. Access may depend on your account plan and quota.")}</footer>`
      rows = [...(models.length > 12 ? [[b(d.expandAll ? this.text("Свернуть семейства", "Collapse families") : this.text("Развернуть всё", "Expand all"), `modelsview:${d.expandAll ? "closed" : "open"}`)]] : []), [...(d.modelPage ? [b("‹", `modelpage:${d.modelPage - 1}`)] : []), ...(d.modelPage + 1 < pages ? [b("›", `modelpage:${d.modelPage + 1}`)] : []), back]]
    }
    if (d.page === "variants") {
      d.variants = [...(d.editing ? [""] : []), ...(d.chosenModel?.variants || [])]
      body = `<h2>Reasoning</h2><p><b>${escapeHtml(d.chosenModel?.name || (d.editing ? d.profile : d.launchProfile)?.model?.modelID || "")}</b></p><p>${d.editing ? this.text("Автовыбор наследует значение OpenCodez. Явный выбор сохраняется в профиле.", "Automatic inherits OpenCodez defaults. An explicit choice is saved in the profile.") : this.text("Выбери точный уровень для этой темы. Сохранённый профиль останется прежним.", "Choose the exact level for this topic. The saved profile stays unchanged.")}</p>`
      rows = d.variants.map((v, i) => [b(v || this.text("Автовыбор", "Automatic"), `variant:${i}`)])
      rows.push([back])
    }
    if (d.page === "system") {
      const systems = [null, ...d.catalog.entries.filter((e) => !e.deleted)]
      const pages = Math.max(1, Math.ceil(systems.length / 40))
      d.systemPage = Math.max(0, Math.min(d.systemPage || 0, pages - 1))
      d.systems = systems.slice(d.systemPage * 40, (d.systemPage + 1) * 40)
      body = `<h2>System</h2><p>${this.text("Автовыбор использует назначения моделей и семейств из OpenCodez.", "Automatic uses model and family assignments from OpenCodez.")}</p>`
      // Prompt libraries are small; a collapsed list keeps the editor compact without hiding names.
      body += `<details><summary>${this.text("Доступные System prompts", "Available System prompts")}</summary>${menuTable(d.systems.map((e, i) => [richButton(b(e?.name || this.text("Автовыбор", "Automatic"), `systempick:${i}`, "link"))]))}</details>`
      rows = [[...(d.systemPage ? [b("‹", `systempage:${d.systemPage - 1}`)] : []), ...(d.systemPage + 1 < pages ? [b("›", `systempage:${d.systemPage + 1}`)] : []), back]]
    }
    if (d.page === "servers") {
      body = `<h2>${this.text("Сервер", "Server")}</h2><p>${this.text("Каталог и пути принадлежат выбранному серверу.", "The catalog and paths belong to the selected server.")}</p>`
      rows = this.config.opencode.servers.map((s, i) => [b(`${s.id === d.serverID ? "✓ " : ""}${s.label && s.label !== s.id ? `${s.label} · ${s.id}` : s.id}`, `server:${i}`)])
      rows.push([back])
    }
    if (d.page === "created") {
      body = `<h2>✓ ${this.text("Тема готова", "Topic ready")}</h2><p>${escapeHtml(d.name)}</p><p>${this.text("Открой тему и напиши задачу.", "Open the topic and send your first prompt.")}</p>`
      rows = [[{ text: this.text("Открыть тему", "Open topic"), url: d.topicLink, style: "success" }, close]]
    }
    const notice = d.error || d.notice
    d.error = ""; d.notice = ""
    const question = input && !(d.page === "new" && !d.name && input.field === "title") ? `<b>${escapeHtml(input.prompt)}</b><br>` : ""
    const inputHint = input ? `<blockquote>${question}${this.text("Ответь на эту карточку в строке сообщения. /cancel — отменить ввод.", "Reply to this card using the message input. /cancel cancels input.")}</blockquote>` : ""
    return body + inputHint + (notice ? `<blockquote>${escapeHtml(notice)}</blockquote>` : "") + buttonRows(rows)
  }

  profileTable(name, p = {}, compact = false, reasoning) {
    return menuTable([
      [this.text("Профиль", "Profile"), `<b>${escapeHtml(name || this.text("Не выбран", "Not selected"))}</b>`],
      [this.text("Модель", "Model"), `<code>${escapeHtml(p.model?.modelID ? `${p.model.providerID}/${p.model.modelID}` : this.text("Не выбрана", "Not selected"))}</code>`],
      ["Reasoning", escapeHtml(reasoning || p.model?.variant || this.text("Не задан в профиле", "Not set in profile"))],
      ...(!compact ? [["System", escapeHtml(p.opencodezSystem || this.text("Автовыбор", "Automatic"))], [this.text("Агент", "Agent"), escapeHtml(p.agent || "build")]] : []),
    ])
  }

  forgetDraft(d) {
    this.drafts.delete(d.id)
    const input = this.inputs.get(d.userId)
    if (input?.draftId === d.id) this.inputs.delete(d.userId)
  }

  async close(d) { this.forgetDraft(d); await this.deleteCard(d) }

  expire() {
    for (const d of this.drafts.values()) if (d.expires < Date.now()) this.forgetDraft(d)
  }
}
