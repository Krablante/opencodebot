# General menu

[English](control-menu.md) · [Русский](../ru/control-menu.md)

General contains one pinned Rich Message with embedded buttons. It offers New topic, Recent topics, Profiles, Settings and How to use. Working topics keep their ordinary conversation interface and topic commands. Bot API **10.3 or newer** is required; the Compose local API image is pinned to a supported version.

The panel moves to a new message every 24 hours. `/menu` moves it immediately. The new location is saved before the old panel is deleted. If Telegram refuses deletion, the old message is replaced with an inert notice and unpinned. Only the current panel can process its callbacks. Navigation and automatic status refresh edit that panel in place.

Automatic status refresh consumes the existing OpenCodez event stream and skips identical menu content. Opening or explicitly refreshing Home/Recent topics performs the scoped backend lookup with existing backoff. There is no status polling timer or backend scan per tool event.

## Home statistics

Answers today counts completed main-session text answers successfully delivered to the configured Telegram forum. Multiple text blocks and repeated completion events count once. Personal notifications and voice replies do not affect the count. Delivery identifiers and timestamps are saved in bot state, with eight days of retention for deduplication; no answer text is stored. Counts survive restart and remain after a topic is closed or deleted.

The day uses `ui.timeZone` when configured, otherwise the update schedule's time zone or the process's local time zone. A single local-midnight timer refreshes Home from cached data, including across DST changes. Tracking starts when this feature is first installed; on that first day, Home shows its start time instead of implying that earlier replies were counted. Old conversation histories are not scanned for backfill.

The compact Servers line uses the existing event-stream connections for every configured server, including servers without topic bindings. It distinguishes available, unavailable and still-checking connections. Disconnects and reconnects update the panel without a separate health poll. Running shows the number of sessions with a known active status; server availability is reported separately in the Servers line.

## Recent topics

Recent topics shows up to six open working topics, ordered by activity. Each title is a full, wrapping link; its server and status appear on a separate line. Other topics remain accessible through Telegram's topic list.

Opening this screen verifies topics before filling six slots, examining at most 18 candidates. Successful checks can be reused for one minute; Refresh checks again and continues cleanup when many old topics were removed. Bot API supplies no topic-list/read method or deletion update. A silent ordinary message verifies the thread and is immediately deleted; a missing-thread error confirms deletion. It never reapplies a stored title or icon. Status events do not repeat these checks. Rate limits, timeouts and permission failures preserve bindings; rate limits pause checks until Telegram's retry time.

Confirmed deletion disables the topic's mirror, clears its queued prompts and scheduled recovery, and removes any pending launch. The previous OpenCodez session and disabled binding history remain available. Delivery failures indicating a missing or closed topic use the same lifecycle cleanup. See [Telegram workflow](telegram-workflow.md#topics).

## Create a topic

New topic opens an ordinary Rich Message card in the chat with a ready-made random title. Its card shows the saved profile name, exact provider/model ID, reasoning level and server. The configured default profile is selected first; an installation with no concrete default uses a matching saved launch profile, then its most recently used profile, `sol` if available, or another saved profile with an explicit model. This selects the wizard's draft without changing saved defaults or existing sessions.

By default, new topics receive a uniform random word from **3,483 bundled Russian nouns**: the original 2,630 Old Russian headwords plus 853 curated words for animals, plants, objects, landscapes, traditional life and fairy-tale imagery. The two files total about 50 KB and load once, without a network or model. The original list retains its CC BY-SA 4.0 attribution; the additions are MIT licensed. [Sources, selection criteria and licenses](../../assets/old-russian-words.LICENSE.md) accompany the lists.

Each word independently receives one of three equally likely styles: lowercase, uppercase or an initial capital, such as `веретено`, `ВЕРЕТЕНО` or `Веретено`. The chosen spelling stays the same from preview through creation and later restarts. The managed server suffix keeps its original spelling.

Another word draws both the word and its case again; Title preserves the spelling you enter. The selected name stays in the draft when changing model or server. Random selection allows repetitions. General → Settings → Random topic names disables the mode and survives restart. When disabled, the wizard asks for a name and topics created from web sessions use their previous session-title behavior. The setting affects new topics; existing ones are not renamed. Random names survive OpenCodez title updates and `/reset`, with the existing managed server suffix. Explicit titles in `/new ... Title` take precedence.

With multiple connections, a Server button appears directly on the creation card. The picker lists every configured server and marks the current one. Switching server resets the directory to that server's new-session directory and checks its model catalog. The Working directory button opens path input directly; a single-server installation shows the fixed server without a picker.

Creation requires a specific available model and reasoning level. If a saved profile inherits reasoning, or its level is unsupported on the selected server, choose a supported level for this topic. Models without reasoning variants show Not applicable. The wizard saves the exact displayed model/variant in the pending launch snapshot; this one-topic choice leaves the saved profile unchanged. Unavailable models, System prompts or catalogs disable creation and explain which choice to change. Catalog reads reuse the existing one-minute cache.

`/new` without arguments opens this flow. `/new [server] [profile] [dir:<path>] [title]` remains a shortcut. Both use the same pending-topic creation path. The OpenCodez session is created on the first prompt, bound before model/System changes, and retains a launch snapshot for retry and reset.

After creation, the Topic ready card keeps its Open topic and Close buttons and is automatically deleted two minutes after it is shown. Closing it or opening another topic/profile screen removes it earlier. The deletion deadline is saved in bot state and restored after restart; overdue confirmations are removed on startup. Failed deletion is logged and retried, respecting Telegram's rate limits. Offline clients receive the updated chat history when they reconnect.

## Profiles and model catalog

Profiles can be created, copied, renamed, edited, set as default, deleted and restored from Telegram. A new installation starts with `sol`, `solm`, `solx` and `d4flash`. Existing installations import their former built-ins and explicit configuration once into the same editable collection. Deleted profiles do not reappear after restart or update.

The catalog comes from the selected server's `/opencodez/library`. It includes provider/family grouping, names, IDs and supported reasoning variants. Rich tables contain selection buttons. Large catalogs load collapsed families with Search and Expand all controls; bounded pages respect Telegram's text and block limits. Search accepts a name, ID, provider or family. The bot caches catalog metadata for one minute and coalesces concurrent reads. It never scans the workspace, runs a browser renderer, or polls model providers continuously.

New profiles inherit OpenCodez System assignments and reasoning defaults unless the user chooses explicit settings. The profile editor also supports agent and System selection. Saving checks the selected model and variant against the chosen server. Catalog presence cannot guarantee account quota or paid access.

Edits affect future launches. Existing sessions retain their model and launch snapshot. `/reset` without arguments can use that snapshot when the named profile was deleted; it preserves the server and directory and leaves the previous OpenCodez session intact.

## Topic and profile dialogs

Topic/profile cards are ordinary messages visible to chat members. Only the operator who opened a card can use its controls. The bot checks the actor, chat, topic, message ID, draft lifetime and screen revision before applying a callback. Drafts expire after 15 minutes and disappear on restart; their cards are deleted on expiry or startup. Saved settings persist. A stale or foreign callback cannot apply a choice.

Topic/profile fields use Force Reply on the Rich Message card itself. With random names enabled, creation shows a ready-made title without asking for input. Title, or disabling random names, opens the question on a fresh card. Telegram cannot edit ordinary messages sent with Force Reply, so accepted input replaces the question card with a normal result card. Another field or a validation error uses a fresh question card too. The previous card is deleted after successful delivery of its replacement.

Input belongs to the actor, chat, topic and active card and requires a reply to that card. Ordinary unquoted text is not consumed. `/cancel` cancels the field, and Close cancels the draft. Answer messages are removed when possible. Card identifiers are retained for 48 hours so late or foreign replies are consumed without becoming agent prompts, file uploads or transcriptions, including after restart. No input text is stored in these records. Provider keys follow the separate pre-journal path described in [first run](first-run.md).

## Settings and guide

How to use opens the guide from General. `/help` still opens it when typed manually, but is omitted from Telegram's suggested command list. The Files and audio page explains the optional local Bot API's 2 GB file support and links to its installation instructions; API credentials alone do not start that service.

Settings separates inbound AUDIO transcription from spoken final answers. Personal settings control final-answer notifications and `/context` depth. Language, mirror visibility and tool detail remain global. Economy is the initial mirror mode; the detailed mode is an advanced choice.

The built-in guide has eight Rich Message pages: getting started, the creation wizard, all `/new` forms, profiles, everyday work, reset/rewind, files/audio, and settings. Quick commands explain server, profile, directory and title selection, defaults, quoting and matching names. English/Russian PDFs are downloadable with additional sections expanded. Text lives in `src/user-guide.mjs`; `scripts/preview-ui.mjs` produces each page and document preview from the same menu renderers. Published PDFs live in `assets/` and are included in the image. Review regenerated PDFs visually before replacing them.

## Ownership and checks

`control-menu.mjs` owns the General panel, daily rotation and shared settings views. `launch-menu.mjs` owns topic/profile drafts and one cleanup timer for their saved card deadlines. `user-settings.mjs` owns durable preferences, one-time import and catalog reads. `setup.mjs` owns connection setup. They reuse the existing Telegram client, state store and session creation path.

After deployment, check the pinned menu, one topic-creation flow, profile save/delete/restore, model-family expansion, stale callbacks, `/reset` and `/session`. Validate Rich HTML through Telegram's prepared-message API and inspect phone-sized previews. Prepared-message acceptance verifies the API parser, not the exact layout of every Telegram client.
