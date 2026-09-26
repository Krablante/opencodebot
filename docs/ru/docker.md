# Docker Compose

[Русский](docker.md) · [English](../en/docker.md) · [Указатель](README.md)

Compose запускает один постоянный процесс бота и, только с профилем `telegram-local`, отдельный локальный Telegram Bot API. OpenCodez и WireGuard остаются вне этого Compose-проекта. Для вспомогательных команд нужен Node.js 22+, для контейнера — Docker Compose.

## Файлы и первый запуск

После `npm run init-config` рядом с репозиторием появляются игнорируемые `config.local.json` и `servers.json`. Скопируйте `token.env.example` в `token.env`, заполните токен Telegram, список разрешённых пользователей и пароль OpenCodez. Compose монтирует эти файлы только на чтение, а `state/` — на запись. Создайте каталог состояния заранее.

```bash
cp token.env.example token.env
mkdir -p state
npm run deploy:bot
docker compose logs -f opencodebot
```

В PowerShell вместо первых двух команд используйте `Copy-Item token.env.example token.env` и `New-Item -ItemType Directory -Force state`. Команда `deploy:bot` требует чистый Git checkout, запускает `npm ci`, проверку синтаксиса, сборку образа с SHA ревизии, пересоздаёт только бот и проверяет `health:live`. Для изменения других сервисов Compose есть `npm run deploy:all`. `docker compose down` останавливает стек; сохраняйте каталог состояния.

Compose по умолчанию берёт `./config.local.json`, `./servers.json`, `./token.env`, `./state`, `./uploads`, `./trash`, `./ssh`. Если файлы вынесены из checkout, задайте пути в игнорируемом `.env`:

```dotenv
OPENCODEBOT_CONFIG_FILE=/absolute/path/config.local.json
OPENCODEBOT_SERVERS_FILE=/absolute/path/servers.json
OPENCODEBOT_TOKEN_ENV_FILE=/absolute/path/token.env
OPENCODEBOT_STATE_DIR=/absolute/path/state
```

`servers.json` должен указывать на адрес OpenCodez, доступный из контейнера. Для сервера на том же хосте часто подходит `http://host.docker.internal:4096`; адрес `127.0.0.1` внутри контейнера указывает на сам бот. Каталог `home` в записи сервера — путь OpenCodez, а не произвольный путь контейнера.

## Каталоги для файлов

При локальной передаче бот должен видеть тот же конечный путь, который он сообщает OpenCodez. Для папки `~/trash` при `home: /home/operator` на Linux задайте хостовой источник и путь в контейнере одинаково:

```dotenv
OPENCODEBOT_ARTIFACT_UPLOAD_SOURCE=/home/operator/trash
OPENCODEBOT_ARTIFACT_UPLOAD_ROOT=/home/operator/trash
OPENCODEBOT_UPLOAD_ROOT=/home/operator/.opencodebot/uploads
```

На macOS вместо `/home/operator` используйте реальный путь `/Users/...`. На Windows путь `C:\Users\...` не является путём Linux-контейнера: для Windows-цели понятнее запустить бот напрямую в Node.js или передавать файлы по SSH на Windows-хост. Для удалённого SSH-сервера каталог назначения не нужно монтировать в контейнер. Проверяйте, что файлы и журналы доступны на запись процессу с `OPENCODEBOT_UID`/`OPENCODEBOT_GID`.

## Локальный Telegram Bot API

Этот режим нужен для больших загружаемых файлов. Получите `TELEGRAM_API_ID` и `TELEGRAM_API_HASH` в `my.telegram.org/apps`, сохраните их в `token.env`, затем укажите в приватной конфигурации `telegram.botApi.mode: "local"`, `rootUrl: "http://telegram-bot-api:8081"` и `localFilesRoot: "/var/lib/telegram-bot-api"`. Каталог sidecar в `state/telegram-bot-api` должен быть доступен его uid/gid `101:101`; бот входит в группу `101`, а каталог `opencodebot-spool` доступен боту на запись.

```bash
docker compose --profile telegram-local up -d --build
npm run telegram-local -- enable --yes
docker compose exec -T opencodebot npm run telegram-local -- doctor
npm run health:live
```

Переключение токена с облачного API требует `enable --yes`. Для возврата сначала выполните `docker compose exec -T opencodebot npm run telegram-local -- disable --yes`, пока конфигурация всё ещё указывает на локальный сервер, затем верните режим `cloud` и перезапустите бот. У Telegram может действовать короткая задержка перед повторным обслуживанием токена облачным API.

## Эксплуатация

Бот пишет отдельные журналы inbox и отметок зеркала рядом с `state.json`. Резервную копию делайте после остановки бота и храните приватно: inbox может содержать входящий текст. `npm run health:live` проверяет живой процесс, прогресс опроса Telegram и восстановления сессий, а также обязательные API серверов OpenCodez; он не посылает сообщений. Контейнер не имеет Docker socket и не монтирует исходники для самообновления. Хостовой runner на Linux ставится отдельно по [инструкции обновления](self-update.md).
