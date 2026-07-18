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

`config.example.json` is the public shape and smoke-test baseline. `npm run init-config` creates the local runtime copy and an editable `servers.json`. Edit the runtime copy for local behavior, and update `config.example.json` only when the shareable default shape changes.

## Loading

The bot reads `OPENCODEBOT_CONFIG` when it is set. If it is not set, the loader uses `config.local.json` in the repo root. If that file does not exist, startup fails. `scripts/smoke.mjs` passes `config.example.json` explicitly for local contract checks, but the runtime loader no longer falls back to example config by itself.

Relative paths in config are resolved from the config file's directory. This keeps the same config shape usable on Linux and Windows.

The Docker Compose setup mounts `config.local.json`, `servers.json`, `token.env`, and `state/` into the container at the same `/app/...` paths. That means the config created by `npm run init-config` works for both direct npm usage and Docker. The only common Docker-specific edit is the OpenCodez URL in `servers.json`: use a LAN URL or `host.docker.internal`, not `127.0.0.1`, when OpenCodez runs on the host.

The loader also reads `paths.tokenEnv` and then overlays process environment variables on top. That means Compose, PowerShell, shell sessions, and local scripts can override values from `token.env` without editing the runtime JSON.

OpenCodez servers come from `paths.serversJson`, not from the main config body. The public example points at `servers.example.json`; `npm run init-config` creates a local ignored `servers.json` for your real hosts.

## Secrets

`token.env` is read by local scripts and the Compose runtime. It holds values such as the Telegram bot token, allowed user ids, the OpenCodez password, the optional artifact gateway token, optional `OPENROUTER_API_KEY` for speech transcription, and optional `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` credentials for the local Telegram Bot API sidecar. Do not print it, paste it into docs, or commit it.

The runtime config must explicitly name Telegram secret sources. Use `telegram.token.env` for the bot token and either a literal `telegram.allowedUserIds` array or `telegram.allowedUserIds.env` for operator ids. The loader does not scan unrelated environment variables for Telegram-looking tokens or user ids. `opencode.passwordEnvNames` remains a configured list for OpenCodez password lookup.

Non-secret config is intentionally small. It covers deployment identity and ownership: chat id, allowed user ids, OpenCodez servers, default prompt profile, chat templates, attachment limits, speech transcription settings, artifact upload folders, final-notification recipients, artifact gateway address, paths, and optional web/WireGuard helpers. The global full/economy mirror mode is runtime state controlled by `/mode`, and the global final-DM diagnostics mode is runtime state controlled by `/debug_on`, `/debug_off`, and `/debug_status`; prompt pinning, reconcile windows, multipart buffering, and tool compaction limits are fixed defaults in code.

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

When files arrive without captions, the bot waits for plain text from the same user/topic before sending the prompt to OpenCodez. If Telegram splits a large follow-up text into several messages, the bot keeps collecting those chunks until the short attachment-text idle window settles, then sends one prompt with all files and text chunks together. Telegram-authored Rich Messages require no additional configuration: readable block text becomes the prompt, and embedded rich photo blocks use these same attachment limits and buffering rules.

Attachment policy belongs at top-level `attachments`; old `telegram.attachments` compatibility has been removed.

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

`speech` is an optional OpenRouter/direct-Groq voice transcription module. It is disabled by default and has no local model, GPU, or worker dependency. Set `speech.enabled` to `true`, then provide `OPENROUTER_API_KEY`, `GROQ_API_KEY`, or both in `token.env` or the process environment. A missing provider key hides only that provider's models; it does not disable another configured provider.

```json
{
  "speech": {
    "enabled": true,
    "maxFileBytes": 25000000,
    "queueConcurrency": 1,
    "statusMessage": "Transcribing voice...",
    "defaultModel": "openai/whisper-large-v3-turbo",
    "language": "auto",
    "temperature": 0,
    "responseFormat": "json",
    "prompt": "Русская голосовая заметка. Сохраняй технические названия, команды, пути и сокращения латиницей.",
    "openrouter": {
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "url": "https://openrouter.ai/api/v1/audio/transcriptions"
    },
    "groq": {
      "apiKeyEnv": "GROQ_API_KEY",
      "url": "https://api.groq.com/openai/v1/audio/transcriptions"
    },
    "models": [
      { "id": "openai/whisper-large-v3-turbo", "apiProvider": "openrouter", "apiModel": "openai/whisper-large-v3-turbo", "label": "Whisper V3 Turbo", "upstreamProvider": "Groq", "price": "$0.04/hour" },
      { "id": "groq/whisper-large-v3", "apiProvider": "groq", "apiModel": "whisper-large-v3", "label": "Whisper V3", "price": "Free tier · $0.111/hour paid" },
      { "id": "groq/whisper-large-v3-turbo", "apiProvider": "groq", "apiModel": "whisper-large-v3-turbo", "label": "Whisper V3 Turbo", "price": "Free tier · $0.04/hour paid" }
    ]
  }
}
```

Once speech is enabled, Telegram voice messages in ordinary non-artifact topics are downloaded, sent through the selected model's API provider, and answered as replies in the same topic. OpenRouter uses its JSON/base64 STT request, while direct Groq uses Groq's OpenAI-compatible multipart transcription endpoint. They stop before question handling, attachment buffering, and prompt dispatch, so a transcript reaches OpenCodez only after the operator copies it and sends it as text. General audio files outside the dedicated speech topic keep the normal attachment behavior.

Run `/sounds_here` in a Telegram forum topic when you also want a dedicated voice/audio inbox. The command creates and pins a model menu; operators can switch the selected model with inline buttons, and `Refresh` redraws the same menu after adding or removing configured models. Voice messages, general audio files, and supported audio documents in that topic are transcribed. Only the transcript is wrapped in Telegram Mono formatting so it can be selected/copied without also copying model or timing metadata. Text in the dedicated speech topic is not forwarded to OpenCodez sessions. `/sounds_off` clears only this dedicated inbox; ordinary-topic voice transcription remains active while `speech.enabled` is true.

`models[].id` is the stable selection key stored by the bot. `apiProvider` chooses `openrouter` or `groq`; `apiModel` is the provider's raw model id. `upstreamProvider` is needed only for provider-specific OpenRouter request options and is not the label shown in Telegram. The menu label comes from `apiProvider`, which keeps direct Groq visibly distinct from OpenRouter.

The prompt is deliberately short and configurable. Leave it blank if generic transcription is better for your group, or replace it with a small vocabulary hint. Do not put secrets in it.

`speech.language` defaults to `"ru"` and is sent as a transcription hint. Set it to another ISO-639-1 code such as `"en"` when the speech topic is mostly another language. Set it to `null` or `"auto"` to omit the `language` field and let the selected provider auto-detect the audio language. A model entry may override `language`, `prompt`, `temperature`, or `responseFormat`.

```json
{
  "speech": {
    "language": "auto"
  }
}
```

## OpenCodez

`opencode.baseUrl` is the local/default API origin used when a server-specific URL is not involved. `opencode.passwordEnvNames` lists env var names that may contain the OpenCodez password.

The bot separates mirroring from Telegram-created session placement. `opencode.mirrorScope` controls what the bot watches on configured OpenCodez servers: `global` mirrors new sessions from any workspace on that host, while `serverHome` keeps the older host-home scope. `opencode.newSessionDefaultDirectory` controls where `/new` creates sessions when the operator does not pass `dir:<path>`; the normal value is `serverHome`, which uses the selected server's `home` from `servers.json`.

Each server in `servers.json` needs a non-empty unique `id` and an absolute HTTP(S) `url`. The optional `home` field gives `/new` a default directory and lets `~/trash` expand naturally for artifact uploads. `uploadRoot` gives large Telegram prompt attachments a server-local destination. If `uploadRoot` is omitted and `home` is present, the bot derives the conventional prompt upload root from `home`. `artifactUploadRoot` overrides the global artifact file dropbox root for one server. `pathStyle`, when present, must be `posix` or `windows`; `offline_ok`, when present, must be a JSON boolean.

`transfer` stays simple. Omit it to use local transfer, or set `type` explicitly to `local` or `ssh`. SSH transfer also requires a non-empty `host`; an optional `port` must be an integer from 1 to 65535. The bot validates the whole server list before startup and reports all malformed entries and duplicate ids in one error block. It never drops a bad server silently or turns an unknown transfer type into `local`.

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

`defaultPrompt` is the fallback profile for Telegram-created sessions. It chooses the default OpenCodez server and the prompt metadata the bot can know before the first prompt: agent and model.

`chatTemplates` are named launch profiles for `/new` and `/reset [profile] [server]`; the key is retained for config compatibility and does not refer to the removed OpenCodez Template prompt kind. The built-in defaults are `d4flash`, `d4pro`, `luna`, `terra`, `solm`, `solh`, `sol`, and `solmax`. The four Sol profiles share the same model/System configuration and select `medium`, `high`, `xhigh`, and `max` variants respectively. Runtime config is merged with those defaults, so you can add a profile or override an existing profile without copying every default. `/reset` without arguments inherits profile/server/directory; one argument may select a profile or server; two arguments are profile then server. Same-server reset preserves the current directory, while cross-server reset preflights the target and uses its `newSessionDefaultDirectory` policy. On lazy session creation the bot applies the profile twice by design: it switches the OpenCodez session's next model so the web composer stays in sync, and it keeps sending the same model in prompt payloads so Telegram-origin prompts do not depend on browser-local state.

When two or more servers are configured, Telegram topic names are rendered as `<base title> (<serverID>)`; single-server installations retain plain names. The base title is stored separately from the managed suffix so `/reset solh dima` can rename `trash (nuc)` to `trash (dima)` without suffix accumulation or changing the user-owned base. `/new`, web autocreation, backend title synchronization, and manual Telegram renames use the same formatter, which recognizes every configured server suffix and reserves space inside the 128-character Telegram title limit. Existing bindings are migrated lazily on reset/title synchronization.

Each profile can define:

- `agent`: OpenCodez agent name.
- `model.providerID`: provider id.
- `model.modelID`: model id.
- `model.variant`: optional model effort/variant.
- `opencodezSystem`: OpenCodez System prompt name selected after the session model switch and before the first prompt.

Example:

```json
{
  "chatTemplates": {
    "sol": {
      "agent": "build",
      "model": { "providerID": "openai", "modelID": "gpt-5.6-sol", "variant": "xhigh" },
      "opencodezSystem": "codex_gpt_5_6_sol"
    },
    "solmax": {
      "agent": "build",
      "model": { "providerID": "openai", "modelID": "gpt-5.6-sol", "variant": "max" },
      "opencodezSystem": "codex_gpt_5_6_sol"
    }
  }
}
```

Then start a topic with:

```text
/new sol work on the upload flow
```

## Mirror Modes

The bot has two persistent global mirror modes controlled by `/mode full` and `/mode economy`. Both modes emit one short robot notice with the web-visible task title when a task/subagent is spawned. Full mode mirrors user-facing OpenCodez activity and compacts tool status into expandable quotes. Economy mode keeps each unique assistant progress message, final answer, and failure while suppressing ordinary Telegram tool sends and edits across every topic. Both modes hide internal helper tools such as `todo`/`todowrite`, child-session logs/results, and reasoning summaries, and use fixed Telegram-safe message limits. Web-origin user prompts that exceed the ordinary message limit switch to escaped Rich Message HTML up to a conservative 32,000-character limit; larger prompts are numbered and split only at that rich boundary, and rich rejection falls back to the complete ordinary-message split.

User prompts are always pinned. Telegram-origin runs pin the original user message after OpenCodez accepts the prompt; web-origin runs pin the mirrored user-prompt message. Telegram pin service messages are cleaned up when possible. Final assistant answers are marked with `🏁` but are not pinned.

Long Telegram prompts and bounded missed-event recovery are always on with conservative internal limits. Telegram attachments are always part of the product model, with size limits controlled by top-level `attachments` and clamped by Bot API mode.

## Final Notifications

`finalNotifications` controls optional private DM notifications for final mirrored answers. `finalNotifications.userIds` is the configured recipient allowlist. `/notify_on` enables notifications for those configured ids after verifying that the bot can DM them; `/notify_off` disables those configured recipients again.

Debug diagnostics require final-answer DMs and use one global persistent toggle for the bot. `/debug_on` adds the block to every future final DM regardless of source topic, `/debug_off` removes it globally, and `/debug_status` reports the current global setting. When enabled, the final DM ends with one expandable diagnostics block containing agent-step count and p50/p95/max durations, effective TPS average/p50/p95, aggregate completed/error `Tools/MCP` timing and failures, and the three slowest tool names. Overall duration stays only in the notification header instead of being repeated inside debug. TPS uses output plus reasoning tokens divided by assistant-step time minus the union of known tool intervals. It is intentionally end-to-end and therefore includes prefill/cache, provider/network, and model stalls; it is not a burst streaming benchmark. Tool timing comes from OpenCodez ToolPart `state.time.start/end`; cumulative tool time may exceed overall duration for overlapping calls.

The final DM is intentionally short and mode-neutral: it includes a source `Topic:` line from the topic's current canonical Telegram metadata rather than a finishing session's retained binding snapshot, with the Telegram topic name and topic custom emoji when Telegram provides it. The next line uses the compact form `⏱️ 2h 18m 14s · 🤖 gpt-5.6-sol-fast (max)`: duration is wall-clock time from the preceding user message to the completed final assistant message, while model and variant come from that main turn's message metadata rather than current binding or browser state. A second compact line uses `🪙 Tokens: 60.6M · in 24.0M · out 120.5K · cache 36.5M`. It sums normalized token usage from every assistant model call between the preceding user message and final assistant message; `out` includes reasoning and `cache` includes reads plus writes. Missing metadata is omitted cleanly. Child/subagent sessions and their models or token usage are not included. The DM also provides an `Open topic` button, quotes the original user prompt in an expandable block for orientation, includes a compact quoted `📋 Tasks [n/n]:` checklist when the agent closed one, and adds a separate quoted `Tools:` / `Patched:` block with compact tool counts and file names from successful structured file mutations. It does not include the final answer text. Durable dedupe markers are capped and keyed per recipient plus final assistant message. A missing marker remains retryable through recent periodic reconcile even after the topic answer is mirrored; repairs use the topic root when no exact Telegram answer message id survived. Legacy message-id-based markers remain accepted so rollout does not resend already delivered DMs.

The same configured `userIds` receive blocking OpenCodez question alerts with a direct link to the topic message. These alerts do not follow the per-user final-notification toggle because a pending question stops the active run. No additional recipient setting is required.

## Artifacts

`artifacts.enabled` starts the optional LAN artifact gateway. The gateway is for agent-created screenshots, logs, text snippets, and files that should be delivered to one Telegram artifacts topic. It is not a mirror-session router and it does not try to infer the current OpenCodez topic.

`artifacts.listenHost` and `artifacts.port` control the local HTTP listener. Docker Compose publishes the same port with `OPENCODEBOT_ARTIFACT_PORT`, defaulting to `8788`. Expose it only on trusted networks and keep bearer-token auth enabled.

`artifacts.tokenEnvNames` lists environment variable names that may contain the artifact token. The default is `OPENCODEBOT_ARTIFACT_TOKEN`. This token is shared with the OpenCodez plugin. It is not the Telegram bot token, and the plugin should never receive the Telegram bot token.

Artifact JSON payload, text, and caption limits are fixed safety defaults in code. File limits depend on Bot API mode: cloud mode keeps the conservative 50 MiB file limit, while local mode allows Telegram's 2 GB local Bot API limit through the streaming `/artifacts/send-file` path. Cloud-mode spool uploads also have an internal in-memory cap so oversized files fail fast instead of being read into RAM. Text artifacts are sent as expandable quotes. Suitable JPEG, PNG, and WebP files are sent with `sendPhoto` only when Telegram accepts their original size; oversized or rejected requested photos automatically retry as lossless `sendDocument` files.

The active target is chosen from Telegram with `/artifacts_here`. Running that command in another topic replaces the previous target. The target is stored in `state.json`, not config.

The same Telegram artifacts topic can receive files from users. A dropped file is saved on the configured default server when its caption is empty. When the caption starts with a server id, that server is used instead. Unknown server ids are rejected before the bot downloads the file. Comma-separated values after the server optionally rename files by position. A value with no extension inherits the source filename's complete suffix beginning with its first dot, so compound extensions such as `.tar.gz` remain intact; a value containing a dot is used as the exact filename. Missing or empty positions keep the corresponding source names, and extra values are ignored. Saved files go under `artifactUploads.root`, then an optional `YYYY-MM-DD` folder, then a sanitized filename. The default root is `~/trash`, expanded from the target server's `home`; on Windows this can become `C:\Users\name\trash` when that is the server home.

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

`paths.statePath` points to durable bot state. `state.json` stores topic/session bindings, pending topics waiting for their first prompt, the current artifacts topic, the current sounds topic, the global full/economy mirror mode, mirror enabled state, pending Telegram-origin prompt ids, known sessions, per-session mirror markers, bounded reconcile windows, final-notification opt-ins/dedupe markers, a bounded incomplete-run handling ledger, a bounded list of OpenCodez question/message bindings, and bounded reply-to-rewind links. The incomplete-run ledger contains only server/session/user-message identifiers, the observed assistant identifier and finish metadata, source, and handling time; it never stores prompt or answer text. Each rewind link contains only Telegram chat/topic/message ids plus OpenCodez server/session/user-message ids and status; it deliberately excludes prompt text and attachment contents. Topic title/icon metadata is synchronized across every retained binding for the same Telegram topic and its pending reset record; state load repairs older divergent copies from the newest metadata timestamp. `/reset` writes its old-disabled-binding and same-topic-pending transition in one state update, including the current visible topic title with user-owned title semantics, so a service restart cannot leave only half of that transition persisted or return title ownership to the new session. State load also migrates legacy pending or active bindings in topics with a historical `topic-reset` binding to user-owned title semantics, making the correction effective for sessions created before the policy existed. Question records contain request and session ids, Telegram message location, displayed options, status, and notified recipients. All mirrored message ids are retained inside each retained session bucket so reconcile cannot replay forgotten history; only old whole-session buckets are pruned. It should not contain full prompt queue text. The `/q` queue, multipart prompt buffer, attachment buffer, and active run trackers are memory-only and are cleared or disappear on service restart by design; idle and recent reconcile checks recover from losing an active tracker.

`telegram.contextTurnsByUser` is runtime-managed state for `/set_context`; it maps an allowed Telegram user id to a numeric default from 1 to 10. State load migrates the short-lived legacy `contextPairsByUser` key without losing an already selected default. `/context` assembles completed or interruption-ledger-marked turns on demand from OpenCodez and never stores prompt, partial answer, or final answer text in `state.json`. Its Rich Message chunk size, 240,000-character total ceiling, and default of three turns are fixed conservative behavior rather than runtime config knobs.

The mirror-marker references above are one logical part of durable state but are physically stored in the sibling append journal `<statePath>.mirror-markers.ndjson`; the high-frequency marker maps inside `state.json` stay empty. Startup atomically imports legacy JSON markers, compacts the journal to retained session buckets, and only then removes their duplicate JSON representation, so an interrupted migration or normal restart cannot silently lose dedupe history. New markers append tens of bytes and duplicate updates are no-ops; historical assistant markers skipped during catch-up are appended in one binding-level batch instead of rewriting the complete state file per message.

Do not roll the runtime back to a pre-journal release without first rehydrating its legacy JSON marker maps from the journal; old binaries do not know how to read the sibling file and could replay mirrored history. Normal forward deploys and restarts on journal-aware releases need no operator action.

Reconcile avoids repeated full-history reads by paging backward to its durable high-water cursor or window boundary. The common path requests five messages first; only a burst that does not reach the cursor continues with 20-message fallback pages. Cursor checkpoints and high-frequency activity leases mutate the live state immediately but share one deferred atomic save bounded to one minute; graceful shutdown flushes it, and a crash can only require a short conservative rescan. Session discovery uses the OpenCodez `start` high-water with a five-minute overlap and runs different hosts concurrently. Unchanged bindings are gated by `time.updated`; the watchdog verifies a small session object before requesting message pages, and exact-message recovery always retains pagination as fallback. These are fixed internal behavior-preserving optimizations rather than runtime tuning knobs.

If one immediate state write fails, that operation reports the error, but later state updates remain usable. Deferred activity/cursor checkpoints log a failure and retry after five seconds; any later successful immediate update also persists their current in-memory values. After repairing the underlying storage problem, the next successful update persists the current in-memory state. A restart still loses any mutations that never reached disk.

If OpenCodez reports a terminal run failure, the bot announces the failure, clears queued prompts for that session, and lists the cleared items by number plus the same first-words summary used by `/q status`. The queue releases the next prompt only after OpenCodez reports the session idle and the terminal assistant answer is mirrored to Telegram. Idle triggers a history reconcile when the terminal event has not arrived yet, and repeated idle events cannot release more than one prompt.

Every bound-session idle starts a short grace check; a user `message.updated` event also records the start early but is not required. If status and current message history still show no terminal visible answer, the bot sends one warning with an OpenCodez session button and uses that warning as the terminal queue signal. A non-terminal ending uses `OpenCodez run was interrupted`; a `finish=stop` assistant with no visible non-synthetic text uses `OpenCodez stopped without a final response`. Recent periodic reconcile repeats the check to recover missed idle events or restarts and independently retries missing final DMs for the latest successful visible answer. Once an outcome has been classified, the bounded handling ledger keeps its warning or expected-stop suppression idempotent; active trackers, queued prompt text, and retry throttles remain memory-only. This behavior has no runtime config surface.

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
