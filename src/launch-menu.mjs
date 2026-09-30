import { randomBytes } from "node:crypto"
import { getLanguage } from "./i18n/index.mjs"
import { escapeHtml, telegramMessageLink, topicId } from "./telegram.mjs"
import { buttonRows, menuTable, richButton, localText } from "./menu-format.mjs"
import { logErrorEvent } from "./logger.mjs"

const INPUT_TTL = 15 * 60_000
const MODELS_PER_PAGE = 100

// Short-lived, actor-owned drafts. Saved profiles and launch snapshots belong to UserSettings/StateStore.
export class LaunchMenu {
  constructor({ config, state, telegram, opencode, settings, createSession }) {
    Object.assign(this, { config, state, telegram, opencode, settings, createSession })
    this.drafts = new Map()
    this.inputs = new Map()
    this.lanes = new Map()
  }

  text(ru, en) { return localText(ru, en, getLanguage()) }

  open(query, page = "new") {
    const key = `actor:${query.from.id}`
    const run = (this.lanes.get(key) || Promise.resolve()).then(() => this.openCurrent(query, page))
      .finally(() => { if (this.lanes.get(key) === run) this.lanes.delete(key) })
    this.lanes.set(key, run)
    return run
  }

  async openCurrent(query, page = "new") {
    this.expire()
    const userId = query.from.id
    for (const [id, draft] of this.drafts) if (draft.userId === userId) await this.close(draft)
    const serverID = this.config.defaultPrompt.serverID || this.config.opencode.servers[0].id
    const d = { id: randomBytes(4).toString("hex"), userId, chatId: query.message.chat.id, topicId: topicId(query.message),
      rev: 0, page, expires: Date.now() + INPUT_TTL, serverID,
      name: "", directory: this.opencode.defaultNewSessionDirectory(serverID), profileName: this.settings.data.defaultProfile,
    }
    this.drafts.set(d.id, d)
    const sent = await this.telegram.sendRichMessage({ chatId: d.chatId, topicId: d.topicId, html: await this.render(d),
      ephemeral: { receiver_user_id: userId, callback_query_id: query.id } })
    if (!sent?.ephemeral_message_id) {
      this.drafts.delete(d.id)
      throw new Error("Bot API 10.3 ephemeral messages are required. Update your local Bot API server.")
    }
    d.messageId = sent.ephemeral_message_id
    if (page === "new") await this.ask(d, "title", this.text("Как назвать новую тему?", "What should the new topic be called?"))
    return d
  }

  async handleCallback(query) {
    if (!String(query.data || "").startsWith("launch:")) return false
    const [, id, rev, ...parts] = query.data.split(":")
    const action = parts.join(":")
    const prior = this.lanes.get(id) || Promise.resolve()
    const run = prior.then(async () => {
      const d = this.drafts.get(id)
      if (!d || d.expires < Date.now() || d.userId !== query.from.id || String(d.chatId) !== String(query.message?.chat?.id)
        || Number(query.message?.ephemeral_message_id) !== d.messageId || Number(rev) !== d.rev || !d.allowedActions?.has(action)) {
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
    if (verb === "new") { d.page = "new"; d.editing = false; return }
    if (verb === "title") return this.ask(d, "title", this.text("Название темы", "Topic title"))
    if (verb === "profiles") { d.page = "profiles"; d.choosing = arg === "choose"; d.profilePage = 0; return }
    if (verb === "profilespage") { d.profilePage = Number(arg); return }
    if (verb === "profile") {
      const name = d.profileNames?.[Number(arg)]
      if (!name || !this.settings.data.profiles[name]) throw new Error("Profile is unavailable")
      if (d.choosing) { d.profileName = name; d.page = "new"; d.choosing = false; return }
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
    if (verb === "advanced") { d.page = "advanced"; return }
    if (verb === "directory") return this.ask(d, "directory", this.text("Абсолютный путь к рабочей папке на выбранном сервере. /default — домашняя папка.", "Absolute working directory on the selected server. /default uses the server home."))
    if (verb === "servers") { d.page = "servers"; return }
    if (verb === "server") {
      const server = this.config.opencode.servers[Number(arg)]
      if (!server) throw new Error("Server is unavailable")
      d.serverID = server.id; d.directory = this.opencode.defaultNewSessionDirectory(server.id); d.catalog = null
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
      d.chosenModel = d.catalog.models.find((m) => m.id === d.profile.model?.modelID && m.providerID === d.profile.model?.providerID)
      d.page = "variants"; return
    }
    if (verb === "variant") {
      const value = d.variants?.[Number(arg)]
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
      const profile = this.settings.data.profiles[d.profileName] || this.config.defaultPrompt
      if (d.confirmedProfile && d.confirmedProfile !== JSON.stringify(profile)) {
        d.notice = this.text("Настройки профиля изменились. Проверь модель и подтверди создание ещё раз.", "The profile settings changed. Check the model and confirm creation again.")
        return
      }
      await this.validate(d, profile)
      const topic = await this.createSession({ chat: { id: d.chatId }, from: { id: d.userId } }, {
        serverID: d.serverID, title: d.name, titleSource: "user", directory: d.directory,
        requestKey: `wizard:${d.id}`,
        promptProfileName: d.profileName || null, promptProfile: structuredClone(profile),
      })
      if (!topic?.message_thread_id) throw new Error("Topic was not created")
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
      && !catalog.entries.some((e) => e.id === profile.opencodezSystem || e.name === profile.opencodezSystem)) throw new Error("The profile's System prompt is unavailable on this server.")
  }

  async ask(d, field, text) {
    const previous = this.inputs.get(d.userId)
    if (previous) await this.telegram.deleteMessage({ chatId: d.chatId, messageId: previous.messageId }).catch(() => {})
    const prompt = await this.telegram.sendMessage({ chatId: d.chatId, topicId: d.topicId, text: `<b>${escapeHtml(text)}</b>\n<a href="tg://user?id=${d.userId}">${this.text("Ответь на это сообщение.", "Reply to this message.")}</a> ${this.text("/cancel — отменить ввод.", "/cancel cancels input.")}`,
      replyMarkup: { force_reply: true, selective: true } })
    this.inputs.set(d.userId, { draftId: d.id, field, messageId: prompt.message_id })
  }

  async handleMessage(message) {
    const input = this.inputs.get(message.from?.id)
    const d = input && this.drafts.get(input.draftId)
    if (!d || d.expires < Date.now() || String(message.chat.id) !== String(d.chatId) || topicId(message) !== d.topicId
      || (message.reply_to_message?.message_id !== input.messageId && message.text !== "/cancel")) return false
    const value = String(message.text || "").trim()
    if (!value) return true
    try {
      if (value !== "/cancel") {
        if (input.field === "title") { if (value.length > 100) throw new Error(this.text("Название должно быть не длиннее 100 символов.", "Use at most 100 characters.")); d.name = value }
        if (input.field === "profileName") { if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u.test(value)) throw new Error(this.text("Используй буквы, цифры, _ и -; не больше 40 символов.", "Use letters, digits, _ and -; at most 40 characters.")); d.profileDraftName = value }
        if (input.field === "search") { d.query = value === "/all" ? "" : value.slice(0, 100); d.modelPage = 0; d.page = "models" }
        if (input.field === "agent") { if (!/^[\p{L}\p{N}_.-]{1,80}$/u.test(value)) throw new Error(this.text("Некорректное имя агента.", "Invalid agent name.")); d.profile.agent = value }
        if (input.field === "directory") {
          if (value !== "/default" && !/^\/|^[a-zA-Z]:[\\/]|^\\\\/.test(value)) throw new Error(this.text("Нужен абсолютный путь.", "An absolute path is required."))
          d.directory = value === "/default" ? this.opencode.defaultNewSessionDirectory(d.serverID) : value
        }
      }
      await this.telegram.deleteMessage({ chatId: d.chatId, messageId: message.message_id }).catch(() => {})
      await this.telegram.deleteMessage({ chatId: d.chatId, messageId: input.messageId }).catch(() => {})
      this.inputs.delete(d.userId)
      await this.draw(d)
    } catch (error) {
      await this.telegram.replyMessage({ message, text: escapeHtml(error.message) })
    }
    return true
  }

  async draw(d) {
    const html = await this.render(d)
    try { await this.telegram.editRichMessage({ chatId: d.chatId, receiverUserId: d.userId, ephemeralMessageId: d.messageId, html }) }
    catch (error) { if (!/message is not modified/i.test(error.message)) throw error }
  }

  async render(d) {
    d.rev += 1
    d.allowedActions = new Set()
    const b = (text, action, style) => { d.allowedActions.add(action); return { text, callback_data: `launch:${d.id}:${d.rev}:${action}`, style } }
    const back = b(this.text("‹ Назад", "‹ Back"), d.editing ? "editback" : "new")
    const close = b(this.text("Закрыть", "Close"), "close")
    const footer = `<footer>${this.text("Личный экран · другие участники не видят этот выбор", "Personal screen · other members cannot see these choices")}</footer>`
    let body = "", rows = []
    if (d.page === "new") {
      const profile = this.settings.data.profiles[d.profileName] || this.config.defaultPrompt
      d.confirmedProfile = JSON.stringify(profile)
      body = `<h2>✦ ${this.text("Новая тема", "New topic")}</h2><p>${escapeHtml(d.name || this.text("Выбери название и начни работу", "Choose a name and start working"))}</p>` + this.profileTable(d.profileName, profile, true)
      if (this.config.opencode.servers.length > 1) body += `<p>${this.text("Сервер", "Server")}: <b>${escapeHtml(d.serverID)}</b></p>`
      body += `<details><summary>${this.text("Рабочая папка", "Working directory")}</summary><code>${escapeHtml(d.directory || this.text("По умолчанию", "Server default"))}</code></details>`
      rows = [[b(this.text("Создать тему", "Create topic"), "create", "success")], [b(this.text("Название", "Title"), "title"), b(this.text("Профиль", "Profile"), "profiles:choose")], [b(this.text("Другие параметры", "Other options"), "advanced"), close]]
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
      d.variants = ["", ...(d.chosenModel?.variants || [])]
      body = `<h2>Reasoning</h2><p><b>${escapeHtml(d.chosenModel?.name || d.profile.model?.modelID || "")}</b></p><p>${this.text("Автовыбор наследует значение OpenCodez. Явный выбор сохраняется в профиле.", "Automatic inherits OpenCodez defaults. An explicit choice is saved in the profile.")}</p>`
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
    if (d.page === "advanced") {
      body = `<h2>${this.text("Параметры темы", "Topic options")}</h2><p>${escapeHtml(d.serverID)}</p><code>${escapeHtml(d.directory || "default")}</code>`
      rows = [[b(this.text("Рабочая папка", "Working directory"), "directory")], ...(this.config.opencode.servers.length > 1 ? [[b(this.text("Сервер", "Server"), "servers")]] : []), [back]]
    }
    if (d.page === "servers") {
      body = `<h2>${this.text("Сервер", "Server")}</h2><p>${this.text("Каталог и пути принадлежат выбранному серверу.", "The catalog and paths belong to the selected server.")}</p>`
      rows = this.config.opencode.servers.map((s, i) => [b(s.label || s.id, `server:${i}`)])
      rows.push([back])
    }
    if (d.page === "created") {
      body = `<h2>✓ ${this.text("Тема готова", "Topic ready")}</h2><p>${escapeHtml(d.name)}</p><p>${this.text("Открой тему и напиши задачу.", "Open the topic and send your first prompt.")}</p>`
      rows = [[{ text: this.text("Открыть тему", "Open topic"), url: d.topicLink, style: "success" }, close]]
    }
    const notice = d.error || d.notice
    d.error = ""; d.notice = ""
    return body + (notice ? `<blockquote>${escapeHtml(notice)}</blockquote>` : "") + buttonRows(rows) + footer
  }

  profileTable(name, p = {}, compact = false) {
    return menuTable([
      [this.text("Профиль", "Profile"), `<b>${escapeHtml(name || this.text("По умолчанию", "Default"))}</b>`],
      [this.text("Модель", "Model"), `<b>${escapeHtml(p.model?.modelID || this.text("Автовыбор OpenCodez", "OpenCodez automatic"))}</b>`],
      ["Reasoning", escapeHtml(p.model?.variant || this.text("Автовыбор", "Automatic"))],
      ...(!compact ? [["System", escapeHtml(p.opencodezSystem || this.text("Автовыбор", "Automatic"))], [this.text("Агент", "Agent"), escapeHtml(p.agent || "build")]] : []),
    ])
  }

  async close(d) {
    this.drafts.delete(d.id)
    const input = this.inputs.get(d.userId)
    if (input?.draftId === d.id) { this.inputs.delete(d.userId); await this.telegram.deleteMessage({ chatId: d.chatId, messageId: input.messageId }).catch(() => {}) }
    if (d.messageId) await this.telegram.request("deleteEphemeralMessage", { chat_id: d.chatId, receiver_user_id: d.userId, ephemeral_message_id: d.messageId }).catch(() => {})
  }

  expire() {
    for (const [id, d] of this.drafts) if (d.expires < Date.now()) { this.drafts.delete(id); if (this.inputs.get(d.userId)?.draftId === id) this.inputs.delete(d.userId) }
  }
}
