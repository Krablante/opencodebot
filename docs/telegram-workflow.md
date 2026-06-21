# Telegram Workflow

Telegram is the companion surface, not a second OpenCodez backend. The bot binds Telegram forum topics to OpenCodez sessions, sends prompts through the normal OpenCodez API, and mirrors visible progress from OpenCodez events and history. If OpenCodez says something happened, Telegram can show it; if a browser dropdown changed but no prompt was sent, the bot does not invent that local browser state.

The useful shape is deliberately narrow. A topic is a working thread, `/new` creates a session-backed topic, `/q` keeps the next prompt ready while a run is busy, and attachments travel with the prompt text. The mirror should feel like the visible web UI in Telegram, not like raw backend JSON.

## Topics

The bot expects a forum-enabled Telegram chat when topic creation is used. A topic can be created from Telegram with `/new`, or autocreated for web-created OpenCodez sessions when `autocreateTopics` is enabled.

If `telegram.chatId` is missing and `telegram.allowChatBootstrap` is enabled, the first message from an allowed user initializes the chat in local state. For a shared bot, set `telegram.chatId` and `telegram.allowedUserIds` deliberately instead of relying on accidental bootstrap messages.

When OpenCodez later updates a session title, the linked Telegram topic is renamed too unless the topic title came directly from the user. This lets placeholder titles such as a template name become real session titles, while `/new nuc gpt55p Refactor auth` keeps `Refactor auth`. New topics use a random forum icon when Telegram exposes available topic icon stickers to the bot.

## Commands

```text
/new [server] [template] [title]  create a topic and wait for the first prompt
/q <prompt>                       queue or send a prompt in this topic/session
/q status                         show queued prompts
/q delete <number>                remove a queued prompt by status number
/mirror_on                        enable web-to-Telegram mirroring
/mirror_off                       disable web-to-Telegram mirroring
/help                             show commands and configured templates
```

`/new` parses arguments from left to right. If the first argument matches a configured server id, that server is used. If the next argument, or the first argument when no server was given, matches `chatTemplates`, that template is used. Everything left becomes the user-owned topic title.

Examples:

```text
/new TGBOT
/new ser Release check
/new d4flash Fix upload flow
/new nuc gpt55p Architecture pass
```

The default templates are `d4flash`, `d4pro`, and `gpt55p`. They are host-independent Telegram-created-session profiles. Each can set agent, model, variant, and an OpenCodez prompt template. The bot applies the OpenCodez template after creating the session and before sending the first prompt.

## Prompts

For an existing topic, the bot sends prompts with the session's current `agent`, `model`, and `variant`, or the last user-message metadata when available. Last sent settings win. For a new topic created from Telegram, the bot uses the runtime default profile unless a chat template overrides it.

Long Telegram-origin prompts can arrive as multiple Telegram messages. Near-limit prompt parts are held briefly in memory and joined with a blank line before being sent to OpenCodez. Ordinary short messages are sent immediately.

Telegram-origin prompts can include attachments. The bot downloads supported files into the configured uploads directory under Politia state and sends them as `file://` parts next to the prompt text. Files with captions flush as one prompt after media groups settle. Files without captions wait for the next plain text message from the same user/topic.

Supported attachment inputs include documents, photos, videos, animations, audio, voice messages, video notes, and media groups. Limits live in `attachments.maxFiles`, `attachments.maxFileBytes`, and `attachments.maxTotalBytes`.

## Queue

`/q <prompt>` sends immediately when the bound OpenCodez session is idle. If the session is busy, the prompt is kept in memory for that session.

The queue advances only after the same final-answer path used for `🏁` and pinning, where OpenCodez reports `finish === stop`. Progress notes, reconnects, and tool-only steps do not release the next queued prompt. If OpenCodez reports a terminal run failure, the bot announces the failure, clears queued prompts for that session, and lists the cleared items by number plus the same first-words summary used by `/q status`. A service restart drops queued prompts instead of writing full user prompts into `state.json`.

## Mirror

Web-origin text prompts are mirrored into Telegram with a small `💬` marker. Telegram-origin prompts are suppressed when the bot can match them to its own pending send.

Assistant text is accumulated until OpenCodez completes the text block. The bot does not edit Telegram token-by-token. Completed assistant text is sent as Telegram Rich Message markdown when the Bot API accepts it, with fallback for local Markdown links and formatting errors. Real final answers are marked with `🏁 ` and pinned when configured.

Tool calls are compact and expandable. Adjacent tool results update one Telegram message until assistant text starts a new block. Tool batches use Telegram MarkdownV2 expandable blockquotes, so details are one tap away without filling the topic with raw output.

Hidden tool names in `mirror.hiddenTools` are suppressed from live mirror and reconcile. The default hides todo-style tools so task-list maintenance does not crowd Telegram. Subagent sessions are also treated as implementation details: Telegram shows the parent-visible task tool line, not a separate child session log.

## Reconcile

Live `/event` SSE is the primary path. Reconcile is the fallback path after restart, missed events, or short connection gaps. It reads OpenCodez session history for bound sessions and backfills completed assistant messages once instead of silently losing them.

Backend hosts may be off. Event streams and reconcile API calls use exponential backoff up to two minutes with rate-limited offline logs and recovery logs, so a powered-off server does not spam the service journal.
