# Telegram workflow

[English](telegram-workflow.md) · [Русский](../ru/telegram-workflow.md) · [All languages](../README.md)

Use General to create topics, choose profiles and change settings. Use a working topic to talk to the agent. Each topic follows one active OpenCodez session; the session and its history remain in OpenCodez.

## Topics

`/new` opens a personal wizard. It shows a concrete profile, provider/model, reasoning, server and directory before creation. The default title is a random bundled Old Russian noun; **Another word**, **Title** and **Settings → Random topic names** control naming. The first ordinary prompt creates the backend session. The launch snapshot stays the one shown at creation, even if its named profile changes before that prompt.

With several servers, titles get a managed ` (<serverID>)` suffix. User-chosen/random names survive backend title changes. A manual Telegram rename becomes topic-owned and updates retained history too. `/reset` preserves that title while changing only the server suffix when needed. Single-server titles have no suffix. Icons are random when Telegram supplies available stickers.

Close or delete a topic to stop its mirror. This clears queued prompts, scheduled recovery and pending launch while preserving the backend session and disabled binding history. Use `/kill` first if backend execution should stop too. Recent topics detects deletions using a silent operator-only ephemeral probe, immediately deleted; it does not reapply a saved title. Telegram has no topic-list/read method or deletion update. Network/permission/rate-limit errors preserve the binding. Each explicit opening checks at most 18 candidates, stopping when six available topics are found; another Refresh continues cleanup when many old topics disappeared.

Internal child sessions and exact normalized `opencode-see delegate` sessions do not become working topics. Their old bot records are removed without deleting Telegram topics.

## Commands

Common actions appear in Telegram's slash menu. Setup and advanced commands still work when typed. Bot API has no per-topic command-menu scope.

| Command | Action |
| --- | --- |
| `/menu` | Move the pinned General panel to a fresh message |
| `/new` | Open topic creation |
| `/new [server] [profile] [dir:<path>] [title]` | Create directly; session starts on the first prompt |
| `/session` | Server, copyable session ID, status, saved launch settings and separate file/audio destinations |
| `/q <prompt>`, `/q status`, `/q delete N` | Queue work, inspect it or remove an item |
| `/kill` | Abort this session and discard its queued/multipart prompts |
| `/compact` | Condense an existing idle session using native OpenCodez compaction |
| `/reset [profile] [server]` | Start fresh in the same topic and preserve the old session |
| `/context [N]`, `/set_context N` | Export recent turns; save a personal default, 1–10 |
| `/reminder [on\|off]` | Show/change automatic prompt reminders after compaction |
| `/speak` | Reply to text for one spoken summary |
| `/help`, `/start`, `/setup` | Guide, General or connection setup |

Advanced shortcuts include `/mode full|economy`, `/mirror_on`, `/mirror_off`, `/lang eng|ru`, `/notify_on`, `/notify_off`, `/notify_status`, `/debug_on`, `/debug_off`, `/debug_status`, `/update`, `/artifacts_here`, `/sounds_here`, `/sounds_off`, `/sounds_status` and `/tts`. Their normal controls live in General; [voice](final-voice.md) and [updates](self-update.md) have dedicated references.

### Direct creation and reset

`/new` parses server first, then profile, then optional `dir:`/`directory:` and title. Unknown tokens remain title text; a typo does not select another server/profile. To name a topic after a configured name, specify server and profile first. Quote a whole path argument with spaces.

```text
/new Review uploads
/new workstation Release check
/new sol Fix parser
/new workstation sol Review uploads
/new workstation sol "dir:/workspace/My Project" Review uploads
/new workstation sol sol
/reset
/reset solm
/reset workstation
/reset solx workstation
```

With no reset arguments, profile/server/directory are inherited. An existing named profile is resolved from current preferences; a deleted one falls back to the retained topic snapshot. One argument selects a profile or server; two mean profile then server. Ambiguous, unknown or extra arguments are rejected before abort or state changes. Same-server reset keeps the directory; a different server gets its own default directory after preflight. Abort failure preserves the active binding. A successful reset atomically disables the old binding and records a pending launch. Repeating reset while pending creates no extra session. General, FILES, AUDIO and unbound manual topics cannot be reset.

`/session` distinguishes active, pending, disabled, deleted and unavailable sessions. Pending launches have no new ID; the previous ID appears in details only. Service topics show their purpose without obsolete agent settings. Unknown destination names remain explicitly unknown. Backend reads run concurrently with five-second limits, so an offline server does not freeze the command.

## Prompts

Send ordinary text in a working topic. Near-limit multipart text is briefly collected into one prompt. Files with captions travel with that text; captionless files wait for text from the same actor/topic. Rich Messages preserve readable text and supported photos through the same route. File counts/sizes are checked before download and against the actual remaining batch budget.

Acceptance appears as one short status message. From the third provider retry it becomes one editable warning; output/idle removes it. A rejected prompt receives a concise error. If the backend session was deleted, the topic becomes pending and asks for a resend; no replacement prompt is silently issued. OpenCodez always generates message IDs.

### Reply-to-rewind

Reply to an earlier Telegram user prompt to replace its exact OpenCodez turn. The stored origin link must belong to the same active session/topic and unreplaced branch. Replies to old pre-reset prompts or another topic are rejected; unrelated replies remain ordinary prompts. Prompts predating durable origin links cannot rewind.

The bot discards later queue items, aborts if needed, waits for idle, and asks OpenCodez to revert. It requires the returned session and user-message ID to confirm the exact target before changing origin links or sending replacement text/files. One status message moves from Reverting to Reverted, or explains that confirmation/replacement failed. Rewind uses OpenCodez's own working-tree and history restoration.

## Queue

`/q` checks backend status when admitted. Idle work starts immediately; busy work waits in memory with its files. Release requires backend idle plus a delivered terminal answer/notice, in either order. History recovery supplies missing final/idle signals. Questions and in-flight manual compaction hold the queue. A failed run clears pending items and lists their summaries; duplicate events cannot release two prompts.

Limits are 20 waiting prompts per session, 100 overall and 64 MiB of text/inline content. Full queues reject with an explicit resend notice; `/q delete N` makes room. Kill, reset, closure/deletion and conversion to FILES/AUDIO discard the whole topic's multipart/attachment buffers, including other operators' pending input. A restart drops queues and downstream buffers. It does not delete backend history. [Storage guarantees](config-runtime.md#paths-and-state) explain why durable input receipt is a different boundary.

## Compaction and context

If a backend restart or lost event leaves a run idle without a final answer, the bot posts an interruption warning in its working topic. Reconnection and the existing one-minute watchdog cover that case without rescanning completed histories on every tick. The backend must be reachable to confirm the outcome. `/session` labels an idle backend **Not running**; this reports activity, while the task's result or interruption appears in the conversation.

`/compact` requires an idle existing session with history and a known model. It runs in the background and accepts later prompts into the queue. Kill/reset/rewind cancel the bot's in-flight operation. Completion posts one `🗜️ session compacted`; internal summaries remain private. The same marker appears for automatic or web-initiated compaction.

Reminders are initially on. Automatic compaction during active work rebuilds the original request and attachments from OpenCodez and adds an English `REMINDER:` asking the agent to preserve progress and later corrections. Admission must succeed before `🔁 Original prompt added as a reminder.` appears. When OpenCodez itself repeats the request, including after pre-turn compaction, the bot confirms the persisted replay and shows the same notice without submitting another copy. A completed summary alone does not prove that the request was repeated.

The repeated payload is not mirrored as another human prompt, and the notice is tracked to avoid repeating it during normal recovery or restart. Manual compaction, stopped runs and disabled topics receive no bot-injected reminder; an already confirmed server replay can still be acknowledged after the run finishes. Repeated compactions follow the original request rather than nesting reminders. Retained large-file paths must still exist.

`/context` exports three recent main-session turns, or the selected 1–10. Completed turns contain the original request and final answer. Interrupted or superseded turns contain the request and numbered visible progress notes; active unfinished turns are omitted. Compaction/replay/reminder records stay inside the original logical turn. Reasoning, tools and internal summaries are excluded.

Context arrives in collapsed Rich Message code blocks, fully escaped and split without truncation. The total ceiling is 240,000 characters, with chunks below 30,000 UTF-8 bytes. If later delivery fails, prior parts are removed best-effort and only a short error remains. **Collapsed content is readable by every group member**, not private storage. The bot persists only your numeric depth preference.

## Questions

A single-choice OpenCodez question has one button per option. A click answers through the backend, removes the keyboard and updates the same message. For custom answers, reply to the question message with text. Multi-question/multi-select requests link to OpenCodez. A question resolved in the web UI also closes its Telegram controls.

Pending questions are recovered by the existing 15-second reconcile loop and after SSE reconnect, sharing host backoff and per-request single-flight. They never count as a terminal queue signal. Blocking question alerts reach configured DM recipients even when their final-answer notifications are off.

## Final notifications

Open the private bot chat once. Final DMs are per-user and can be disabled; `/notify_on`, `/notify_off` and `/notify_status` affect only their caller. Blocking questions and run-failure alerts still arrive. A final DM is sent only after a concrete Telegram final-message ID exists, with recipient-specific durable dedupe. Historical restart catch-up does not backfill DMs.

The DM links to the exact answer and shows the current topic name/icon, logical-turn duration, actual model/reasoning, aggregate input/output/cache tokens, quoted original request, a completed task list when available, and compact tool/patched-file counts. It does not repeat the answer. Child-session usage is excluded. `/debug_on` adds global timing/TPS/tool diagnostics; `/debug_off` removes them. TPS measures end-to-end model-step throughput after known tool intervals, not peak streaming speed.

## Files and audio

FILES receives agent artifacts and saves user uploads on the selected server. Empty captions use the default server; `workstation first, backup` selects a server and renames files by position. Existing files are never silently replaced. [Artifact delivery](artifact-gateway.md#user-dropped-files) describes paths, extensions and setup.

Voice notes in ordinary non-FILES topics are transcript-only drafts when speech is enabled. AUDIO additionally accepts audio files/documents. Long transcripts are losslessly split into ordinary copyable Mono messages with metadata only after the last part. Send the transcript as text to give it to the agent. `/sounds_off` clears the dedicated topic, not ordinary-topic transcription. Spoken final answers are configured separately in [Final Voice](final-voice.md).

## Mirror

Economy is the initial mode: visible progress, final answers and failures, with ordinary tool output hidden. Full mode adds compact expandable tool status. Both hide reasoning, raw arguments, internal bookkeeping and child activity; both show a short subagent-spawn title. Completed text blocks are sent once, not edited per token. Rollback part-removal events delete stale progress best-effort.

Web prompts are literal escaped text: ordinary messages first, Rich Messages for longer input, splitting beyond 32,000 characters. A rich rejection falls back to complete ordinary chunks. Telegram-origin prompts are matched to canonical backend IDs and do not echo as web prompts. Local Markdown links/images become readable paths; HTTP images get one link-only retry if Telegram rejects photo content. Other formatting failures use ordinary text; transport failures propagate. Final `finish=stop` text gets `🏁`, and its originating user prompt is pinned.

## Telegram update isolation

Topic handlers keep input order while later Telegram batches continue arriving. Two handlers run per backend, with separate control, speech and upload groups. First-chat bootstrap stays serialized. Receipts are synced before `getUpdates(offset)` acknowledges them; completions retire individual events, including out of order across topics.

Failed actions with delivered feedback finish. Failures without delivered feedback retry in their own topic with 2.5–30-second backoff and release their group slot while waiting. The inbox pauses intake at 1,000 events or 16 MiB, allowing one final fetched batch across the byte threshold. Shutdown preserves unfinished events. A crash after a side effect but before completion can replay it; queues/media buffers have their separate restart limits.

## Reconcile

Missed events recover through bounded backend history, rather than an endless backfill. Root-session discovery spans the configured scope; startup seeds old sessions without posting history. Active cursors and lightweight unchanged-session checks limit reads. Reconnect catch-up considers recent bindings and queues, with five pages per binding. [Architecture](architecture.md#recovery-and-limits) documents coordination, deadlines and the remaining tradeoffs.
