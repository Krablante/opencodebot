import { getLanguage } from "./i18n/index.mjs"
import { escapeHtml, telegramMessageLink, topicId } from "./telegram.mjs"
import { buttonRows, menuTable, localText } from "./menu-format.mjs"
import { guidePage } from "./user-guide.mjs"
import { normalizeTelegramRichMessage } from "./telegram-rich-message.mjs"

export class Setup {
  constructor({ config, state, telegram, settings, speech, randomTopicIcon, enableGateway, onReady }) {
    Object.assign(this, { config, state, telegram, settings, speech, randomTopicIcon, enableGateway, onReady })
    this.operation = Promise.resolve()
  }
  text(ru, en) { return localText(ru, en, getLanguage()) }

  async open(message) {
    const run = this.operation.then(() => this.openCurrent(message))
    this.operation = run.catch(() => {})
    return run
  }

  async openCurrent(message) {
    const chatId = this.state.chatId || this.config.telegram.chatId || message.chat.id
    const [chat, me] = await Promise.all([this.telegram.request("getChat", { chat_id: chatId }), this.telegram.getMe()])
    if (!chat.is_forum) return this.telegram.sendMessage({ chatId, topicId: topicId(message), text: this.text("Включи темы в настройках группы и снова запусти /setup.", "Enable topics in this group's settings and run /setup again.") })
    const rights = await this.telegram.request("getChatMember", { chat_id: chatId, user_id: me.id })
    const missing = []
    if (!["administrator", "creator"].includes(rights.status)) missing.push(this.text("статус администратора", "administrator status"))
    if (rights.status !== "creator" && !rights.can_manage_topics) missing.push(this.text("управление темами", "manage topics"))
    if (rights.status !== "creator" && !rights.can_pin_messages) missing.push(this.text("закрепление сообщений", "pin messages"))
    if (rights.status !== "creator" && !rights.can_delete_messages) missing.push(this.text("удаление сообщений", "delete messages"))
    if (missing.length) {
      return this.telegram.sendRichMessage({ chatId, topicId: topicId(message), html: `<h2>🔧 Setup</h2><p>${this.text("Выдай боту права", "Grant the bot these rights")}: <b>${escapeHtml(missing.join(", "))}</b>.</p>` + buttonRows([[{ text: this.text("Проверить снова", "Check again"), callback_data: "setup:check" }]]) })
    }
    if (!this.state.chatId) await this.state.setChatId(chatId)
    await this.ensureTopic("files", chatId, message.from.id)
    await this.ensureTopic("audio", chatId, message.from.id)
    if (this.speech.configured()) await this.speech.createOrRefreshMenu()
    await this.ensureNotifications(message.from.id)
    if (!this.state.data.preferences.setupComplete) {
      const panel = await this.onReady?.(message)
      await this.telegram.sendRichMessage({ chatId, topicId: 0, html: guidePage(0, getLanguage()).html
        + (panel?.message_id ? buttonRows([[{ text: this.text("Открыть меню и полный гайд", "Open the menu and full guide"), url: telegramMessageLink(chatId, panel.message_id) }]]) : "") })
      await this.state.update((data) => { data.preferences.setupComplete = true })
    }
    const status = this.statusHtml(me.username)
    const existing = this.state.data.preferences.setupMenu
    if (existing?.messageId && String(existing.chatId) === String(chatId) && Number(message.message_id) === existing.messageId) {
      try { await this.telegram.editRichMessage({ chatId, messageId: existing.messageId, html: status }); return }
      catch (error) { if (/message is not modified/i.test(error.message)) return; if (!/message to edit not found|can't be edited/i.test(error.message)) throw error }
    }
    const sent = await this.telegram.sendRichMessage({ chatId, topicId: topicId(message), html: status })
    await this.state.update((data) => { data.preferences.setupMenu = { chatId, messageId: sent.message_id, topicId: topicId(message) } })
    if (existing?.messageId) await this.telegram.deleteMessage({ chatId: existing.chatId, messageId: existing.messageId }).catch(() => {})
  }

  async ensureTopic(kind, chatId, userId) {
    const current = kind === "files" ? this.state.artifactsTopic() : this.state.soundsTopic()
    if (current) return current
    const icon = await this.randomTopicIcon()
    const topic = await this.telegram.createForumTopic({ chatId, name: kind === "files" ? "FILES" : "AUDIO", iconCustomEmojiId: icon?.customEmojiId })
    const value = { chatId, topicId: topic.message_thread_id, title: kind === "files" ? "FILES" : "AUDIO", setBy: userId }
    if (kind === "files") await this.state.setArtifactsTopic(value)
    else await this.state.setSoundsTopic(value)
    const text = kind === "files"
      ? this.text("📎 <b>FILES</b>\nЗдесь появляются файлы от агента. Прикрепи файл, чтобы сохранить его на настроенном сервере. /setup — проверить подключение.", "📎 <b>FILES</b>\nAgent artifacts arrive here. Drop a file to save it on the configured server. /setup checks the connection.")
      : this.text("🎙 <b>AUDIO</b>\nОтправляй голосовые и аудиофайлы для расшифровки. Текст не отправляется агенту автоматически. /setup — подключить распознавание.", "🎙 <b>AUDIO</b>\nSend voice notes and audio files for transcription. Text is never sent to an agent automatically. /setup connects speech recognition.")
    const sent = await this.telegram.sendMessage({ chatId, topicId: value.topicId, text })
    await this.telegram.pinChatMessage({ chatId, messageId: sent.message_id, disableNotification: true })
    return value
  }

  async ensureNotifications(userId) {
    if (!this.config.finalNotifications.enabled || !this.config.finalNotifications.userIds.map(Number).includes(Number(userId))) return false
    if (this.state.data.preferences.notificationChoices?.[String(userId)] === false) return false
    if (this.state.finalNotificationsEnabledFor(userId)) return true
    try {
      await this.telegram.sendMessage({ chatId: userId, text: this.text("✓ Уведомления OpenCodeBot включены. Финальные ответы, вопросы и сбои будут приходить сюда.", "✓ OpenCodeBot notifications are enabled. Final answers, questions and failures will be linked here.") })
      await this.state.setFinalNotificationsEnabledFor(userId, true)
      return true
    } catch { return false }
  }

  statusHtml(username) {
    const files = this.state.artifactsTopic(), audio = this.state.soundsTopic()
    const connections = Object.keys(this.state.data.preferences.artifactClients || {})
    const ready = this.config.artifacts.enabled && Boolean(this.config.artifacts.token)
    return `<h2>🔧 ${this.text("Подключения", "Connections")}</h2>` + menuTable([
      ["FILES", files ? this.text("Тема готова", "Topic ready") : "—"],
      [this.text("Транспорт файлов", "Artifact transport"), ready ? (connections.length ? this.text(`Подтверждён: ${connections.join(", ")}`, `Confirmed: ${connections.join(", ")}`) : this.text("Gateway готов · плагин ещё не проверен", "Gateway ready · plugin not yet verified")) : this.text("Нужно включить gateway", "Enable the gateway")],
      ["AUDIO", this.speech.configured() ? this.text("Распознавание подключено", "Transcription connected") : this.text("Нужен ключ Groq", "Groq key needed")],
      [this.text("Сохранение входящих файлов", "Incoming file storage"), this.config.artifactUploads.enabled ? this.text("Настроено · проверяется загрузкой файла", "Configured · verify by uploading a file") : this.text("Отключено", "Disabled")],
    ]) + `<p>${this.text("Работа с агентом доступна независимо от этих подключений.", "Agent conversations work independently of these connections.")}</p>` + buttonRows([
      ...(files && audio ? [[{ text: "FILES ↗", url: telegramMessageLink(files.chatId, files.topicId) }, { text: "AUDIO ↗", url: telegramMessageLink(audio.chatId, audio.topicId) }]] : []),
      [{ text: this.text("Подключить / изменить Groq", "Connect / change Groq"), callback_data: "setup:audio" }],
      [{ text: this.text("Инструкция для файлового плагина", "Artifact plugin instructions"), callback_data: "setup:files" }],
      ...(!ready ? [[{ text: this.text("Включить файловый gateway", "Enable artifact gateway"), callback_data: "setup:gateway" }]] : []),
      [{ text: this.text("Включить личные уведомления", "Start private notifications"), url: `https://t.me/${username}?start=notify` }, { text: this.text("Проверить снова", "Check again"), callback_data: "setup:check" }],
    ]) + `<details><summary>${this.text("Закрепление тем", "Pinning topics")}</summary><p>${this.text("Закрепи General, FILES и AUDIO в списке тем вручную. Bot API умеет закреплять сообщения, но не сами темы.", "Pin General, FILES and AUDIO in your topic list manually. Bot API can pin messages, but not topics.")}</p></details>`
  }

  async handleCallback(query) {
    if (!String(query.data || "").startsWith("setup:")) return false
    await this.telegram.answerCallbackQuery({ callbackQueryId: query.id })
    const message = { ...query.message, from: query.from }
    if (query.data === "setup:check") await this.open(message)
    if (query.data === "setup:audio") await this.askAudio(message)
    if (query.data === "setup:files") await this.fileInstructions(message)
    if (query.data === "setup:gateway") { await this.settings.enableArtifacts(); this.enableGateway?.(); await this.open(message) }
    if (query.data === "setup:address") {
      const prompt = await this.inputPrompt(message, this.text("Адрес gateway, доступный с сервера OpenCodez, например http://bot-host:8788.", "Gateway address reachable from OpenCodez, for example http://bot-host:8788."))
      await this.state.update((data) => { data.preferences.gatewayInput = { userId: message.from.id, chatId: message.chat.id, topicId: topicId(message), promptId: prompt.message_id, expires: Date.now() + 15 * 60_000 } })
    }
    if (query.data === "setup:token" && this.config.artifacts.token) {
      await this.telegram.sendRichMessage({ chatId: message.chat.id, topicId: topicId(message), ephemeral: { receiver_user_id: message.from.id, callback_query_id: query.id },
        html: `<h2>Artifact token</h2><p>${this.text("Этот экран виден только тебе. Передай ключ своему агенту для настройки транспорта.", "Only you can see this screen. Give this key to your agent to configure transport.")}</p><pre>${escapeHtml(this.config.artifacts.token)}</pre>` })
    }
    return true
  }

  async askAudio(message) {
    const prompt = await this.inputPrompt(message, this.text("🎙 <b>Подключить Groq</b>\n1. Зарегистрируйся на https://console.groq.com/home\n2. Открой API Keys и создай ключ.\n3. Отправь ключ здесь, в этой теме.\n\nВыберем Whisper Large V3 Turbo. На бесплатном тарифе есть лимиты. Бот удалит сообщение с ключом после обработки. /cancel — отмена.", "🎙 <b>Connect Groq</b>\n1. Sign up at https://console.groq.com/home\n2. Open API Keys and create a key.\n3. Send the key here in this topic.\n\nWhisper Large V3 Turbo will be selected. The free tier has limits. The bot removes the key message after processing. /cancel cancels setup."))
    await this.state.update((data) => {
      data.preferences.audioInputs ||= {}
      data.preferences.audioInputs[String(message.from.id)] = { chatId: message.chat.id, topicId: topicId(message), promptId: prompt.message_id, expires: Date.now() + 15 * 60_000 }
    })
  }

  inputPrompt(message, text) {
    return this.telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message),
      text: `${text}\n<a href="tg://user?id=${message.from.id}">${this.text("Ответь на это сообщение.", "Reply to this message.")}</a>`,
      replyMarkup: { force_reply: true, selective: true } })
  }

  // This happens before inbox receipt. The durable journal never receives provider keys.
  async prepareUpdate(update) {
    const run = (this.keyOperation || Promise.resolve()).then(() => this.prepareCurrentUpdate(update))
    this.keyOperation = run.catch(() => {})
    return run
  }

  async prepareCurrentUpdate(update) {
    const message = update.message
    if (!message) return update
    if (message.setupKeyResult) return update
    const value = String(message.text || message.caption || (message.rich_message ? normalizeTelegramRichMessage(message.rich_message).text : "")).trim()
    const pending = this.state.data.preferences.audioInputs?.[String(message.from?.id)]
    const allowed = this.config.telegram.allowedUserIds.includes(Number(message.from?.id))
    const configuredChatId = this.state.chatId || this.config.telegram.chatId
    if (configuredChatId && String(configuredChatId) !== String(message.chat?.id)) return scrubKeyReferences(update)
    const expected = allowed && pending && pending.expires >= Date.now() && String(pending.chatId) === String(message.chat?.id) && pending.topicId === topicId(message)
    if (!/^gsk_[A-Za-z0-9_-]+$/.test(value) && !(expected && value && message.reply_to_message?.message_id === pending.promptId && value !== "/cancel" && !value.startsWith("/"))) return scrubKeyReferences(update)
    let status = "unexpected"
    try {
      if (expected) {
        await this.settings.storeGroqKey(value)
        await this.state.setSpeechModelId("groq/whisper-large-v3-turbo")
        status = "connected"
      }
    } catch { status = "failed" }
    await this.telegram.deleteMessage({ chatId: message.chat.id, messageId: message.message_id }).catch(() => {})
    const safe = scrubKeyReferences(update)
    safe.message.text = ""
    delete safe.message.caption
    delete safe.message.rich_message
    safe.message.setupKeyResult = status
    return safe
  }

  async handleMessage(message) {
    const gateway = this.state.data.preferences.gatewayInput
    if (gateway && gateway.expires >= Date.now() && gateway.userId === message.from?.id && String(gateway.chatId) === String(message.chat.id)
      && gateway.topicId === topicId(message) && gateway.promptId === message.reply_to_message?.message_id) {
      try {
        if (message.text !== "/cancel") await this.settings.setGatewayUrl(String(message.text || "").trim())
        await this.state.update((data) => { delete data.preferences.gatewayInput })
        await this.telegram.deleteMessage({ chatId: message.chat.id, messageId: gateway.promptId }).catch(() => {})
        await this.telegram.deleteMessage({ chatId: message.chat.id, messageId: message.message_id }).catch(() => {})
        await this.fileInstructions(message)
      } catch { await this.telegram.replyMessage({ message, text: this.text("Нужен HTTP(S) адрес без ключей и параметров.", "Use an HTTP(S) address without credentials or query parameters.") }) }
      return true
    }
    if (message.setupKeyResult) {
      await this.telegram.sendMessage({ chatId: message.chat.id, topicId: topicId(message), text: message.setupKeyResult === "connected"
        ? this.text("✓ Groq подключён · Whisper Large V3 Turbo. Отправь голосовое в AUDIO для проверки.", "✓ Groq connected · Whisper Large V3 Turbo. Send a voice note to AUDIO to verify.")
        : this.text("Ключ не принят. Запусти подключение Groq через /setup и проверь ключ.", "The key was not accepted. Open Groq setup with /setup and check the key.") })
      if (message.setupKeyResult === "connected") {
        const promptId = this.state.data.preferences.audioInputs?.[String(message.from.id)]?.promptId
        await this.state.update((data) => { delete data.preferences.audioInputs?.[String(message.from.id)] })
        if (promptId) await this.telegram.deleteMessage({ chatId: message.chat.id, messageId: promptId }).catch(() => {})
        if (this.state.soundsTopic()) await this.speech.createOrRefreshMenu()
      }
      return true
    }
    const pending = this.state.data.preferences.audioInputs?.[String(message.from?.id)]
    if (pending && String(pending.chatId) === String(message.chat.id) && pending.topicId === topicId(message) && message.text === "/cancel") {
      await this.state.update((data) => { delete data.preferences.audioInputs[String(message.from.id)] })
      await this.telegram.deleteMessage({ chatId: message.chat.id, messageId: pending.promptId }).catch(() => {})
      return true
    }
    return false
  }

  async fileInstructions(message) {
    const prompt = this.text(
      "Подключи файловый транспорт OpenCodeBot в моём OpenCodez. Репозиторий: https://github.com/Krablante/opencodebot. Установи plugins/opencodebot-artifacts и полный каталог skills/telegram-artifact-send, включая agents/openai.yaml. Сохрани существующие настройки. Адрес gateway и отдельный OPENCODEBOT_ARTIFACT_TOKEN возьми из приватной конфигурации моего бота; если доступа нет, запроси их у меня. Не используй Telegram bot token. Настрой plugin в поддерживаемой конфигурации OpenCodez и проверь доступ к gateway. Перезапускай только необходимый OpenCodez процесс после сохранения работы. Заверши тестовой отправкой небольшого файла в FILES через opencodebot_send_artifact. Сообщи, что проверено, а что осталось недоступным.",
      "Connect the OpenCodeBot artifact transport to my OpenCodez. Repository: https://github.com/Krablante/opencodebot. Install plugins/opencodebot-artifacts and the complete skills/telegram-artifact-send directory, including agents/openai.yaml. Preserve existing configuration. Obtain the gateway address and separate OPENCODEBOT_ARTIFACT_TOKEN from my bot's private configuration; ask me if unavailable. Never use the Telegram bot token. Configure the supported OpenCodez plugin entry and verify gateway access. Restart only the necessary OpenCodez process after preserving work. Finish by sending a small test file to FILES through opencodebot_send_artifact. Report what was verified and anything still unavailable.")
      + (this.config.artifacts.gatewayUrl ? `\nOPENCODEBOT_ARTIFACT_GATEWAY_URL=${this.config.artifacts.gatewayUrl}` : "")
    await this.telegram.sendRichMessage({ chatId: message.chat.id, topicId: topicId(message), html: `<h2>📎 ${this.text("Файловый транспорт", "Artifact transport")}</h2><p>${this.text("Скопируй инструкцию и передай своему агенту OpenCodez.", "Copy these instructions and give them to your OpenCodez agent.")}</p><pre>${escapeHtml(prompt)}</pre>` + buttonRows([[{ text: this.text("Адрес gateway", "Gateway address"), callback_data: "setup:address" }, { text: this.text("Получить artifact token", "Get artifact token"), callback_data: "setup:token" }]]) + `<details><summary>${this.text("Сеть и сохранение входящих файлов", "Network and incoming files")}</summary><p>${this.text("Gateway должен быть доступен с сервера агента. Папка для входящих файлов должна быть доступна контейнеру или через настроенный SSH transfer. /setup не может создать mount на другом компьютере.", "The gateway must be reachable from the agent server. Incoming-file storage must be accessible through a container mount or configured SSH transfer. /setup cannot create mounts on another computer.")}</p></details>` })
  }
}

function scrubKeyReferences(update) {
  const text = JSON.stringify(update)
  return text.includes("gsk_") ? JSON.parse(text.replace(/gsk_[A-Za-z0-9_-]+/g, "[provider key removed]")) : update
}
