# Telegram Workflow

Telegram is the companion surface, not a second OpenCodez backend. The bot binds Telegram forum topics to OpenCodez sessions, sends prompts through the normal OpenCodez API, and mirrors visible progress from OpenCodez events and history. If OpenCodez says something happened, Telegram can show it; if a browser dropdown changed but no prompt was sent, the bot does not invent that local browser state.

The useful shape is deliberately narrow. A topic is a working thread with at most one active session binding, `/new` creates a session-backed topic, `/reset` starts fresh without replacing the Telegram topic, `/q` keeps the next prompt ready while a run is busy, `/kill` stops the current run, attachments travel with the prompt text, and optional speech transcription turns voice messages into copyable drafts without creating OpenCodez prompts. The mirror should feel like the visible web UI in Telegram, not like raw backend JSON.

## Topics

The bot expects a forum-enabled Telegram chat when topic creation is used. A topic can be created from Telegram with `/new`, or autocreated for web-created OpenCodez sessions discovered through events or bounded reconcile.

Deleting or closing a Telegram topic is treated as an explicit stop for that topic's mirror binding. The bot disables the binding and must not continue mirroring that session into `#General` or any other fallback topic.

If `telegram.chatId` is missing and `telegram.allowChatBootstrap` is enabled, the first message from an allowed user initializes the chat in local state. For a shared bot, set `telegram.chatId` and `telegram.allowedUserIds` deliberately instead of relying on accidental bootstrap messages.

When OpenCodez later updates a session title, the linked Telegram topic is renamed too unless the topic title came directly from the user. This lets placeholder titles such as a profile name become real session titles, while `/new local sol Refactor auth` keeps `Refactor auth`. `/reset` always promotes the reused topic's current visible title to user-owned, even when the old binding was previously session-owned, so the new session cannot rename an established thread. New topics use a random forum icon when Telegram exposes available topic icon stickers to the bot.

## Commands

```text
/new [server] [profile] [dir:<path>] [title]   create a topic and wait for the first prompt
/reset [profile]                   preserve the old session and start fresh, optionally with another profile
/session                           show topic, binding, session URL, and special topic status
/q <prompt>                       queue or send a prompt in this topic/session
/q status                         show queued prompts
/q delete <number>                remove a queued prompt by status number
/kill                             stop the current run and clear queued prompts
/artifacts_here                   make this topic the artifact target and file dropbox
/sounds_here                      use this topic as the dedicated speech inbox
/sounds_off                       disable the dedicated speech inbox
/sounds_status                    show speech transcription status
/notify_on                       enable final-answer DMs for configured recipients
/notify_off                      disable final-answer DMs for configured recipients
/notify_status                   show configured final-answer DM status
/mode [full|economy]             show or set the global mirror mode
/mirror_on                        enable web-to-Telegram mirroring
/mirror_off                       disable web-to-Telegram mirroring
/help                             show commands and configured chat profiles
```

The bot syncs this slash-command menu on startup through Bot API `setMyCommands` for default, private-chat, group-chat, administrator, configured-chat, and configured-member scopes, so the same commands should appear in Telegram's command suggestions.

`/artifacts_here` marks the current forum topic as the only artifact target for agent uploads. If another topic later runs `/artifacts_here`, the new topic replaces the old one. Artifact topics do not mirror OpenCodez sessions. Ordinary text there is ignored as a prompt, while user-dropped files are saved to the configured artifact upload folder. See [Artifact Gateway](artifact-gateway.md) for plugin, gateway, and file dropbox setup.

When `speech.enabled` is configured, a Telegram voice message in any ordinary non-artifact topic is downloaded and transcribed through the selected OpenRouter or direct Groq model. The bot replies directly to the voice message with only the transcript in Telegram Mono formatting and service metadata outside that formatting. This route stops before question handling, attachment buffering, and prompt dispatch: the user must copy the transcript and send it as a text message before OpenCodez receives it. General audio files keep the normal attachment behavior.

`/sounds_here` additionally marks the current forum topic as the dedicated voice/audio transcription inbox. If another topic later runs `/sounds_here`, the new topic replaces the old one. The command creates and pins a model menu with one button per available transcription model and a `Refresh` button that redraws the menu after config changes. Each button names the API provider, so an OpenRouter-routed Whisper model is distinct from direct Groq Whisper. Models whose provider key is missing stay out of the menu without disabling models from another configured provider. Dedicated speech topics do not mirror OpenCodez sessions: ordinary text is kept out of the prompt flow, while voice messages, general audio files, and supported audio documents are transcribed. `/sounds_off` clears only the dedicated inbox binding; ordinary-topic voice transcription remains active. `/sounds_status` shows provider readiness, the selected model, dedicated topic, and queue activity.

`/session` is a small operator command for the current topic. It shows Telegram chat/topic/message ids, the active or last stored binding, OpenCodez server/session details, a web session URL when the backend session can be read, and artifact/sounds target status. Between `/reset` and the next prompt it reports that the topic is pending, shows the selected pending profile, and identifies the preserved previous session. It works in normal mirror topics and special topics, and it does not print secrets or runtime tokens.

`/kill` is a topic-scoped stop command. It calls OpenCodez `POST /session/:sessionID/abort` for the bound session, then clears that topic's in-memory queued prompts so a stopped run does not immediately advance into the next queued prompt. It does not delete the OpenCodez session, remove the Telegram topic, or restart the backend service.

`/reset [profile]` is a topic-scoped context reset. With no profile argument, it preserves the current binding's chat profile; a configured profile such as `/reset sol` or `/reset terra` replaces only the pending session's model, agent, variant, and OpenCodez System selection while retaining the current server and directory. Unknown, retired, or extra profile arguments are rejected before any abort or state change. The command then applies the same backend abort boundary as `/kill`; if abort fails, the active binding is left in place. On success the bot clears queued prompts, an unfinished multipart prompt, and buffered attachments, then atomically disables the old binding and records the same topic as pending. The transition preserves the current visible topic title and marks its title source as user-owned. The previous OpenCodez session remains available in OpenCodez, while its delayed reconcile and run-watchdog work can no longer write into the reused topic. The next normal prompt lazily creates and binds a new session with the selected profile plus the previous server, directory, topic title, and icon metadata, but later OpenCodez title updates are ignored for Telegram topic renaming. At startup, legacy pending and active bindings whose topic history already contains `disabledReason=topic-reset` are migrated to the same user-owned title policy.

Running `/reset` again while the topic is pending is safe: it discards any newly buffered multipart prompt or attachments, applies a supplied profile override to the pending session, and reports that the first prompt is still expected. It does not abort or create another session in this state. The command is rejected in `#General`, the artifacts topic, the sounds topic, and a manually created topic that has no active or pending binding. This keeps special-topic routing and accidental command taps from changing the topic's purpose.

`/new` parses arguments from left to right. If the first argument matches a configured server id, that server is used. If the next argument, or the first argument when no server was given, matches a profile in `chatTemplates`, that profile is used. A `dir:<path>` argument sets the OpenCodez session directory for this topic; otherwise `/new` uses the selected server's configured home directory. Everything left becomes the user-owned topic title.

Examples:

```text
/new TGBOT
/new ser Release check
/new d4flash Fix upload flow
/new local sol Architecture pass
/new local terra dir:/srv/opencodebot Artifact gateway
/new dima d4flash dir:"C:\Users\dima\code\voltaren" voltaren
/reset
/reset sol
/reset terra
```

The default profiles are `d4flash`, `d4pro`, `luna`, `terra`, and `sol`. They are host-independent Telegram-created-session profiles. Each keeps its agent, model, variant, and OpenCodez System prompt in config. The bot selects that System after creating the session and before sending the first prompt. The retired `gpt55p` profile is rejected with a direct migration hint instead of being misread as a topic title.

## Prompts

For an existing topic, the bot sends prompts with the session's current `agent`, `model`, and `variant`, or the last user-message metadata when available. Last sent settings win. For a new topic created from Telegram, the bot uses the runtime default profile unless a configured chat profile overrides it.

Long Telegram-origin prompts can arrive as multiple Telegram messages. Near-limit prompt parts are held briefly in memory and joined with a blank line before being sent to OpenCodez. Ordinary short messages are sent immediately.

After a Telegram prompt is handed to OpenCodez, the bot sends a short acknowledgement in the same topic. If the topic is not bound, the backend rejects the prompt, or OpenCodez later emits a session error, the bot reports that in Telegram instead of dropping the message silently.

Telegram-origin prompts can include attachments. The bot downloads supported files into its local staging uploads directory. Small files are sent to OpenCodez as data URL file parts next to the prompt text. Larger accepted files are copied to the selected server's configured `uploadRoot`, and the prompt receives that server-local path. Files with captions flush as one prompt after media groups settle. Files without captions wait for plain text from the same user/topic; if Telegram splits that text into near-limit chunks, those chunks are collected until the short attachment-text idle window settles and then sent with the files as one prompt.

### Reply-to-rewind

Reply to an earlier Telegram **user prompt** in an active bound topic to replace that turn. The reply may contain text, attachments, or both. The bot stores a compact durable link from the Telegram message id to the exact OpenCodez user-message id; it does not retain prompt text or attachment contents for this feature, and the link survives a bot restart.

For a valid reply, one service message progresses from `🟡 Reverting…` to `🟢 Reverted`; the normal `Accepted by OpenCodez` service message is not emitted for this flow. The rewind status is sticky through mirrored OpenCodez user and assistant output, then is cleared only when the next ordinary prompt, another rewind, or a topic reset supersedes it. The bot discards later queued prompts, aborts an active run when necessary, waits for the OpenCodez session to become idle, calls OpenCodez's session-revert API at the replied user message, and sends the reply as the replacement prompt. OpenCodez restores the saved working-tree state and removes the reverted branch as it accepts that replacement prompt. If the revert itself fails, the message becomes `🔴 Revert failed`; if the revert succeeds but its replacement prompt cannot be sent, it becomes `🟠 Reverted · replacement not sent`.

The guard is intentionally strict: the replied prompt must belong to the same active `(server, session, Telegram topic)` binding. A reply to a prompt from before `/reset`, another topic, a closed session, or a branch already rewound is rejected and is never silently sent to the current session. A reply to an unrelated Telegram message keeps normal prompt behavior. Prompts created before this feature was deployed have no durable Telegram-to-OpenCodez link and therefore cannot trigger a rewind.

OpenCodez is the sole owner of message ids. Telegram prompts are submitted
without a client-generated id. The bot keeps a short pending marker and records
the reply-to-rewind origin only after `session.next.prompted` reports the
canonical OpenCodez user-message id; full reconcile provides the same fallback
when the live event was missed. Client ids such as `msg_tg_*` must never be
introduced because OpenCodez relies on ordered ids for prompt-loop termination
and Web UI message grouping.

```text
dima upload root: /home/dima/.opencodebot/uploads
```

Supported attachment inputs include documents, photos, videos, animations, audio, voice messages, video notes, and media groups. File count, file size, total size, and cleanup limits are conservative runtime settings. Cloud Bot API mode clamps download size to Telegram's cloud limit; local Bot API mode can accept larger files when configured.

## Queue

`/q <prompt>` sends immediately when the bound OpenCodez session is idle. If the session is busy, the prompt is kept in memory for that session. The same rule applies to a file or media group whose caption starts with `/q`: the prompt text and downloaded attachments stay together in the queue and are sent as one prompt after the current run finishes.

The queue advances only after both conditions are true: OpenCodez reports the session idle, and the terminal assistant answer from that run has been mirrored to Telegram. The signals may arrive in either order. On an idle event the bot reconciles OpenCodez history before releasing the queue, so a missed or delayed terminal SSE event cannot cause the next prompt to overtake the final answer. Duplicate idle events are idempotent and cannot release multiple prompts. If OpenCodez reports a terminal run failure, the bot announces the failure, clears queued prompts for that session, and lists the cleared items by number plus the same first-words summary used by `/q status`. A service restart drops queued prompts instead of writing full user prompts into `state.json`.

The bot also tracks runs it observed starting. If such a run becomes idle without a `finish=stop` assistant or an explicit error, it waits briefly, checks OpenCodez status and message history, then posts `OpenCodez run ended without a final answer`. This fallback is in-memory, is not triggered for idle sessions merely discovered during startup or reconnect, and counts as the terminal notice that allows `/q` to continue.

## Questions

OpenCodez `question.asked` events are mirrored into the bound Telegram topic. A request containing one single-choice question gets one button per option. Clicking an option replies through the OpenCodez question API, removes the keyboard, and edits the same Telegram message to show the selected answer. If the question is answered or rejected in OpenCodez first, `question.replied` or `question.rejected` updates the Telegram message instead.

Requests with multiple questions or multi-select answers are shown without answer buttons and direct the operator to OpenCodez. For a single question that allows a custom answer, the operator can reply directly to the Telegram question message with ordinary text. The bot sends that reply through the OpenCodez question API, edits the original question message, and does not mirror the reply as a new session prompt.

Every configured final-notification recipient receives a separate direct message with a button linking to the topic question. Question alerts are blocking-work notices, so they use the configured recipient list even when final-answer notifications were toggled off with `/notify_off`.

Minimal question/message bindings are kept in `state.json`. On startup the bot lists pending questions for each bound OpenCodez working directory, recreates questions that do not yet have a saved Telegram message, and closes stale keyboards. A pending question suppresses the incomplete-run watchdog and never counts as a terminal queue signal.

`/kill` also clears the queue for the current topic after sending the OpenCodez abort request, and it discards any pending multipart prompt buffer instead of flushing that text as a new prompt. This keeps the command's meaning simple: stop the active run and do not launch another queued prompt automatically.

## Final Notifications

`/notify_on`, `/notify_off`, and `/notify_status` control private DM notifications for `finalNotifications.userIds`. When enabled, the bot sends a short private message to each configured recipient when a final mirrored answer is ready. The DM includes a source `Topic:` line from Telegram topic metadata, with the Telegram topic name and topic custom emoji when Telegram provides it. It also includes an `Open topic` button for the final mirrored message, quotes the original user prompt in an expandable block for orientation, and includes a compact quoted `📋 Tasks [n/n]:` checklist when the agent closed a todo list for that run. A separate quoted `Tools:` / `Patched:` block counts non-hidden tools in the current user turn and lists file names from successful `apply_patch`, `edit`, and `write` calls separated by semicolons. Task/subagent tools and configured hidden tools are omitted. Shell calls remain in `Tools`, but the bot does not guess changed paths from arbitrary shell command text. The DM does not include the final answer text.

## Mirror

Web-origin text prompts are mirrored into Telegram with a small `💬` marker. Oversized web prompts are split into numbered Telegram messages instead of being truncated, so the topic keeps the full prompt text in order. Telegram-origin prompts are suppressed when the bot can match them to its own pending send. Consuming that pending marker also binds the canonical OpenCodez message id to the original Telegram message for reply-to-rewind.

Assistant text is accumulated until OpenCodez completes the text block. The bot does not edit Telegram token-by-token. Each completed assistant progress note is mirrored once using its OpenCodez message id as the durable dedupe key. Completed/final assistant text is sent as Telegram Rich Message markdown when the Bot API accepts it, with fallback for local Markdown links and formatting errors. Real final answers are identified by `finish=stop` and marked with `🏁 `. The bot pins the user prompt that started the run: the original Telegram message for Telegram-origin prompts, or the mirrored user message for web-origin prompts.

Telegram Rich Message currently loses the parent list level after a nested Markdown or HTML list: a following top-level item is rendered as another child, and each later nested list can push subsequent siblings deeper. Before sending rich markdown, the bot parses CommonMark into mdast. A list block that actually contains another list is rendered as parser-neutral visual lines with hard breaks, guarded ordered markers, literal bullets, and fixed visual indentation; inline emphasis, code, and links remain Markdown. Simple one-level lists and text that only looks like a list inside fenced code are left unchanged. Parsing or normalization failure is fail-open and keeps the original rich-message/fallback path.

`/mode full` and `/mode economy` switch one persistent global mode for all mirrored topics; `/mode` reports the current value. Both modes emit one short `🤖 Subagent spawned` notice when a task/subagent is started. The notice uses the web-visible task title when OpenCodez provides it, falling back to the subagent type only when there is no title. Full mode keeps normal tool rendering. Economy mode mirrors assistant progress text, final answers, and failures, but suppresses ordinary Telegram tool sends and edits. OpenCodez execution and final-notification tool accounting are unchanged in both modes.

In full mode, tool calls are compact and expandable. Adjacent tool results update one Telegram message until assistant text starts a new block. Tool batches use Telegram MarkdownV2 expandable blockquotes, so details are one tap away without filling the topic with raw output.

Internal helper tools such as todo-style task-list tools are suppressed from live mirror and reconcile so bookkeeping does not crowd Telegram. Closed task lists may still appear in private final-answer DMs as a compact quoted checked task list. Task/subagent result logs and child-session activity are implementation details and stay hidden; both mirror modes only announce the spawn event with the web-visible task title.

## Reconcile

Live `/event` SSE is the primary path. Reconcile is a narrow fallback for the current or very recent run, not a historical backfill of every bound session. A Telegram prompt, a freshly autocreated web topic, or a live web prompt opens a bounded reconcile window for that binding. Within that window, reconcile may recover missed user/assistant messages and especially the final answer. Topic autocreation is single-flight per OpenCodez server/session across SSE and the session-list reconcile path; the session becomes seen only after its Telegram binding is stored, so a transient topic-creation failure remains retryable. Binding reconciliation uses the same per-session coordination, and delayed reconcile requests are debounced, so concurrent periodic and event-driven recovery attempts are coalesced instead of duplicating mirror output. If an already-bound web session is updated after its reconcile window expired, the session-list pass reopens a fresh user-prompt catch-up window so missed web prompts still reach Telegram. Old assistant/tool backlog before the recovered user prompt is marked processed instead of being replayed into the topic; assistant output after the recovered prompt mirrors normally. Outside recent activity, old topics stay quiet.

The lower bound is stored on the binding as `reconcileAfter`, and the expiry as `reconcileUntil`. The lookback, active window, and interval are fixed conservative defaults. Mirrored message markers are tracked per session so a busy session cannot evict markers for another one and cause phantom replays.

Backend hosts may be off. Event streams and reconcile API calls use exponential backoff up to two minutes with rate-limited offline logs and recovery logs, so a powered-off server does not spam the service journal.
