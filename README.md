# opencodebot

opencodebot is a small Telegram mirror and companion for [OpenCodez](https://github.com/Krablante/opencodez). OpenCodez
stays the main interface and source of truth; the bot adds Telegram forum topics, prompts, progress, compact tool
status, attachments, interactive questions, user-prompt pins, final notifications, artifact delivery, optional voice
transcription, and a memory-only prompt queue.

It is built as a practical single-operator tool that is still clean enough to share. The code favors readable modules,
plain JSON config, and boring runtime state over a large framework.

## Why OpenCodez

opencodebot is tuned for OpenCodez's API and event stream. It works especially well with OpenCodez because that fork
adds selectable System prompts, token-saving pruning, and a more convenient cached web UI. That web UI remains useful on
the LAN by default, and can also be reached away from home through the optional WireGuard helper if you want private
remote access.

The bot does not scrape the web UI. It talks to the OpenCodez HTTP API and `/event` SSE stream, then mirrors useful
session activity into Telegram.

## Features

- Telegram forum topics mapped to OpenCodez sessions.
- `/new [server] [profile] [dir:<path>] [title]` for explicit server/profile/directory/topic setup.
- User-provided topic titles stay user-owned; placeholder titles can be renamed from OpenCodez session titles.
- `/q` in-memory per-session prompt queue, with status/delete commands.
- `/kill` to stop the current OpenCodez run for a topic and clear queued prompts.
- `/reset` to preserve the old session and start fresh in the same Telegram topic.
- Reply to an earlier Telegram user prompt to rewind that OpenCodez branch and replace it with the reply text and
  attachments.
- Rich assistant messages sent as completed blocks instead of noisy token streaming; nested lists are structurally
  normalized to stable visual lines because Telegram Rich Message mis-renders list dedents.
- Single-choice OpenCodez questions mirrored into the bound topic with Telegram buttons; configured recipients receive a
  direct notification linking to the question. SSE delivery is immediate, while the existing 15-second reconcile loop
  and every SSE reconnect query pending questions as a recovery path; request-level single-flight prevents
  event/recovery duplicates.
- Global `/mode full|economy` mirror modes: full keeps compact expandable tool quotes, while economy shows assistant
  progress and final answers without Telegram tool traffic.
- Both modes announce task/subagent spawns with a short robot notice that uses the web-visible task title; child-session
  prompts, tool logs, and results stay hidden.
- Attachments and Telegram media groups attached to the next prompt; large files are copied to the target server's
  configured upload root and referenced by server-local path.
- Optional Telegram artifact gateway for sending agent-created files, screenshots, logs, and text into one dedicated
  artifacts topic; the same topic can accept user-dropped files and save them to a configured server folder.
- Optional OpenRouter and direct Groq speech transcription for one dedicated `/sounds_here` topic; voice and audio
  messages receive lossless plain Telegram transcripts in the same topic, split across ordinary 4,096-character-safe
  messages instead of being truncated or converted to Rich Messages. A pinned model menu lets operators switch providers
  and STT models.
- Optional local Telegram Bot API sidecar for higher file limits and streaming artifact delivery without a separate
  project.
- Multipart prompt buffering for Telegram clients that split long messages.
- Long web-origin prompts use one escaped Telegram Rich Message when they exceed the ordinary message limit; only
  prompts beyond the richer safe limit are numbered and split, with a lossless ordinary-message fallback.
- Telegram-authored Rich Messages are accepted as prompts: block text is normalized into readable prompt text and
  embedded rich photos reuse the ordinary attachment pipeline.
- Optional WireGuard helper for private off-LAN access to the existing OpenCodez web UI.

## Shape

```text
Telegram forum chat
  -> opencodebot long polling
    -> OpenCodez HTTP API and /event SSE
    -> local topic/session state

LAN browser, or optional WireGuard browser
  -> OpenCodez web UI and server selector
```

OpenCodez remains the main workspace. Telegram is the mirror/control surface for moments when a chat interface is more
convenient.

OpenCodez owns session and message identifiers. The bot submits prompts without client-generated message ids, then binds
the original Telegram message to the canonical id reported by `session.next.prompted` (or recovered by reconcile). This
keeps OpenCodez ordering, Web UI grouping, and Telegram reply-to-rewind on one durable identity without duplicating
backend id rules.

## Platforms

Docker Compose is the recommended deployment path on Linux, Windows, and macOS. The bot also runs directly through
Node.js and npm. Windows is fully fine as a Telegram, browser, Docker, and WireGuard client.

## Quick Start

You need Node.js 18 or newer, Docker Compose, a running OpenCodez server, and a Telegram bot token from BotFather. The
bot can run on the same machine as OpenCodez or on another machine that can reach OpenCodez over HTTP.

Clone the repo and create local config:

```bash
git clone https://github.com/Krablante/opencodebot.git
cd opencodebot
npm run init-config
cp token.env.example token.env
```

This creates `config.local.json` and `servers.json`, then gives you a local `token.env` to fill in. Edit these before
starting the bot:

```bash
$EDITOR config.local.json
$EDITOR servers.json
$EDITOR token.env
```

PowerShell works the same way:

```powershell
Copy-Item .\token.env.example .\token.env
notepad .\config.local.json
notepad .\servers.json
notepad .\token.env
```

Secrets belong in `token.env`, not in git. Use your BotFather token, your numeric Telegram user id, and the password for
the OpenCodez server API:

```env
OPENCODEBOT_TOKEN=123456:telegram-token
OPENCODEBOT_ALLOWED_USER_IDS=123456789
OPENCODEZ_SERVER_PASSWORD=your-opencodez-password
# Optional, only when speech.enabled is true:
OPENROUTER_API_KEY=sk-or-...
```

Edit `servers.json` so the bot can reach OpenCodez. If OpenCodez is on your LAN, use its LAN URL. If Docker and
OpenCodez are on the same host, `http://host.docker.internal:4096` is usually the right URL.

The first allowed user who talks to the bot can bootstrap the Telegram chat when `allowChatBootstrap` is still enabled
in `config.local.json`. After the bot learns the chat id, keep the generated local config and state files; they are the
runtime state.

Run with Docker Compose:

```bash
mkdir -p state
docker compose up -d --build
docker compose logs -f opencodebot
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force state
docker compose up -d --build
docker compose logs -f opencodebot
```

For direct local usage, run `npm start`. Production/live operation should use Docker Compose.

## Update

Update the bot container first:

```bash
git pull
docker compose up -d --build opencodebot
npm run smoke:live
```

Use full `docker compose up -d --build` instead when the Compose file, Telegram Bot API sidecar, or other services
changed.

If the update changes `plugins/opencodebot-artifacts/` or `skills/telegram-artifact-send/`, refresh the OpenCodez plugin
and skill copies wherever OpenCodez loads them. Copy the whole skill directory, including `agents/openai.yaml`; that
file carries short trigger metadata for the agent. Restart each OpenCodez service after updating plugin or skill files,
because running agents may not reload plugin code or skill metadata until the service restarts.

In Politia, use `/home/bloob/politia/services/harness/opencodez/deploy.sh` for that OpenCodez rollout. If you are
running the update from `nuc`, restart the local OpenCodez service last and deferred so the current agent session is not
interrupted early.

Your `config.local.json`, `servers.json`, `token.env`, and `state/` directory stay local and are not overwritten by
updates.

The artifact gateway and OpenCodez plugin are optional. Start without them first unless you specifically want agents to
send files, screenshots, logs, or text to a Telegram artifacts topic. Enable that later with
[Artifact Gateway](docs/artifact-gateway.md).

The speech transcription module is optional. Enable it with `speech.enabled=true` and `OPENROUTER_API_KEY` in
`token.env`. Voice messages in ordinary non-artifact topics are then transcribed as replies without being sent to
OpenCodez; copy the transcript and send it as text when it should become a prompt. Run `/sounds_here` when you also want
a dedicated voice/audio inbox with a pinned model menu. The module uses OpenRouter's `openai/whisper-large-v3-turbo` by
default and can switch between configured OpenRouter transcription models, so no separate speech service is required.

The local Telegram Bot API sidecar is also optional. Add `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` to `token.env`, set
`telegram.botApi.mode` to `local`, start Compose with the `telegram-local` profile, then run
`docker compose exec -T opencodebot npm run telegram-local -- doctor`. Details are in [Docker](docs/docker.md) and
[Config And Runtime](docs/config-runtime.md).

## Commands

Use `/start` or `/help` when you want the bot to show its command summary. These commands are safe to run in a normal
topic, and they do not create or change an OpenCodez session.

Use `/new` when you want a fresh Telegram topic and a new OpenCodez session. You can give it a server id, an optional
chat profile, an optional `dir:<path>` override, and a title. If no server id is given, the configured default server is
used. After the topic is created, send the first prompt in that topic.

Use `/q` inside an existing OpenCodez topic when you want to queue another prompt for the same session. A queued prompt
is released only after OpenCodez is idle and the preceding terminal assistant answer has been mirrored to Telegram.
`/q status` shows the queue, and `/q delete 2` removes a queued item by number.

If a run becomes idle without producing a terminal assistant answer or an explicit OpenCodez error, the bot verifies the
latest user turn against freshly fetched OpenCodez message history and posts a clear interrupted-run warning with an
`Open session` button. A terminal `finish=stop` counts as success only when the assistant produced visible final text;
an empty stop gets the more precise `OpenCodez stopped without a final response` warning. User-message events activate
tracking early, while idle checks and recent periodic reconciliation recover when a lifecycle event was absent or
missed. Periodic incomplete snapshots use the same short grace and fresh-history check as idle events, so a final
`finish=stop` update cannot race with a warning based on an older snapshot. A small durable handling ledger prevents
duplicate warnings across repeated idle events and restarts. The warning is treated as the terminal notice for queue
ordering, so queued work can continue instead of waiting forever.

Configured `finalNotifications.userIds` also receive private operational alerts for explicit OpenCodez run errors,
failed assistant steps, and unexpected interrupted/empty-terminal runs. These critical alerts ignore the per-user
`/notify_off` final-answer toggle, contain no prompt or answer text, and link back to the Telegram topic and OpenCodez
session. Expected `/kill`, queue interruption, rewind/reset, and normal compaction stops remain silent. A separate
bounded durable marker keyed by recipient and run prevents a step failure, following `session.error`, and later
interruption reconciliation from producing duplicate DMs.

Explicit OpenCodez session errors are rendered with their normalized type, provider message, and status code when
available, for example `API error (429)` plus the provider's rate-limit explanation. The bot reads the structured event
payload first and falls back to the latest assistant error in session history when the event carries no detail. Known
errors without messages receive concise guidance, including `/compact` for context overflow. Error output is
length-bounded and deliberately excludes raw response bodies, headers, metadata, and other nested provider data.

Use `/kill` inside an existing OpenCodez topic when you want to stop the current run. It sends OpenCodez's session abort
request and clears that topic's queued prompts, but it does not delete the session or the Telegram topic.

Use `/compact` inside an idle OpenCodez topic to condense that session's context with OpenCodez's native summarize
endpoint. The bot resolves the session's current provider/model, immediately shows a `Compacting context…` status, and
performs the potentially long operation in the background. Prompts sent after compaction starts wait in the existing
topic queue. The internal compaction summary is not mirrored as an assistant answer; the status is edited to a concise
success or failure result, and the session remains available either way. The running guard uses authoritative live
OpenCodez `sessionStatus`; a stale in-memory queue busy flag cannot keep `/compact` blocked after the backend is idle. A
genuinely busy backend or an already active compaction still returns concise wait/`/kill` guidance.

Use `/context`, `/context N`, or `/set_context N` to export the latest main-session user turns from the current topic.
The personal default is three turns and the supported range is 1–10. A completed turn contains the user prompt and its
final `finish=stop` answer. An interrupted turn still occupies one of `N` slots and contains `### User — interrupted`,
the original prompt, and every visible assistant progress note accumulated before interruption. Progress notes are
labeled separately and never presented as a final answer; reasoning, tool payloads and step metadata remain excluded.
The active unfinished turn remains omitted. Subagent sessions and synthetic prompts are excluded, while user attachment
descriptors are preserved. Output is one or more collapsed Rich Messages containing an escaped code block, split without
truncation below the safe Rich Message limit and capped at 240,000 characters. Expanding the block exposes Telegram's
native code-copy affordance. Context text is never stored in bot state and a Rich Message failure produces only a short
error, never a large plain-text fallback.

Use `/reset [profile] [server]` when the Telegram thread should stay but its OpenCodez context should start over.
Omitted values inherit the current profile/server; one argument may select either, while two arguments are profile then
server. Same-server reset preserves the exact directory. Cross-server reset validates and preflights the target before
aborting the old run, then uses that server's configured default directory. The bot clears queued or partially buffered
input, atomically disables the old binding, updates the managed topic suffix when needed, and leaves the same topic
waiting for its first prompt. The old session remains preserved on its original server. Running `/reset` again while
pending safely updates the waiting profile/server without creating or aborting a session. Reset is rejected in
`#General`, artifacts, sounds, or otherwise unbound topics.

To replace an earlier turn, reply to that Telegram user prompt with the corrected text, attachments, or both. One short
service message is edited from `🟡 Reverting…` to `🟢 Reverted` after the replacement prompt is accepted; it never emits
the ordinary `Accepted by OpenCodez` message for this flow. The rewind status stays visible through mirrored OpenCodez
output and is cleared only when the next regular prompt, another rewind, or a topic reset supersedes it. The bot stops
an active run if necessary, discards later queued input, asks OpenCodez to rewind at that exact user message, then sends
the reply as the replacement prompt. It only does this when the replied message belongs to the active OpenCodez session
for the same topic. Replies to a prompt from before `/reset`, a different topic, or an already undone branch are
rejected without sending anything to the current session. The reply-to-rewind association is durable across bot
restarts, but it is available only for prompts sent after this feature was deployed.

Use `/session` inside a topic when you want to see what Telegram topic is bound to which OpenCodez server/session. It
also shows the web session URL, a pending reset waiting for its first prompt, and whether the current topic is the
artifacts target.

Use `/artifacts_here` inside a forum topic when you want that topic to become the single Telegram target for agent-sent
artifacts. After that, `opencodebot_send_artifact` sends files, screenshots, logs, or text to that topic. Files dropped
by a user in the same topic are saved under `artifactUploads.root` on the default server, or on the server named by the
first caption word. Optional comma-separated names after the server rename uploaded files in order; names without an
extension inherit the source file's complete extension, including compound extensions such as `.tar.gz`. Docker
deployments must also mount that local artifact root; see
[Artifact Gateway](docs/artifact-gateway.md#user-dropped-files) and [Docker](docs/docker.md#artifact-dropbox-paths).

With speech enabled, a Telegram voice message in any ordinary non-artifact topic is transcribed through OpenRouter and
answered as a reply to that voice message. The transcript is never submitted to OpenCodez automatically and never enters
the attachment buffer; copy it and send it as text to use it as a prompt. General audio files keep the normal attachment
behavior.

Use `/sounds_here` inside a forum topic when you also want that topic to become the dedicated voice/audio transcription
inbox. The command creates or refreshes a pinned model menu with buttons for configured transcription models and a
`Refresh` button for config changes. Voice messages, general audio files, and supported audio documents in that topic
are transcribed, while ordinary text is kept out of the prompt flow. Only the transcript is formatted as Telegram Mono
text, with service metadata left outside that formatting. The OpenRouter language hint defaults to `ru`, can be changed
to another ISO-639-1 code, or can be set to `null` / `"auto"` for auto-detect. `/sounds_off` clears only the dedicated
inbox binding; voice messages in ordinary topics continue to be transcribed. `/sounds_status` shows whether speech is
enabled, configured, selected model, dedicated topic, and busy.

Use `/notify_on`, `/notify_off`, and `/notify_status` to manage private final-answer notifications for the configured
recipients. Delivery is deduplicated per recipient and final assistant message. A final DM is sent only after the bot
has mirrored a new final answer into Telegram and received its exact `message_id`; restart reconciliation never
backfills DMs for already mirrored historical answers. Catch-up may still mirror a genuinely missing final answer, which
then follows the ordinary notification path with a valid message link. Legacy sent markers remain recognized during
migration. Those DMs include the source topic, an `Open topic` button, context quotes, a completed task list when the
agent closed one, and a separate quoted `Tools`/`Patched` summary with compact tool counts and semicolon-separated file
names for successful structured file mutations. `/debug_on`, `/debug_off`, and `/debug_status` additionally control one
global expandable run-diagnostics block at the very end of every final DM, including agent-step latency, effective TPS,
tool timing/failures, and slowest tools.

Use `/mode`, `/mode full`, or `/mode economy` to inspect or change the persistent global mirror mode. Both modes keep
short subagent spawn notices. Full mode keeps normal compact tool reporting. Economy mode still mirrors each unique
assistant progress note, final answer, and run failure once, but suppresses ordinary tool Telegram messages across all
topics.

Use `/mirror_on` and `/mirror_off` when you need to pause or resume web-to-Telegram mirroring without stopping the bot.

Default chat profiles are `d4flash`, `d4pro`, `luna`, `terra`, `solm`, `solh`, `sol`, and `solmax`. Each profile keeps
its agent, model, variant, and OpenCodez System prompt in `chatTemplates`; local deployments can override those values
in runtime config without changing code. DeepSeek profiles use the OpenCodez `default` System prompt, Luna and Terra
share `codex_gpt_5_6_luna_terra`, and all four Sol profiles use `codex_gpt_5_6_sol`. They select the same Sol model with
`medium`, `high`, `xhigh`, and `max` variants respectively.

`/reset [profile] [server]` may change profile, server, or both while preserving the current value when omitted.
Same-server reset preserves the current directory; cross-server reset checks the target first and uses its configured
default directory. Multi-server deployments add a managed `(<serverID>)` suffix to Telegram topic titles, while
single-server deployments keep plain names.

## Docs

- [Telegram Workflow](docs/telegram-workflow.md) covers topics, `/new`, `/reset`, `/q`, `/kill`, attachments, multipart
  prompts, rich messages, tools, user-prompt pins, final notifications, and reconcile.
- [Config And Runtime](docs/config-runtime.md) covers config loading, token handling, chat profiles, mirror settings,
  attachments, and state.
- [Artifact Gateway](docs/artifact-gateway.md) covers `/artifacts_here`, the LAN gateway, user-dropped artifact uploads,
  the OpenCodez plugin, and the bundled skill.
- [Docker](docs/docker.md) covers the recommended Compose deployment path.
- [Development](docs/development.md) covers source layout, checks, smoke tests, service restart, and change style.
- [WireGuard](docs/wireguard.md) covers the optional private access helper and what it does not own.

## Checks

```bash
npm run check
npm run smoke
npm run smoke:live
```

`npm run check` syntax-checks source and scripts. `npm run smoke` is the central contract smoke for production-sensitive
regressions; avoid adding scattered test files for ordinary changes. `npm run smoke:live` runs the same lightweight
health check inside the live Compose service against `/app/config.local.json`. Neither smoke path should print tokens or
send prompts.

## License

MIT
