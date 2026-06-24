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

The loader also reads `paths.tokenEnv` and then overlays process environment variables on top. That means systemd, PowerShell, shell sessions, and local scripts can override values from `token.env` without editing the runtime JSON.

OpenCodez servers come from `paths.serversJson`, not from the main config body. The public example points at `servers.example.json`; `npm run init-config` creates a local ignored `servers.json` for your real hosts.

## Secrets

`token.env` is read by local scripts and can also be read by the Linux systemd unit. It holds values such as the Telegram bot token, allowed user ids, and the OpenCodez password. Do not print it, paste it into docs, or commit it.

The config names the environment variables to try. `telegram.tokenEnvNames` is checked first, but the loader can also recognize a Telegram-looking token from the env file. `telegram.allowedUserEnvNames` is checked first for user ids; if none are found, the loader falls back to env names that look like owner/user/allowed id variables. `opencode.passwordEnvNames` works the same simple way for the OpenCodez password.

Non-secret behavior belongs in config: chat id, allowed user ids, default prompt profile, mirror options, hidden tools, multipart buffering, attachment limits, uploads paths, and optional WireGuard settings.

## Telegram

`telegram.chatId` pins the bot to the intended Telegram forum chat. `telegram.mainTopicId` is the topic used for general bot replies when there is no session-specific topic.

`telegram.allowedUserIds` limits who can control the bot. Keep this explicit before handing the bot to someone else. `telegram.allowChatBootstrap` is useful only during first setup: if no chat is configured yet, the first allowed message can bind the bot to that chat. After setup, set the chat id and turn bootstrap off.

`telegram.autocreateTopics` lets the bot create forum topics automatically for new OpenCodez sessions. This applies both to Telegram-created sessions and to web-originated OpenCodez sessions discovered through events or reconcile. Disable it if you want topic creation to be fully manual.

## OpenCodez

`opencode.baseUrl` is the local/default API origin used when a server-specific URL is not involved. `opencode.passwordEnvNames` lists env var names that may contain the OpenCodez password.

`opencode.useServerHomeAsDirectory` controls the `directory` sent when the bot creates a session. When it is true and the selected server has a `home` field in `servers.json`, new sessions start there. When it is false, session creation leaves directory selection to OpenCodez defaults.

Each server in `servers.json` should have an `id` and `url`. Optional fields are `label`, `home`, and `offline_ok`. Offline servers do not stop the bot; the event stream backs off and retries.

## Prompt Profiles

`defaultPrompt` is the fallback profile for Telegram-created sessions. It chooses the default OpenCodez server and the prompt metadata the bot can know before the first prompt: agent, model, and optional `opencodezTemplate`.

`chatTemplates` are named profiles for `/new`. The built-in defaults are `d4flash`, `d4pro`, and `gpt55p`. Runtime config is merged with those defaults, so you can add a new template or override one existing template without copying every default.

Each template can define:

- `agent`: OpenCodez agent name.
- `model.providerID`: provider id, such as `openai` or `deepseek`.
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

## Mirror

`mirror.enabled` is the main kill switch for OpenCodez-to-Telegram mirroring. Telegram commands can still exist around it, but assistant/tool events are ignored when mirroring is disabled.

`mirror.pinFinalAnswers` pins final assistant answers in the topic. `mirror.deletePinServiceMessages` removes Telegram's automatic pin service messages when possible, keeping topics quieter.

`mirror.finalMarker` is appended when the assistant step finishes normally. Keep it short; it is there to make final answers easy to spot in a busy topic.

`mirror.maxTelegramChars` caps message size before the renderer splits or truncates output for Telegram limits. `mirror.editDebounceMs` controls how often an in-progress assistant message may be edited if streaming-style rendering is active. Current assistant text is normally sent as completed blocks, so this is mostly a safety knob.

`mirror.showReasoningSummaries` controls whether reasoning summaries are mirrored. Keep it false unless you explicitly want that noise in Telegram.

`mirror.hiddenTools` hides tool names from the live tool quote. This is useful for internal helper tools such as `todo`, `todowrite`, or other agent bookkeeping tools that do not help the Telegram reader.

`mirror.toolBatchMaxLines` limits how many recent tool lines are kept in the expandable tool quote. Raising it gives more live detail; lowering it keeps Telegram topics quieter.

## Multipart Prompts

`multipartPrompts` is a small in-memory repair layer for Telegram clients that split long messages near Telegram limits. It is not a second prompt editor.

`enabled` turns the buffer on or off. `minChars` decides how large a message must be before the bot treats it as a possible partial prompt. `idleMs` is how long the bot waits for more parts before sending. `maxParts` and `maxChars` stop accidental huge buffers.

If long prompts are being sent too early, raise `idleMs`. If ordinary messages are getting buffered unexpectedly, raise `minChars`.

## Prompt Feedback

`promptFeedback` controls the small Telegram replies that make prompt delivery visible. When enabled, the bot says when OpenCodez accepted a prompt and reports unbound topics, backend rejection, or later session errors instead of failing silently.

Each feedback class can be disabled separately with `accepted`, `queued`, and `errors`, but production use should normally keep error feedback on.

## Final Notifications

`finalNotifications` controls optional private DM notifications for final mirrored answers. `finalNotifications.userIds` is the configured recipient allowlist. `/notify_on` enables notifications for those configured ids after verifying that the bot can DM them; `/notify_off` disables those configured recipients again.

The final DM is intentionally short: it names the topic, links to the final message in the Telegram topic, and does not include the final answer text. `maxSentMarkers` caps durable dedupe markers so live events plus reconcile do not send the same final notification twice.

## Reconcile

`reconcile` is a bounded recovery path for the current or recent run. It is not a full historical backfill. When a Telegram prompt is sent, a web topic is autocreated, or a web-origin prompt arrives through events, the binding gets a `reconcileAfter` lower bound and a `reconcileUntil` expiry.

`intervalMs` controls how often the recovery loop runs. `lookbackMs` gives a small safety margin before the triggering prompt or topic creation. `activeWindowMs` decides how long a binding stays eligible for missed-event recovery after current activity. Raising it helps very long runs; lowering it keeps old topics quieter sooner.

## Attachments

`attachments.enabled` controls Telegram file download support. Files are downloaded to `paths.uploadsDir`, attached to the next prompt as data URLs for OpenCodez, and later cleaned by age.

`mediaGroupIdleMs` lets Telegram albums settle before processing. `promptIdleMs` is how long files can wait for the user to send the text prompt that should go with them.

`maxFiles`, `maxFileBytes`, and `maxTotalBytes` are the safety limits. Keep them boring before sharing the bot; Telegram makes it easy to send more data than intended. `cleanupAfterMs` controls how long downloaded files remain on disk before cleanup.

## Web And WireGuard

`web.publicBaseUrl`, `web.privateBaseUrl`, and `web.preferHttp` are used when the bot builds links to OpenCodez web UI. `preferHttp` is mostly for private LAN links where HTTPS is not the useful default.

`wireguard` exists for the optional helper script only. It can expose a private LAN web UI from outside the LAN, but the Telegram bot, OpenCodez API mirroring, long polling, and LAN web UI do not depend on WireGuard.

## Paths And State

`paths.statePath` points to durable bot state. `state.json` stores topic/session bindings, mirror enabled state, pending Telegram-origin prompt ids, known sessions, per-session mirror markers, bounded reconcile windows, and final-notification opt-ins/dedupe markers. It should not contain full prompt queue text. The `/q` queue is memory-only and disappears on service restart by design.

If OpenCodez reports a terminal run failure, the bot announces the failure, clears queued prompts for that session, and lists the cleared items by number plus the same first-words summary used by `/q status`. Reconnects, progress events, and tool-only events do not release or clear the queue.

`paths.uploadsDir` stores downloaded Telegram files. Uploaded files are runtime material and should stay out of git. WireGuard private keys and peer configs live under the configured runtime state path and `/etc/wireguard` on Linux hosts, not in the repo.

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

Before sharing the bot with a friend, the important knobs are usually `telegram.chatId`, `telegram.allowedUserIds`, `telegram.allowChatBootstrap`, `defaultPrompt.serverID`, `chatTemplates`, `mirror.hiddenTools`, attachment limits, and web base URLs.

When changing the config shape, update `config.example.json`, `src/config.mjs`, and the relevant docs together. Keep defaults reasonable and boring.
