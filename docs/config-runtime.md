# Config And Runtime

The repo contains source, defaults, and docs. Runtime config and state live outside git so the bot can be repaired, restarted, and shared without committing private values.

Create config once with:

```bash
npm run init-config
```

Default runtime config path:

```text
./config.local.json
```

`config.example.json` is the public shape and default baseline. `npm run init-config` creates the local runtime copy and an editable `servers.json`. Edit the runtime copy for local behavior, and update `config.example.json` only when the shareable default shape changes.

## Loading

The bot reads `OPENCODEBOT_CONFIG` when it is set. If it is not set, the loader uses `config.local.json` in the repo root. If that file does not exist, it falls back to `config.example.json`; that fallback is useful for checks, but a real bot should have an explicit runtime config.

Relative paths in config are resolved from the config file's directory. This keeps the same config shape usable on Linux and Windows.

The Docker Compose setup mounts `config.local.json`, `servers.json`, `token.env`, and `state/` into the container at the same `/app/...` paths. That means the config created by `npm run init-config` works for both direct npm usage and Docker. The only common Docker-specific edit is the OpenCodez URL in `servers.json`: use a LAN URL or `host.docker.internal`, not `127.0.0.1`, when OpenCodez runs on the host.

The loader also reads `paths.tokenEnv` and then overlays process environment variables on top. That means Compose, PowerShell, shell sessions, and local scripts can override values from `token.env` without editing the runtime JSON.

OpenCodez servers come from `paths.serversJson`, not from the main config body. The public example points at `servers.example.json`; `npm run init-config` creates a local ignored `servers.json` for your real hosts.

## Secrets

`token.env` is read by local scripts and the Compose runtime. It holds values such as the Telegram bot token, allowed user ids, the OpenCodez password, the optional artifact gateway token, optional `OPENROUTER_API_KEY` for speech transcription, and optional `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` credentials for the local Telegram Bot API sidecar. Do not print it, paste it into docs, or commit it.

The config names the environment variables to try. `telegram.tokenEnvNames` is checked first, but the loader can also recognize a Telegram-looking token from the env file. `telegram.allowedUserEnvNames` is checked first for user ids; if none are found, the loader falls back to env names that look like owner/user/allowed id variables. `opencode.passwordEnvNames` works the same simple way for the OpenCodez password.

Non-secret config is intentionally small. It covers deployment identity and ownership: chat id, allowed user ids, OpenCodez servers, default prompt profile, chat templates, attachment limits, speech transcription settings, artifact upload folders, final-notification recipients, artifact gateway address, paths, and optional web/WireGuard helpers. Mirror policy, prompt pinning, reconcile windows, multipart buffering, and tool compaction are fixed defaults in code.

## Telegram

`telegram.chatId` pins the bot to the intended Telegram forum chat.

`telegram.allowedUserIds` limits who can control the bot. Keep this explicit before handing the bot to someone else. `telegram.allowChatBootstrap` is useful only during first setup: if no chat is configured yet, the first allowed message can bind the bot to that chat. After setup, set the chat id and turn bootstrap off.

The bot always autocreates Telegram forum topics for new OpenCodez sessions discovered through Telegram commands, OpenCodez events, or bounded reconcile. Topic creation is part of the product model, not a runtime mode.

`telegram.botApi` controls which Bot API endpoint the bot uses. If it is omitted, the bot uses the normal cloud endpoint at `https://api.telegram.org`. Local mode is explicit:

```json
{
  "telegram": {
    "botApi": {
      "mode": "local",
      "rootUrl": "http://telegram-bot-api:8081",
      "localFilesRoot": "/var/lib/telegram-bot-api"
    }
  }
}
```

Local mode requires `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in `token.env`, the `telegram-local` Compose profile, and `npm run telegram-local -- enable --yes` before the token can move from Telegram's cloud Bot API to the local server. In Docker deployments, use `docker compose exec -T opencodebot npm run telegram-local -- doctor` after restart to verify config, endpoint reachability, `getMe`, and the shared file root. The local server is an HTTP sidecar reachable only inside Docker by default.

To leave local mode, run `docker compose exec -T opencodebot npm run telegram-local -- disable --yes` while config still points at the local server, then switch `telegram.botApi.mode` back to `cloud` and restart. This lets the helper call Telegram `close` on the right endpoint.

## Attachments

`attachments` is top-level config. It controls whether Telegram files are accepted and the accepted inline, per-file, and per-message totals. Cloud Bot API mode clamps each file to Telegram's conservative cloud download limit. Local Bot API mode can use larger per-file values, up to the local Bot API file limit.

When files arrive without captions, the bot waits for plain text from the same user/topic before sending the prompt to OpenCodez. If Telegram splits a large follow-up text into several messages, the bot keeps collecting those chunks until the short attachment-text idle window settles, then sends one prompt with all files and text chunks together.

Older local configs that copied `telegram.attachments` from a previous example still work, but new configs should keep attachment policy at the top level.

```json
{
  "attachments": {
    "enabled": true,
    "maxInlineBytes": 20000000,
    "maxFileBytes": 20000000,
    "maxTotalBytes": 60000000
  }
}
```

## Speech Transcription

`speech` is an optional OpenRouter-backed voice transcription module. It is disabled by default and has no local model, GPU, or worker dependency. To enable it, set `speech.enabled` to `true` and provide `OPENROUTER_API_KEY` in `token.env` or the process environment.

```json
{
  "speech": {
    "enabled": true,
    "maxFileBytes": 25000000,
    "queueConcurrency": 1,
    "statusMessage": "Transcribing voice...",
    "openrouter": {
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "model": "openai/whisper-large-v3-turbo",
      "language": "ru",
      "temperature": 0,
      "responseFormat": "json",
      "prompt": "Русская голосовая заметка. Сохраняй технические названия, команды, пути и сокращения латиницей."
    }
  }
}
```

Run `/sounds_here` in a Telegram forum topic to make that topic the speech inbox. Voice and audio messages in that topic are downloaded, sent to OpenRouter's audio transcription endpoint, and answered with the transcript in the same topic. Only the transcript is wrapped in Telegram Mono formatting so it can be selected/copied without also copying model or timing metadata. Text in the speech topic is not forwarded to OpenCodez sessions.

The prompt is deliberately short and configurable. Leave it blank if generic transcription is better for your group, or replace it with a small vocabulary hint. Do not put secrets in it.

`openrouter.language` defaults to `"ru"` and is sent to OpenRouter as a transcription hint. Set it to another ISO-639-1 code such as `"en"` when the speech topic is mostly another language. Set it to `null` or `"auto"` to omit the `language` field and let OpenRouter auto-detect the audio language.

```json
{
  "speech": {
    "openrouter": {
      "language": "auto"
    }
  }
}
```

## OpenCodez

`opencode.baseUrl` is the local/default API origin used when a server-specific URL is not involved. `opencode.passwordEnvNames` lists env var names that may contain the OpenCodez password.

The bot separates mirroring from Telegram-created session placement. `opencode.mirrorScope` controls what the bot watches on configured OpenCodez servers: `global` mirrors new sessions from any workspace on that host, while `serverHome` keeps the older host-home scope. `opencode.newSessionDefaultDirectory` controls where `/new` creates sessions when the operator does not pass `dir:<path>`; the normal value is `serverHome`, which uses the selected server's `home` from `servers.json`.

Each server in `servers.json` needs an `id` and `url`. The optional `home` field gives `/new` a default directory and lets `~/trash` expand naturally for artifact uploads. `uploadRoot` gives large Telegram prompt attachments a server-local destination. If `uploadRoot` is omitted and `home` is present, the bot derives the conventional prompt upload root from `home`. `artifactUploadRoot` overrides the global artifact file dropbox root for one server. `transfer` stays simple: use `local` when the bot and OpenCodez share the path, and `ssh` when the bot must copy a file to another host before prompting OpenCodez or saving a dropped artifact file.

```json
{
  "id": "dima",
  "url": "http://192.168.1.91:4098",
  "home": "/home/dima",
  "uploadRoot": "/home/dima/.opencodebot/uploads",
  "pathStyle": "posix",
  "transfer": { "type": "ssh", "host": "dima" }
}
```

## Prompt Profiles

`defaultPrompt` is the fallback profile for Telegram-created sessions. It chooses the default OpenCodez server and the prompt metadata the bot can know before the first prompt: agent, model, and optional `opencodezTemplate`.

`chatTemplates` are named profiles for `/new`. The built-in defaults are `d4flash`, `d4pro`, and `gpt55p`. Runtime config is merged with those defaults, so you can add a new template or override one existing template without copying every default.

Each template can define:

- `agent`: OpenCodez agent name.
- `model.providerID`: provider id.
- `model.modelID`: model id.
- `model.variant`: optional model effort/variant.
- `opencodezTemplate`: OpenCodez-side chat template name.

Example:

```json
{
  "chatTemplates": {
    "fast": {
      "agent": "build",
      "model": { "providerID": "deepseek", "modelID": "deepseek-v4-flash", "variant": "max" },
      "opencodezTemplate": "gpt55"
    }
  }
}
```

Then start a topic with:

```text
/new fast work on the upload flow
```

## Mirror Modes

The bot has two persistent global mirror modes controlled by `/mode full` and `/mode economy`. Full mode mirrors user-facing OpenCodez activity and compacts tool status into expandable quotes. Economy mode keeps assistant progress text, final answers, and failures while suppressing Telegram tool sends and edits across every topic. Both modes hide internal helper tools such as `todo`/`todowrite` and all task/subagent activity, keep reasoning summaries out of Telegram, and use fixed Telegram-safe message limits. Oversized web-origin user prompts are split into numbered Telegram messages instead of being truncated.

User prompts are always pinned. Telegram-origin runs pin the original user message after OpenCodez accepts the prompt; web-origin runs pin the mirrored user-prompt message. Telegram pin service messages are cleaned up when possible. Final assistant answers are marked with `🏁` but are not pinned.

Long Telegram prompts and bounded missed-event recovery are always on with conservative internal limits. Telegram attachments are always part of the product model, with size limits controlled by top-level `attachments` and clamped by Bot API mode.

## Final Notifications

`finalNotifications` controls optional private DM notifications for final mirrored answers. `finalNotifications.userIds` is the configured recipient allowlist. `/notify_on` enables notifications for those configured ids after verifying that the bot can DM them; `/notify_off` disables those configured recipients again.

The final DM is intentionally short: it includes a source `Topic:` line from Telegram topic metadata, with the Telegram topic name and topic custom emoji when Telegram provides it. It also provides an `Open topic` button for the final message in the Telegram topic, quotes the original user prompt in an expandable block for orientation, and includes a compact quoted `📋 Tasks [n/n]:` checklist when the agent closed a todo list for that run. It does not include the final answer text. Durable dedupe markers are capped internally so live events plus reconcile do not send the same final notification twice.

## Artifacts

`artifacts.enabled` starts the optional LAN artifact gateway. The gateway is for agent-created screenshots, logs, text snippets, and files that should be delivered to one Telegram artifacts topic. It is not a mirror-session router and it does not try to infer the current OpenCodez topic.

`artifacts.listenHost` and `artifacts.port` control the local HTTP listener. Docker Compose publishes the same port with `OPENCODEBOT_ARTIFACT_PORT`, defaulting to `8788`. Expose it only on trusted networks and keep bearer-token auth enabled.

`artifacts.tokenEnvNames` lists environment variable names that may contain the artifact token. The default is `OPENCODEBOT_ARTIFACT_TOKEN`. This token is shared with the OpenCodez plugin. It is not the Telegram bot token, and the plugin should never receive the Telegram bot token.

Artifact JSON payload, text, and caption limits are fixed safety defaults in code. File limits depend on Bot API mode: cloud mode keeps the conservative 50 MiB file limit, while local mode allows Telegram's 2 GB local Bot API limit through the streaming `/artifacts/send-file` path. Text artifacts are sent as expandable quotes. Suitable JPEG, PNG, and WebP files are sent with `sendPhoto` in `auto` mode; other files are sent with `sendDocument`.

The active target is chosen from Telegram with `/artifacts_here`. Running that command in another topic replaces the previous target. The target is stored in `state.json`, not config.

The same Telegram artifacts topic can receive files from users. A dropped file is saved on the configured default server when its caption is empty. When the caption starts with a server id, that server is used instead. Unknown server ids are rejected before the bot downloads the file. Saved files go under `artifactUploads.root`, then an optional `YYYY-MM-DD` folder, then a sanitized filename. The default root is `~/trash`, expanded from the target server's `home`; on Windows this can become `C:\Users\name\trash` when that is the server home.

Docker deployments must expose local artifact roots as writable bind mounts. If the local server uses `home: /home/alice` and `artifactUploads.root: ~/trash`, set both `OPENCODEBOT_ARTIFACT_UPLOAD_SOURCE=/home/alice/trash` and `OPENCODEBOT_ARTIFACT_UPLOAD_ROOT=/home/alice/trash` in Compose's ignored `.env` file. Without that mount, the bot can build the correct host path but still fail to create it from inside the container.

For Windows servers, keep the server path and the Docker mount path conceptually separate. `artifactUploadRoot: C:\Users\Alice\trash` is the path OpenCodez and the user should see on a Windows host. A Linux Docker container cannot automatically write a drive-letter path unless that folder is deliberately mounted to a writable container path and the server config uses that writable path. For Windows final paths, SSH transfer or running opencodebot directly on Windows is usually clearer. See [Docker](docker.md#artifact-dropbox-paths) for the deployment matrix.

Cloud Bot API deployments are still limited by Telegram's cloud file download limit. Local Bot API deployments can accept larger files if `attachments` is raised and the local Bot API sidecar has access to the downloaded file root.

```json
{
  "artifactUploads": {
    "enabled": true,
    "root": "~/trash",
    "dateFolders": true
  }
}
```

Per-server roots belong in `servers.json` when one host needs a different dropbox path.

```json
{
  "id": "winbox",
  "url": "http://winbox.local:4096",
  "home": "C:\\Users\\winbox",
  "pathStyle": "windows",
  "artifactUploadRoot": "D:\\Inbox\\opencodebot"
}
```

## Web And WireGuard

`web.publicBaseUrl`, `web.privateBaseUrl`, and `web.preferHttp` are used when the bot builds links to OpenCodez web UI. `preferHttp` is mostly for private LAN links where HTTPS is not the useful default.

`wireguard` exists for the optional helper script only. It can expose a private LAN web UI from outside the LAN, but the Telegram bot, OpenCodez API mirroring, long polling, and LAN web UI do not depend on WireGuard.

## Paths And State

`paths.statePath` points to durable bot state. `state.json` stores topic/session bindings, the current artifacts topic, the current sounds topic, the global full/economy mirror mode, mirror enabled state, pending Telegram-origin prompt ids, known sessions, per-session mirror markers, bounded reconcile windows, and final-notification opt-ins/dedupe markers. It should not contain full prompt queue text. The `/q` queue is memory-only and disappears on service restart by design.

If OpenCodez reports a terminal run failure, the bot announces the failure, clears queued prompts for that session, and lists the cleared items by number plus the same first-words summary used by `/q status`. The queue releases the next prompt only after OpenCodez reports the session idle; reconnects, progress events, assistant step completion, and tool-only events do not release or clear the queue.

`paths.uploadsDir` stores downloaded Telegram files as local staging. Uploaded files are runtime material and should stay out of git. Small files are inlined into OpenCodez prompts as data URLs. Larger accepted files are copied to the selected server's `uploadRoot`, and the prompt describes the server-local path, size, and MIME metadata. This keeps multihost and Windows setups usable because the path shown to the model belongs to the selected OpenCodez host, not to the bot container.

```text
dima:    /home/dima/.opencodebot/uploads/...
Windows: C:\Users\Alice\.opencodebot\uploads\...
```

WireGuard private keys and peer configs live under the configured runtime state path and `/etc/wireguard` on Linux hosts, not in the repo.

## Useful Changes

Use the runtime config for local behavior on Linux/macOS:

```bash
npm run init-config
$EDITOR config.local.json
$EDITOR servers.json
npm start
```

Use the same files from PowerShell on Windows:

```powershell
npm run init-config
notepad .\config.local.json
notepad .\servers.json
npm start
```

Before sharing the bot with a friend, the important knobs are usually `telegram.chatId`, `telegram.allowedUserIds`, `telegram.allowChatBootstrap`, `defaultPrompt.serverID`, `chatTemplates`, `attachments`, `artifactUploads`, final-notification recipients, artifact gateway address/token env, and web base URLs.

When changing the config shape, update `config.example.json`, `src/config.mjs`, and the relevant docs together. Keep defaults reasonable and boring.
