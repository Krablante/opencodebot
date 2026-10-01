# Docker

[English](../en/docker.md) · [Русский](docker.md) · [Все языки](../README.md)

Compose запускает OpenCodeBot и необязательный локальный Telegram Bot API. OpenCodez и VPN работают отдельно. Для команд хоста нужен Node.js 22+, для контейнеров — Docker Compose.

<a id="files"></a>
## Файлы

Начни с `npm run setup`. Он готовит конфигурацию, пути и монтирование; на POSIX записывает твои UID/GID, чтобы процесс контейнера мог писать состояние. Для обычного Node используй `npm run setup -- --node`; Windows по умолчанию использует нативные пути. Rich-меню нужен Bot API 10.3+.

Ручная установка:

```bash
npm run init-config
cp token.env.example token.env
mkdir -p state
```

Заполни токен, ID операторов и необязательный пароль OpenCodez в `token.env`. В PowerShell: `Copy-Item token.env.example token.env` и `New-Item -ItemType Directory -Force state`.

Обычные источники: `./config.local.json`, `./servers.json`, `./token.env`, `./state`, `./uploads`, `./trash`, `./ssh`. Другие пути хоста задаются в игнорируемом `.env`:

```env
OPENCODEBOT_CONFIG_FILE=/absolute/config.local.json
OPENCODEBOT_SERVERS_FILE=/absolute/servers.json
OPENCODEBOT_TOKEN_ENV_FILE=/absolute/token.env
OPENCODEBOT_STATE_DIR=/absolute/state
OPENCODEBOT_UID=1000
OPENCODEBOT_GID=1000
OPENCODEBOT_UPLOAD_ROOT=/home/operator/.opencodebot/uploads
OPENCODEBOT_ARTIFACT_UPLOAD_SOURCE=/home/operator/trash
OPENCODEBOT_ARTIFACT_UPLOAD_ROOT=/home/operator/trash
OPENCODEBOT_SSH_DIR=/home/operator/.ssh
```

При ручной установке укажи реальные UID/GID владельца; `1000:1000` — только fallback Compose. Конфигурация, список серверов, ключи и SSH монтируются для чтения. Состояние и папки файлов должны быть доступны боту на запись. Резервную копию делай при остановке; [справочник хранения](config-runtime.md#paths-and-state) перечисляет журналы и совместимость.

<a id="artifact-dropbox-paths"></a>
## Пути входящих файлов

`OPENCODEBOT_ARTIFACT_UPLOAD_SOURCE` — папка хоста, `OPENCODEBOT_ARTIFACT_UPLOAD_ROOT` — её путь внутри контейнера. Для local этот путь должен совпасть с конечным путём сервера, показанным OpenCodez и Telegram. То же правило действует для `uploadRoot` через `OPENCODEBOT_UPLOAD_ROOT`.

| Назначение | Рекомендуемая схема |
| --- | --- |
| Тот же Linux/macOS-хост | Монтировать конечный абсолютный путь в такой же путь контейнера |
| Удалённый POSIX-хост | SSH; удалённая папка не монтируется |
| Windows drive/UNC | Node на Windows либо SSH на Windows |
| Намеренные пути контейнера | `/app/uploads` и `/app/artifact-uploads`, с соответствующей настройкой серверных путей |

При `/home/operator` и `artifactUploads.root=~/trash` обе переменные FILES равны `/home/operator/trash`. На macOS нужен реальный `/Users/...`. Контейнер Linux не умеет писать `C:\Users\...` просто потому, что путь есть в списке серверов. Удалённые пути принадлежат целевому серверу.

<a id="opencodez-url"></a>
## Адрес OpenCodez

Адрес должен быть доступен из контейнера. Для API хоста часто подходит `http://host.docker.internal:4096`; LAN-имена/IP тоже подходят. `127.0.0.1` означает контейнер бота, кроме явно выбранной сети хоста.

```json
{ "servers": [{ "id": "local", "url": "http://host.docker.internal:4096",
  "home": "/home/operator", "uploadRoot": "/home/operator/.opencodebot/uploads",
  "transfer": { "type": "local" } }] }
```

Для Windows оставь доступный API URL, но задай `pathStyle: "windows"`, домашнюю/файловые папки Windows и `transfer: { "type": "ssh", "host": "host.docker.internal", "user": "Operator" }`, либо запускай бота нативно.

<a id="run"></a>
## Запуск

Развёртывай чистый Git checkout:

```bash
npm run deploy:bot
docker compose logs -f opencodebot
```

Команда устанавливает закреплённые зависимости, проверяет синтаксис, собирает образ с точным SHA, пересоздаёт только бота и проверяет живой процесс. `npm run deploy:all` собирает/запускает весь Compose-проект при изменении сервисов; добавь `COMPOSE_PROFILES=telegram-local` в `.env`, если sidecar должен входить в полный стек. `docker compose down` останавливает его; сохрани состояние.

Обновление: `git pull --ff-only`, затем `npm run deploy:bot`. Для Compose/sidecar используй `deploy:all`. Не запускай `npm start` рядом с контейнером, опрашивающим тот же токен. `npm run health:live` проверяет настоящий процесс, оба цикла, Telegram и обязательные backend API; `offline_ok` исключает необязательный сервер из этого условия.

<a id="local-telegram-bot-api"></a>
## Локальный Telegram Bot API

Профиль `telegram-local` запускает закреплённый `aiogram/telegram-bot-api:10.3`. Его состояние — `state/telegram-bot-api`, общее с ботом по `/var/lib/telegram-bot-api`. Порт по умолчанию доступен внутри Compose. Получи `TELEGRAM_API_ID` и `TELEGRAM_API_HASH` на https://my.telegram.org/apps и запиши в `token.env`.

```json
{ "telegram": { "botApi": { "mode": "local",
  "rootUrl": "http://telegram-bot-api:8081",
  "localFilesRoot": "/var/lib/telegram-bot-api" } } }
```

Sidecar использует uid/gid `101:101`. Бот входит в группу 101 для чтения скачиваний; другой образ может переопределить её через `TELEGRAM_BOT_API_GID`. Папка подготовки принадлежит боту и доступна sidecar на чтение. При ранее испорченном владельце исправь только эти точные папки:

```bash
sudo chown -R 101:101 state/telegram-bot-api
sudo mkdir -p state/telegram-bot-api/opencodebot-spool
sudo chown -R "$(id -u):$(id -g)" state/telegram-bot-api/opencodebot-spool
```

Для внешнего состояния замени путь на точную папку этой установки. Ошибки backup/диагностики не должны раскрывать подкаталоги с токеном.

Запусти sidecar, перенеси токен с облачного endpoint, затем разверни бота:

```bash
docker compose --profile telegram-local up -d telegram-bot-api
docker compose run --rm --no-deps opencodebot npm run telegram-local -- enable --yes
npm run deploy:bot
docker compose exec -T opencodebot npm run telegram-local -- doctor
```

Помощник вызывает облачный `logOut`; этот одноразовый контейнер не опрашивает обновления. При обновлении sidecar сохрани общий том. Для возврата в облако выполни `docker compose exec -T opencodebot npm run telegram-local -- disable --yes`, пока конфигурация указывает на local, затем верни `cloud` и перезапусти. Telegram может кратко ограничить повторное обслуживание облачным API.

## Эксплуатация

Обычно бот делает только исходящие запросы. Артефакты включают защищённый listener; Compose публикует `OPENCODEBOT_ARTIFACT_PORT` (8788 по умолчанию) на порт контейнера 8788. Другой порт listener требует соответствующей правки Compose. Ограничь доступ доверенными отправителями.

В контейнере нет Docker socket и монтирования исходников. Обновления из Telegram использует фиксированный обработчик Linux-хоста: `npm run update-runner:install`. [Обновления](self-update.md) описывают права, откат и ручные случаи. Установленные plugin/skill принадлежат процессу развёртывания OpenCodez.
