# Configuration and runtime

[English](config-runtime.md) · [Русский](../ru/config-runtime.md) · [All languages](../README.md)

Configuration describes the installation: credentials, server addresses, paths and provider access. Telegram preferences describe how people use it: profiles, language, notifications and topic choices. After the first import, edit profiles in General; changing their installation seeds does not change saved preferences.

Use [first run](first-run.md) for guided installation and [Docker](docker.md) for mounts. This page is the configuration and storage reference. Event flow and failure recovery belong in [architecture](architecture.md).

## Loading

`npm run setup` prepares private files. `npm run init-config` creates `config.local.json` and `servers.json` for manual setup. Startup reads `OPENCODEBOT_CONFIG`, or `config.local.json` in the checkout. A missing file is an error; the bot never silently runs the public example.

Relative paths resolve from the configuration file's directory. `paths.tokenEnv` is read first, then process environment overrides it. Keep secrets out of JSON and Git.

| File or setting | Purpose |
| --- | --- |
| `config.example.json` | Shareable configuration shape, with optional providers and scheduled updates off |
| `config.local.json` | Private installation configuration |
| `paths.serversJson` | Server inventory; normally `servers.json` |
| `paths.tokenEnv` | Secret environment file; normally `token.env` |
| `paths.statePath` | Durable state; normally `state/state.json` |
| `paths.uploadsDir` | Temporary Telegram downloads; normally beside state |
| `.env` | Compose host paths and UID/GID; [mount variables](docker.md#files) |

Compose mounts the private files at `/app/config.local.json`, `/app/servers.json`, `/app/token.env` and `/app/state`. Configuration used inside Docker must refer to those container paths. Native Node configuration refers to host paths. Keep these two views explicit when using an external configuration directory.

## Secrets and access

The Telegram token source is explicit: `telegram.token.env`. Operator IDs come from a literal `telegram.allowedUserIds` array or its `.env` reference. OpenCodez credentials use `opencode.passwordEnvNames`; Basic Auth defaults to username `opencode`. Set `opencode.username` if your backend uses a custom `OPENCODE_SERVER_USERNAME`. HTTP and SSE use the same credentials. The loader does not search unrelated environment variables for Telegram-looking values.

```env
OPENCODEBOT_TOKEN=123456:bot-token
OPENCODEBOT_ALLOWED_USER_IDS=123456789
OPENCODEZ_SERVER_PASSWORD=optional-password
OPENCODEBOT_ARTIFACT_TOKEN=separate-random-token
GROQ_API_KEY=optional-transcription-key
OPENROUTER_API_KEY=optional-transcription-key
```

`telegram.chatId` selects the forum group. With no configured chat, `telegram.allowChatBootstrap=true` lets the first allowed group message bind it in state. For a shared installation, set the intended chat and operator IDs explicitly. Opening the bot's private chat permits notifications; explicit notification opt-outs persist.

Keys entered through `/setup` live in owner-only `provider-secrets.json` beside state. They override the corresponding provider credential and are filtered before inbox receipt. Include this file in private backups. [First run](first-run.md#audio) explains the Telegram input boundary.

## OpenCodez

Each inventory entry needs a unique non-empty `id` and an absolute HTTP(S) `url`. Startup validates the complete list and reports malformed entries together.

```json
{
  "servers": [{
    "id": "workstation",
    "url": "http://workstation.local:4096",
    "home": "/home/operator",
    "uploadRoot": "/home/operator/.opencodebot/uploads",
    "artifactUploadRoot": "/home/operator/trash",
    "transfer": { "type": "ssh", "host": "workstation.local" }
  }]
}
```

| Setting | Meaning |
| --- | --- |
| `opencode.mirrorScope` | `global` watches all workspaces through one `/global/event` stream per server; `serverHome` watches `/event` in `home` |
| `opencode.newSessionDefaultDirectory` | `serverHome` uses the chosen server's home; `none` leaves directory selection to OpenCodez |
| `home` | Default session directory and base for `~/trash`; required for `serverHome` mirroring |
| `uploadRoot` | Final server-local location for large prompt attachments; derived from `home` when omitted |
| `artifactUploadRoot` | Per-server override for the incoming FILES dropbox |
| `pathStyle` | Optional `posix` or `windows`; drive and UNC paths are recognized |
| `offline_ok` | Boolean; an optional server does not block deployment health verification |
| `transfer.type` | `local` or `ssh`; omitting transfer means local filesystem access |
| `transfer.host`, `user`, `port`, `identityFile` | SSH destination and optional connection details; port is 1–65535 |

The OpenCodez URL and file-transfer destination are separate. A Linux container can reach a Windows API while still needing SSH to write Windows paths. See [Docker path rules](docker.md#artifact-dropbox-paths). `opencode.baseUrl` is the fallback API origin; inventory entries provide the actual server URLs.

## Prompt profiles

`promptProfiles` and `defaultPrompt` seed the initial launch preferences. A new installation gets `sol`, `solm`, `solx` and `d4flash`. Existing installations import their former built-ins and explicit profiles once. Deleted profiles stay deleted after restart. General owns the effective collection and default profile thereafter.

| Profile | Provider/model | Reasoning |
| --- | --- | --- |
| `sol` | `openai/gpt-6.1-sol` | `high` |
| `solm` | `openai/gpt-6.1-sol` | `medium` |
| `solx` | `openai/gpt-6.1-sol` | `xhigh` |
| `d4flash` | `deepseek/deepseek-flash` | `max` |

A profile contains `agent`, `model.providerID`, `model.modelID`, optional `model.variant` and optional `opencodezSystem`. Sol's built-in System requires OpenCodez `1.18.33+opencodez.1` or newer. Provider availability and supported variants come from the selected server's catalog; a catalog entry does not prove quota or paid access.

The wizard saves the displayed launch snapshot, including a topic-only reasoning override. The first prompt and a retry of unfinished setup use that snapshot even if someone edits the named profile meanwhile. Model selection updates both the OpenCodez composer and Telegram prompt payload. `/reset` resolves the current named profile, or uses the retained snapshot if that profile was deleted. To change a failed launch's settings, edit/select a profile and explicitly reset the topic.

## Attachments

`attachments` is a top-level block. `enabled`, `maxInlineBytes`, `maxFileBytes` and `maxTotalBytes` control acceptance and embedding. Normal defaults accept ten files, 20,000,000 bytes per file and 60,000,000 bytes per batch; small files become data URLs, larger ones are copied to `uploadRoot`.

```json
{ "attachments": { "enabled": true, "maxInlineBytes": 20000000,
  "maxFileBytes": 20000000, "maxTotalBytes": 60000000 } }
```

Known counts and sizes are checked before download. Actual downloads share the remaining batch budget, including captionless files already waiting for text. Waiting/queued files retain paths rather than base64 copies in memory; inline encoding happens just before dispatch, while queue admission still reserves its encoded-content budget. Successful or failed prompt delivery removes staging files; transferred server files remain available to the agent and history. Hourly cleanup removes expired loose staging files. Final upload roots and FILES have no automatic retention policy: their owner decides when old files are no longer needed.

Cloud Bot API downloads are clamped to its conservative per-file limit. Local mode permits larger configured files. Raising a limit increases staging disk use and, for inline content, memory and request size. [Artifact delivery](artifact-gateway.md) covers the separate streamed outbound path.

## Speech transcription

`speech.enabled` is off by default. Enable it and provide either provider key to use OpenRouter or direct Groq. The model menu hides only models whose provider has no key. `/setup` can store a Groq key and enable direct `groq/whisper-large-v3-turbo` without editing read-only config.

```json
{ "speech": { "enabled": true, "defaultModel": "groq/whisper-large-v3-turbo",
  "maxFileBytes": 25000000, "queueConcurrency": 1, "language": "auto" } }
```

`language` accepts an ISO-639-1 code or `auto`/`null`; automatic mode omits it from the provider request. `prompt`, `temperature` and `responseFormat` are provider hints. `openrouter` and `groq` hold endpoint/key-environment settings. Custom `models[]` entries use `id` as the stored selection key, `apiProvider` as the API transport and `apiModel` as the provider model name; optional `label`, `upstreamProvider`, `price` and per-model hints complete the menu.

Voice notes in ordinary topics and audio in AUDIO produce copyable transcripts, never automatic agent prompts. Twenty recordings may wait behind active transcription. Excess recordings receive a resend notice. Provider errors report HTTP status without copying response bodies into Telegram or logs.

## Optional features and global choices

| Setting or command | Owner |
| --- | --- |
| `telegram.botApi` | Cloud by default; local endpoint, shared file root and app credentials are described in [Docker](docker.md#local-telegram-bot-api) |
| `artifacts`, `artifactUploads` | Gateway listener/authentication and incoming dropbox; [API and plugin](artifact-gateway.md) |
| `finalVoice` | Deployment access to summary/TTS providers; [configuration and commands](final-voice.md) |
| `finalNotifications.userIds` | DM recipients; an empty list uses allowed operators |
| `ui.defaultLanguage` | Initial UI language; `/lang eng` or `/lang ru` overrides it globally in state |
| `ui.timeZone` | Daily answer counter; falls back to `updates.timeZone`, then the system zone |
| `updates` | Explicit repository/branch and optional `checkAt`/`timeZone`; [self-update](self-update.md) |
| `web.publicBaseUrl`, `privateBaseUrl`, `preferHttp` | OpenCodez web links; private links need a reachable LAN/VPN route |
| `wireguard` | Optional host helper only; [private browser access](wireguard.md) |

Mirror detail (`/mode`), mirror on/off, random names, reminders, context depth, notification choices and voice preferences live in state. Prompt pinning, event recovery windows and multipart buffering use internal conservative defaults rather than a second public tuning surface.

## Paths and state

Back up a stopped bot. Copy the private configuration and environment, all state files below, provider secrets when present, and the local Bot API volume. Preserve ownership and permissions. A running file-by-file copy can combine incompatible points in time.

| Durable file | Contents |
| --- | --- |
| `state.json` | Bindings and disabled history, pending launches, profiles/preferences, topic names/icons, panel location, destinations, bounded origin/question/notification/reminder records and answer statistics |
| `state.json.mirror-markers.ndjson` | Append-only user/assistant delivery IDs, compacted on startup and session removal |
| `state.json.telegram-inbox.ndjson` | Telegram receipt cursor and unfinished updates, including private incoming text and file references |
| `provider-secrets.json` | Setup-entered credentials; owner-only |
| `state.json.health.json` | Replaceable process/progress/queue snapshot, with no conversation text |
| `updates/` | Request/status protocol for the fixed host updater |

State retains delivery IDs within at most 250 whole session buckets; it does not trim individual messages from a retained bucket. In-memory Set indexes make repeated delivery checks independent of that session's history length. The seen-session list is capped at 5,000; retained disabled bindings still prevent rediscovery from reviving a stopped topic.

Delivery journals accept only complete newline-terminated records. Startup drops an incomplete final append; malformed complete records stop startup. Preserve a corrupt journal for repair. Deleting the inbox can lose already acknowledged work. Failed receipt/completion writes stop the bot; repair storage before restarting.

Activity leases and reconcile cursors share a deferred atomic save within one minute, flushed on shutdown. Immediate state writes persist other mutations too. A failed state save reports the error; deferred saves retry after five seconds. A crash loses mutations that never reached disk. See [recovery guarantees](architecture.md#recovery-and-limits).

The prompt queue, multipart/media buffers, personal drafts and unfinished voice jobs are memory-only. Prompt queues allow 20 items per session, 100 overall and 64 MiB of text/inline-file content. Queued files also occupy staging disk. Restarts drop these buffers; inbox receipt does not make them durable.

A confirmed session-specific `404` removes its binding and session-keyed records, then keeps a pending launch in the same topic. `/reset` preserves old session history instead. Do not edit live state through a second `StateStore.load`: loading can migrate, compact and save.

Rolling back to pre-inbox code requires draining the inbox, stopping the bot, and copying its final checkpoint `offset` into `runtime.telegramUpdateOffset` in the stopped state file. Older code cannot recover pending inbox records. For other migrations, restore the matching stopped-bot backup and previous image together; [self-update](self-update.md) describes automatic rollback limits.
