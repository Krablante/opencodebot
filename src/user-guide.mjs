const pages = {
  ru: [
    ["✦ Добро пожаловать", "<p>General — место для создания тем и настройки бота. Рабочая тема — разговор с агентом OpenCodez.</p><blockquote>Нажми <b>Новая тема</b>, проверь название и модель, создай тему и начни писать.</blockquote><p>Название по умолчанию — старинное или образное русское слово со случайным регистром. «Другое слово» выбирает заново, «Название» позволяет вписать своё. Режим отключается в Настройках.</p><p>FILES собирает файлы. AUDIO превращает голосовые и аудиофайлы в текст. Эти подключения можно закончить позже.</p>"],
    ["✦ Создание через мастер", `
      <p><b>Новая тема</b> в General или <code>/new</code> без аргументов открывает карточку создания в чате. Управлять ей может только открывший её пользователь.</p>
      <table striped compact><tr><th>Поле</th><th>Что выбрать</th></tr>
      <tr><td>Название</td><td>Оставить случайное слово, выбрать «Другое слово» или вписать своё. При отключённом режиме бот сразу спрашивает имя.</td></tr>
      <tr><td>Профиль</td><td>Сохранённые модель, reasoning, System и агент. Начальный выбор берётся из настроек запуска.</td></tr>
      <tr><td>Сервер</td><td>Подключение OpenCodez, на котором пойдёт работа. При одном сервере выбор фиксирован.</td></tr>
      <tr><td>Рабочая папка</td><td>Полный путь на выбранном сервере. <code>/default</code> возвращает его папку по умолчанию.</td></tr></table>
      <p>Проверь точные провайдер/модель и reasoning. Если уровень не задан или недоступен, выбери поддерживаемый для этой темы. Это не меняет сохранённый профиль. Смена сервера заново выбирает папку по умолчанию и проверяет модель.</p>
      <p>Если модель, System или сервер недоступны, выбери другой профиль/сервер либо восстанови подключение и провайдер в OpenCodez. Изменённый во время выбора профиль требует повторного подтверждения.</p>
      <blockquote><b>Создать тему</b> сначала создаёт топик Telegram. Сессия OpenCodez появится после первого обычного сообщения с задачей. Тогда можно пользоваться <code>/q</code> и проверить запуск через <code>/session</code>.</blockquote>
      <p>Выбранное имя и параметры сохраняются до создания. «Закрыть» отменяет черновик; <code>/cancel</code> отменяет только ввод поля. Черновик действует 15 минут и исчезает после перезапуска бота.</p>
      <p>Карточка «Тема готова» удаляется через две минуты. Перезапуск бота сохраняет срок удаления.</p>
    `],
    ["⌨ Быстрое создание: /new", `
      <p>С аргументами команда сразу создаёт тему. Общая форма; квадратные скобки обозначают необязательные части:</p>
      <pre>/new [server] [profile] [dir:&lt;path&gt;] [title]</pre>
      <p><code>local</code> ниже — пример ID из списка серверов, <code>sol</code> — имя сохранённого профиля. Подставь свои значения.</p>
      <table striped compact><tr><th>Команда</th><th>Результат</th></tr>
      <tr><td><code>/new</code></td><td>Мастер создания темы</td></tr>
      <tr><td><code>/new Название</code></td><td>Своё имя, остальные настройки по умолчанию</td></tr>
      <tr><td><code>/new sol</code></td><td>Профиль sol, основной сервер</td></tr>
      <tr><td><code>/new local</code></td><td>Сервер local, настройки запуска по умолчанию</td></tr>
      <tr><td><code>/new sol Название</code></td><td>Профиль и своё имя</td></tr>
      <tr><td><code>/new local Название</code></td><td>Сервер и своё имя</td></tr>
      <tr><td><code>/new local sol</code></td><td>Сервер и профиль</td></tr>
      <tr><td><code>/new local sol Название</code></td><td>Сервер, профиль и своё имя</td></tr></table>
      <p>Без сервера используется основной; без профиля — настройки запуска по умолчанию. Без имени выбирается случайное слово. При отключённом режиме начальное имя берётся из профиля или названия сервера.</p>
      <p><code>dir:</code> и <code>directory:</code> равнозначны и работают с любой формой команды. Путь относится к выбранному серверу; без него используется его настроенная папка или default OpenCodez.</p>
      <pre>/new local sol dir:/workspace Название</pre>
      <p>Путь с пробелами заключай в кавычки. Название может состоять из нескольких слов:</p>
      <pre>/new local sol "dir:/workspace/My Project" Мой проект</pre>
      <blockquote>Сервер распознаётся первым, профиль — следующим. Только точные настроенные ID и имена имеют значение: опечатка может стать названием. Для имени, совпадающего с сервером или профилем, укажи оба явно: <code>/new local sol sol</code> назовёт тему «sol».</blockquote>
    `],
    ["🎛 Профили и модели", `
      <p>Профиль сохраняет модель, reasoning и при необходимости System и агента. Создавай, копируй, изменяй и удаляй профили в General → Профили. Удалённый профиль можно восстановить из списка «Удалённые».</p>
      <p>Назначь основной профиль кнопкой «По умолчанию». Если нужен другой только для одной темы, выбери его в мастере или укажи после сервера в <code>/new</code>.</p>
      <p>Каталог берётся с выбранного сервера OpenCodez. Модели сгруппированы по провайдеру и семейству; поиск понимает название, ID и провайдера. «Обновить» перечитывает каталог. Выбирай модель и поддерживаемый уровень reasoning, затем сохраняй профиль.</p>
      <p>Каталог и варианты на разных серверах могут различаться. Наличие модели в списке не гарантирует квоту у провайдера. Если она недоступна, проверь подключение и тариф в OpenCodez либо выбери другую.</p>
      <blockquote>Сохранение, удаление или смена основного профиля не меняет уже работающие сессии. Новые темы получают свои показанные настройки; выбранные при создании модель и reasoning сохраняются для повторного запуска.</blockquote>
    `],
    ["💬 Ежедневная работа", `
      <p>Первую задачу отправь обычным сообщением в новой теме. Изображения и файлы можно приложить к тексту. Файлы без подписи ждут следующего текстового сообщения.</p>
      <table striped compact><tr><th>Команда</th><th>Действие</th></tr>
      <tr><td><code>/session</code></td><td>ID сессии с копированием, сервер, модель и состояние; в подробностях — тема этой команды и получатели файлов/аудио</td></tr>
      <tr><td><code>/q задача</code></td><td>Отправить задачу или добавить в очередь уже созданной сессии</td></tr>
      <tr><td><code>/q</code> или <code>/q status</code></td><td>Посмотреть очередь</td></tr>
      <tr><td><code>/q delete N</code></td><td>Убрать элемент очереди по номеру</td></tr>
      <tr><td><code>/kill</code></td><td>Остановить работу и очистить очередь</td></tr>
      <tr><td><code>/compact</code></td><td>Сжать контекст завершённой сессии</td></tr></table>
      <p>В длинном промпте достаточно одного <code>/q</code> в начале: части собираются в одну задачу после двух секунд тишины. В Rich Message команда может начинать абзац или заголовок; текст и фотографии идут вместе. Новый <code>/q</code> начинает отдельную задачу.</p>
      <p>Вопросы агента показываются кнопками; работа продолжится после ответа. Бот показывает сообщения агента и результат. Обычные действия инструментов скрыты по умолчанию.</p>
      <p>При сбое проверь <code>/session</code>, прежде чем повторять запрос: сервер мог уже принять его. Если новая тема ещё ждёт первый запуск, восстанови соединение и отправь задачу снова в неё.</p>
      <blockquote>Чтобы остановить агента перед закрытием или удалением топика, сначала выполни <code>/kill</code>. Закрытие выключает зеркало и очередь, но серверная сессия сохраняется.</blockquote>
    `],
    ["↻ Новое начало и rewind", `
      <p><code>/reset</code> останавливает текущую работу, очищает очередь и готовит новую сессию в той же теме. Прежняя сессия остаётся в OpenCodez; новая начнётся после следующего запроса.</p>
      <table striped compact><tr><th>Команда</th><th>Что сохранится или изменится</th></tr>
      <tr><td><code>/reset</code></td><td>Тот же профиль, сервер и папка</td></tr>
      <tr><td><code>/reset solm</code></td><td>Другой профиль, прежний сервер и папка</td></tr>
      <tr><td><code>/reset local</code></td><td>Другой сервер, папка по умолчанию на нём</td></tr>
      <tr><td><code>/reset solm local</code></td><td>Другие профиль и сервер</td></tr></table>
      <p>Здесь порядок обратный <code>/new</code>: сначала профиль, затем сервер. ID должен быть настроен. Если имя одновременно обозначает профиль и сервер, укажи оба. Имя темы сохраняется; суффикс сервера обновится. В теме без первого запроса reset меняет ожидающий запуск. Для иной папки создай новую тему через <code>/new ... dir:...</code>.</p>
      <blockquote><b>Ответ на старый пользовательский запрос — rewind.</b> Бот отменяет последующую ветку и отправляет твой ответ вместо того запроса. Так можно исправить запрос и продолжить от прежнего места.</blockquote>
      <p><code>/context</code> выгружает последние завершённые или прерванные ходы; <code>/context N</code> задаёт число от 1 до 10. Глубину можно сохранить в личных настройках или через <code>/set_context N</code>. Технические compaction и reminders не становятся отдельными запросами.</p>
    `],
    ["📎 Файлы и 🎙 аудио", "<p>FILES получает результаты, которые агент отправляет по твоей просьбе. Брось туда файл, чтобы сохранить его на настроенном сервере; бот вернёт путь.</p><blockquote><b>Файлы до 2 ГБ.</b> Локальный Telegram Bot API отправляет файлы до 2000 МБ и снимает облачный лимит скачивания 20 МБ. Облачный API отправляет файлы до 50 МБ.</blockquote><p>Локальный API — отдельный сервис на хосте бота. Для него нужны <code>api_id</code> и <code>api_hash</code> с <a href=\"https://my.telegram.org/apps\">my.telegram.org</a>, запуск сервиса и переключение бота. Один ввод ключей его не включает. <a href=\"https://github.com/Krablante/opencodebot/blob/main/docs/ru/docker.md#local-telegram-bot-api\">Инструкция подключения</a>. Настроенные лимиты бота и моделей сохраняются.</p><p>AUDIO распознаёт голосовые и аудиофайлы. Текст можно скопировать и отправить агенту самостоятельно.</p><blockquote>Расшифровка голосового никогда не запускает агента автоматически.</blockquote><p>Подключи Groq через Setup. Рекомендуемая модель — Whisper Large V3 Turbo. Бесплатный тариф имеет ограничения.</p><p>Озвучка ответов — отдельная функция в настройках. <code>/speak</code> на ответе запрашивает одноразовую озвучку, если провайдеры настроены.</p>"],
    ["⚙ Настройки и уведомления", "<p>Уведомления о завершении, вопросах и сбоях приходят в личку. Один раз открой чат с ботом и нажми Start. Уведомления о завершении можно отключить в настройках.</p><p><code>/setup</code> проверяет подключения и продолжает незавершённую настройку. Повторный запуск не создаёт служебные темы заново.</p><p>Язык, случайные названия, отображение инструментов и параметры озвучки находятся в General → Настройки. <code>/update</code> проверяет обновления бота.</p><blockquote>Панель General обновляется на новом месте раз в сутки. <code>/menu</code> переносит её вниз немедленно.</blockquote><details><summary>Дополнительные возможности</summary><p>Автоматические напоминания исходного запроса после compaction включены по умолчанию. Их переключатель находится в дополнительных настройках; <code>/reminder on|off</code> — быстрый способ. Там же можно показать действия инструментов и добавить диагностику в личные уведомления. Озвучка ответов имеет отдельные настройки профиля, голоса, длины и инструкции суммаризации.</p></details>"],
  ],
  en: [
    ["✦ Welcome", "<p>General is for creating topics and configuring the bot. A working topic is a conversation with your OpenCodez agent.</p><blockquote>Press <b>New topic</b>, check the title and model, create the topic, and start writing.</blockquote><p>The default name is a historical or evocative Russian word with random capitalization. Another word draws again; Title lets you enter your own. Disable the mode in Settings.</p><p>FILES collects files. AUDIO turns voice notes and audio files into text. You can finish these connections later.</p>"],
    ["✦ Create with the wizard", `
      <p><b>New topic</b> in General, or <code>/new</code> without arguments, opens a creation card in the chat. Only the user who opened it can operate its controls.</p>
      <table striped compact><tr><th>Field</th><th>What to choose</th></tr>
      <tr><td>Title</td><td>Keep the random word, choose Another word, or enter your own. With random names disabled, the bot asks for a name immediately.</td></tr>
      <tr><td>Profile</td><td>Saved model, reasoning, System and agent. The initial choice comes from your launch preferences.</td></tr>
      <tr><td>Server</td><td>The OpenCodez connection that will run the task. A single-server installation has a fixed choice.</td></tr>
      <tr><td>Working directory</td><td>An absolute path on the chosen server. <code>/default</code> restores its default directory.</td></tr></table>
      <p>Check the exact provider/model and reasoning. If the level is missing or unavailable, choose one supported for this topic. This does not change the saved profile. Changing server resets the default directory and checks the model again.</p>
      <p>If the model, System or server is unavailable, select another profile/server or restore the connection and provider in OpenCodez. A profile changed while you were choosing requires confirmation again.</p>
      <blockquote><b>Create topic</b> first creates the Telegram topic. The OpenCodez session starts after your first ordinary prompt message. You can then use <code>/q</code> and check the launch with <code>/session</code>.</blockquote>
      <p>The selected name and parameters stay in the draft until creation. Close cancels the draft; <code>/cancel</code> cancels only the current field. Drafts last 15 minutes and disappear when the bot restarts.</p>
      <p>The Topic ready card is deleted after two minutes. Restarting the bot preserves the deletion deadline.</p>
    `],
    ["⌨ Quick creation: /new", `
      <p>With arguments, the command creates a topic immediately. General form; square brackets mark optional parts:</p>
      <pre>/new [server] [profile] [dir:&lt;path&gt;] [title]</pre>
      <p><code>local</code> below is an example ID from the server list; <code>sol</code> is a saved profile name. Substitute your own values.</p>
      <table striped compact><tr><th>Command</th><th>Result</th></tr>
      <tr><td><code>/new</code></td><td>Topic creation wizard</td></tr>
      <tr><td><code>/new Title</code></td><td>Custom name, other settings use defaults</td></tr>
      <tr><td><code>/new sol</code></td><td>Profile sol, default server</td></tr>
      <tr><td><code>/new local</code></td><td>Server local, default launch preferences</td></tr>
      <tr><td><code>/new sol Title</code></td><td>Profile and custom name</td></tr>
      <tr><td><code>/new local Title</code></td><td>Server and custom name</td></tr>
      <tr><td><code>/new local sol</code></td><td>Server and profile</td></tr>
      <tr><td><code>/new local sol Title</code></td><td>Server, profile and custom name</td></tr></table>
      <p>Omit the server to use the default; omit the profile to use default launch preferences. Omit the name to draw a random word. With random names disabled, the initial name comes from the profile or server.</p>
      <p><code>dir:</code> and <code>directory:</code> are equivalent and work with any command form. The path belongs to the selected server; omitting it uses its configured directory or the OpenCodez default.</p>
      <pre>/new local sol dir:/workspace Title</pre>
      <p>Quote paths containing spaces. A title can contain multiple words:</p>
      <pre>/new local sol "dir:/workspace/My Project" My project</pre>
      <blockquote>The server is recognized first, then the profile. Only exact configured IDs and names are recognized; a typo can become part of the title. To name a topic after a server or profile, specify both explicitly: <code>/new local sol sol</code> names it “sol”.</blockquote>
    `],
    ["🎛 Profiles and models", `
      <p>A profile saves the model, reasoning, and optional System and agent. Create, copy, edit and delete profiles in General → Profiles. Restore deleted profiles from Deleted.</p>
      <p>Choose Make default to set the main profile. To use another for just one topic, select it in the wizard or put it after the server in <code>/new</code>.</p>
      <p>The catalog comes from the selected OpenCodez server. Models are grouped by provider and family; search accepts names, IDs and providers. Refresh reloads the catalog. Choose a model and supported reasoning level, then save the profile.</p>
      <p>Catalogs and variants can differ between servers. A listed model does not guarantee provider quota. Check the provider connection and plan in OpenCodez, or choose another model.</p>
      <blockquote>Saving, deleting or changing the default profile does not alter running sessions. New topics receive their own displayed settings; the model and reasoning chosen during creation are kept for later restarts.</blockquote>
    `],
    ["💬 Everyday work", `
      <p>Send the first task as an ordinary message in the new topic. Attach images or files to the text. Files without captions wait for your next text message.</p>
      <table striped compact><tr><th>Command</th><th>Action</th></tr>
      <tr><td><code>/session</code></td><td>Tap-to-copy session ID, server, model and status; details identify this command's topic and file/audio destinations</td></tr>
      <tr><td><code>/q prompt</code></td><td>Send or queue a task in an existing session</td></tr>
      <tr><td><code>/q</code> or <code>/q status</code></td><td>View the queue</td></tr>
      <tr><td><code>/q delete N</code></td><td>Remove a queue item by number</td></tr>
      <tr><td><code>/kill</code></td><td>Stop and clear the queue</td></tr>
      <tr><td><code>/compact</code></td><td>Compact an idle session</td></tr></table>
      <p>One <code>/q</code> at the start is enough for a long prompt: parts become one task after two seconds of quiet. In a Rich Message, the command can start a paragraph or heading; text and photos stay together. A new <code>/q</code> starts a separate task.</p>
      <p>Agent questions use buttons; work continues after your answer. The bot shows agent text and final answers. Ordinary tool actions are hidden by default.</p>
      <p>After a failure, check <code>/session</code> before retrying: the server may already have accepted the prompt. If a new topic is still waiting for its first launch, restore the connection and submit the task again there.</p>
      <blockquote>To stop the agent before closing or deleting a topic, run <code>/kill</code> first. Closing disables mirroring and clears the queue, while the server session is preserved.</blockquote>
    `],
    ["↻ Reset and rewind", `
      <p><code>/reset</code> stops the current run, clears the queue and prepares a new session in the same topic. The previous session remains in OpenCodez; the new one starts with your next prompt.</p>
      <table striped compact><tr><th>Command</th><th>What stays or changes</th></tr>
      <tr><td><code>/reset</code></td><td>Same profile, server and directory</td></tr>
      <tr><td><code>/reset solm</code></td><td>Another profile, same server and directory</td></tr>
      <tr><td><code>/reset local</code></td><td>Another server, its default directory</td></tr>
      <tr><td><code>/reset solm local</code></td><td>Another profile and server</td></tr></table>
      <p>The order is the reverse of <code>/new</code>: profile first, server second. IDs must be configured. If a name matches both a profile and server, specify both. The topic name stays; its server suffix updates. Before the first prompt, reset changes the pending launch. For another directory, create a topic with <code>/new ... dir:...</code>.</p>
      <blockquote><b>Replying to an earlier user prompt rewinds that turn.</b> The bot discards the later branch and submits your reply in place of that prompt, allowing you to correct it and continue from that point.</blockquote>
      <p><code>/context</code> exports recent completed or interrupted turns; <code>/context N</code> chooses a count from 1 to 10. Save the depth in personal settings or with <code>/set_context N</code>. Internal compaction and reminders do not count as separate prompts.</p>
    `],
    ["📎 Files and 🎙 audio", "<p>FILES receives results the agent sends at your request. Drop a file there to save it on the configured server; the bot returns its path.</p><blockquote><b>Files up to 2 GB.</b> A local Telegram Bot API sends files up to 2000 MB and removes the cloud's 20 MB download limit. The cloud API sends files up to 50 MB.</blockquote><p>The local API is a separate service on the bot's host. It needs <code>api_id</code> and <code>api_hash</code> from <a href=\"https://my.telegram.org/apps\">my.telegram.org</a>, a running service and a bot endpoint switch. Entering credentials alone does not enable it. <a href=\"https://github.com/Krablante/opencodebot/blob/main/docs/en/docker.md#local-telegram-bot-api\">Setup instructions</a>. Configured bot and model limits still apply.</p><p>AUDIO transcribes voice notes and audio files. Copy the text and send it to the agent yourself.</p><blockquote>A transcript never starts an agent automatically.</blockquote><p>Connect Groq through Setup. Whisper Large V3 Turbo is recommended. The free tier has limits.</p><p>Spoken answers are a separate setting. Reply <code>/speak</code> to an answer for a one-off voice summary when providers are configured.</p>"],
    ["⚙ Settings and notifications", "<p>Final-answer, question and failure alerts arrive in your private chat. Open the bot and press Start once. Final-answer notifications can be disabled in settings.</p><p><code>/setup</code> checks connections and continues unfinished setup. Running it again does not recreate service topics.</p><p>Language, random topic names, tool visibility and voice options are in General → Settings. <code>/update</code> checks bot updates.</p><blockquote>The General panel moves to a fresh message daily. <code>/menu</code> moves it to the bottom immediately.</blockquote><details><summary>Advanced options</summary><p>Original-prompt reminders after automatic compaction are enabled by default. Change them in advanced settings or with <code>/reminder on|off</code>. You can also show tool actions and add diagnostics to private notifications. Spoken answers have separate synthesis-profile, voice, length and summary-prompt settings.</p></details>"],
  ],
}

export function guidePage(index = 0, language = "en") {
  const list = pages[language] || pages.en
  const page = Math.max(0, Math.min(index, list.length - 1))
  const [title, body] = list[page]
  return { html: `<h2>${title}</h2>${body}<footer>${page + 1} / ${list.length}</footer>`, total: list.length }
}

export function guideDocument(language = "en") {
  return (pages[language] || pages.en).map(([title, body]) => `<section><h1>${title}</h1>${body}</section>`).join("\n")
}
