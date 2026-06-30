# Telegram Workflow

Telegram is the companion surface, not a second OpenCodez backend. The bot binds Telegram forum topics to OpenCodez sessions, sends prompts through the normal OpenCodez API, and mirrors visible progress from OpenCodez events and history. If OpenCodez says something happened, Telegram can show it; if a browser dropdown changed but no prompt was sent, the bot does not invent that local browser state.

The useful shape is deliberately narrow. A topic is a working thread, `/new` creates a session-backed topic, `/q` keeps the next prompt ready while a run is busy, and attachments travel with the prompt text. The mirror should feel like the visible web UI in Telegram, not like raw backend JSON.

## Topics

The bot expects a forum-enabled Telegram chat when topic creation is used. A topic can be created from Telegram with `/new`, or autocreated for web-created OpenCodez sessions discovered through events or bounded reconcile.

Deleting or closing a Telegram topic is treated as an explicit stop for that topic's mirror binding. The bot disables the binding and must not continue mirroring that session into `#General` or any other fallback topic.

If `telegram.chatId` is missing and `telegram.allowChatBootstrap` is enabled, the first message from an allowed user initializes the chat in local state. For a shared bot, set `telegram.chatId` and `telegram.allowedUserIds` deliberately instead of relying on accidental bootstrap messages.

When OpenCodez later updates a session title, the linked Telegram topic is renamed too unless the topic title came directly from the user. This lets placeholder titles such as a template name become real session titles, while `/new nuc gpt55p Refactor auth` keeps `Refactor auth`. New topics use a random forum icon when Telegram exposes available topic icon stickers to the bot.

## Commands

```text
/new [server] [template] [dir:<path>] [title]  create a topic and wait for the first prompt
/session                           show topic, binding, session URL, and artifact target info
/q <prompt>                       queue or send a prompt in this topic/session
/q status                         show queued prompts
/q delete <number>                remove a queued prompt by status number
/artifacts_here                   make this topic the single agent artifact target
/notify_on                       enable final-answer DMs for configured recipients
/notify_off                      disable final-answer DMs for configured recipients
/notify_status                   show configured final-answer DM status
/mirror_on                        enable web-to-Telegram mirroring
/mirror_off                       disable web-to-Telegram mirroring
/help                             show commands and configured templates
```

The bot syncs this slash-command menu on startup through Bot API `setMyCommands` for default, private-chat, group-chat, administrator, configured-chat, and configured-member scopes, so the same commands should appear in Telegram's command suggestions.

`/artifacts_here` marks the current forum topic as the only artifact target for agent uploads. If another topic later runs `/artifacts_here`, the new topic replaces the old one. Artifact topics do not mirror OpenCodez sessions, and ordinary messages or attachments in them are not sent to OpenCodez. See [Artifact Gateway](artifact-gateway.md) for plugin and gateway setup.

`/session` is a small operator command for the current topic. It shows Telegram chat/topic/message ids, the active or last stored binding, OpenCodez server/session details, a web session URL when the backend session can be read, and artifact target status. It works in normal mirror topics and artifact topics, and it does not print secrets or runtime tokens.

`/new` parses arguments from left to right. If the first argument matches a configured server id, that server is used. If the next argument, or the first argument when no server was given, matches `chatTemplates`, that template is used. A `dir:<path>` argument sets the OpenCodez session directory for this topic; otherwise `/new` uses the selected server's configured home directory. Everything left becomes the user-owned topic title.

Examples:

```text
/new TGBOT
/new ser Release check
/new d4flash Fix upload flow
/new nuc gpt55p Architecture pass
/new nuc gpt55p dir:/home/bloob/politia/projects/tg/opencodebot Artifact gateway
/new dima d4flash dir:"C:\Users\dima\code\voltaren" voltaren
```

The default templates are `d4flash`, `d4pro`, and `gpt55p`. They are host-independent Telegram-created-session profiles. Each can set agent, model, variant, and an OpenCodez prompt template. The bot applies the OpenCodez template after creating the session and before sending the first prompt.

## Prompts

For an existing topic, the bot sends prompts with the session's current `agent`, `model`, and `variant`, or the last user-message metadata when available. Last sent settings win. For a new topic created from Telegram, the bot uses the runtime default profile unless a chat template overrides it.

Long Telegram-origin prompts can arrive as multiple Telegram messages. Near-limit prompt parts are held briefly in memory and joined with a blank line before being sent to OpenCodez. Ordinary short messages are sent immediately.

After a Telegram prompt is handed to OpenCodez, the bot sends a short acknowledgement in the same topic. If the topic is not bound, the backend rejects the prompt, or OpenCodez later emits a session error, the bot reports that in Telegram instead of dropping the message silently.

Telegram-origin prompts can include attachments. The bot downloads supported files into the configured uploads directory under Politia state, then sends them to OpenCodez as data URL file parts next to the prompt text so the backend can read media independently of the bot container filesystem. Files with captions flush as one prompt after media groups settle. Files without captions wait for the next plain text message from the same user/topic.

Supported attachment inputs include documents, photos, videos, animations, audio, voice messages, video notes, and media groups. File count, file size, total size, and cleanup limits are fixed conservative defaults in code.

## Queue

`/q <prompt>` sends immediately when the bound OpenCodez session is idle. If the session is busy, the prompt is kept in memory for that session.

The queue advances only after the same final-answer path used for `🏁`, where OpenCodez reports `finish === stop`. Progress notes, reconnects, and tool-only steps do not release the next queued prompt. If OpenCodez reports a terminal run failure, the bot announces the failure, clears queued prompts for that session, and lists the cleared items by number plus the same first-words summary used by `/q status`. A service restart drops queued prompts instead of writing full user prompts into `state.json`.

## Final Notifications

`/notify_on`, `/notify_off`, and `/notify_status` control private DM notifications for `finalNotifications.userIds`. When enabled, the bot sends a short private message to each configured recipient when a final mirrored answer is ready. The DM includes a source `Topic:` line from Telegram topic metadata, with the Telegram topic name and topic custom emoji when Telegram provides it. It also includes an `Open topic` button for the final mirrored message, quotes the original user prompt in an expandable block for orientation, and includes a compact quoted `📋 Tasks [n/n]:` checklist when the agent closed a todo list for that run. It does not include the final answer text.

## Mirror

Web-origin text prompts are mirrored into Telegram with a small `💬` marker. Telegram-origin prompts are suppressed when the bot can match them to its own pending send.

Assistant text is accumulated until OpenCodez completes the text block. The bot does not edit Telegram token-by-token. Completed assistant text is sent as Telegram Rich Message markdown when the Bot API accepts it, with fallback for local Markdown links and formatting errors. Real final answers are marked with `🏁 `. The bot pins the user prompt that started the run: the original Telegram message for Telegram-origin prompts, or the mirrored user message for web-origin prompts.

Tool calls are compact and expandable. Adjacent tool results update one Telegram message until assistant text starts a new block. Tool batches use Telegram MarkdownV2 expandable blockquotes, so details are one tap away without filling the topic with raw output.

Internal helper tools such as todo-style task-list tools are suppressed from live mirror and reconcile so bookkeeping does not crowd Telegram. Closed task lists may still appear in private final-answer DMs as a compact quoted checked task list. Subagent sessions are also treated as implementation details: Telegram shows the parent-visible task tool line, not a separate child session log.

## Reconcile

Live `/event` SSE is the primary path. Reconcile is a narrow fallback for the current or very recent run, not a historical backfill of every bound session. A Telegram prompt, a freshly autocreated web topic, or a live web prompt opens a bounded reconcile window for that binding. Within that window, reconcile may recover missed user/assistant messages and especially the final answer; outside it, old topics stay quiet.

The lower bound is stored on the binding as `reconcileAfter`, and the expiry as `reconcileUntil`. The lookback, active window, and interval are fixed conservative defaults. Mirrored message markers are tracked per session so a busy session cannot evict markers for another one and cause phantom replays.

Backend hosts may be off. Event streams and reconcile API calls use exponential backoff up to two minutes with rate-limited offline logs and recovery logs, so a powered-off server does not spam the service journal.
