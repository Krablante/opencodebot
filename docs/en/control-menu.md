# General menu

[English](control-menu.md) · [Русский](../ru/control-menu.md)

General contains one pinned Rich Message with embedded buttons. It offers New topic, Recent topics, Profiles, Settings and How to use. Working topics keep their ordinary conversation interface and topic commands. Bot API **10.3 or newer** is required; the Compose local API image is pinned to a supported version.

The panel moves to a new message every 24 hours. `/menu` moves it immediately. The new location is saved before the old panel is deleted. If Telegram refuses deletion, the old message is replaced with an inert notice and unpinned. Only the current panel can process its callbacks. Navigation and automatic status refresh edit that panel in place.

Automatic status refresh consumes the existing OpenCodez event stream and skips identical menu content. Opening or explicitly refreshing Home/Recent topics performs the scoped backend lookup with existing backoff. There is no status polling timer or backend scan per tool event.

## Recent topics

Recent topics shows up to six open working topics, ordered by activity. Each title is a full, wrapping link; its server and status appear on a separate line. Other topics remain accessible through Telegram's topic list.

Opening this screen verifies the listed topics against Telegram before filling the six slots. Successful checks can be reused for one minute; Refresh always checks again. Bot API does not emit a topic-deletion update or provide a topic-list method. The bot therefore reapplies each topic's tracked title with `editForumTopic`: `TOPIC_NOT_MODIFIED` means it exists, while `TOPIC_ID_INVALID` confirms deletion. Status updates from OpenCodez do not repeat these checks. Rate limits, timeouts and permission failures preserve the binding; rate limits pause further checks until Telegram's retry time.

Confirmed deletion disables the topic's mirror, clears its queued prompts and scheduled recovery, and removes any pending launch. The previous OpenCodez session and disabled binding history remain available. Delivery failures indicating a missing or closed topic use the same lifecycle cleanup. See [Telegram workflow](telegram-workflow.md#topics).

## Create a topic

New topic opens a personal ephemeral screen, asks for the title, and shows the exact model ID and reasoning. The current default profile is selected. Profile selection places recently used profiles first. Server and directory choices are optional; a single-server installation does not ask the user to choose a server.

`/new` without arguments opens this flow. `/new [server] [profile] [dir:<path>] [title]` remains a shortcut. Both use the same pending-topic creation path. The OpenCodez session is created on the first prompt, bound before model/System changes, and retains a launch snapshot for retry and reset.

## Profiles and model catalog

Profiles can be created, copied, renamed, edited, set as default, deleted and restored from Telegram. A new installation starts with `sol`, `solm`, `solx` and `d4flash`. Existing installations import their former built-ins and explicit configuration once into the same editable collection. Deleted profiles do not reappear after restart or update.

The catalog comes from the selected server's `/opencodez/library`. It includes provider/family grouping, names, IDs and supported reasoning variants. Rich tables contain selection buttons. Large catalogs load collapsed families with Search and Expand all controls; bounded pages respect Telegram's text and block limits. Search accepts a name, ID, provider or family. The bot caches catalog metadata for one minute and coalesces concurrent reads. It never scans the workspace, runs a browser renderer, or polls model providers continuously.

New profiles inherit OpenCodez System assignments and reasoning defaults unless the user chooses explicit settings. The profile editor also supports agent and System selection. Saving checks the selected model and variant against the chosen server. Catalog presence cannot guarantee account quota or paid access.

Edits affect future launches. Existing sessions retain their model and launch snapshot. `/reset` without arguments can use that snapshot when the named profile was deleted; it preserves the server and directory and leaves the previous OpenCodez session intact.

## Personal dialogs

Ephemeral screens are visible only to the operator who opened them. The bot checks the actor, chat, ephemeral message ID, draft lifetime and screen revision before applying a callback. Drafts expire after 15 minutes and disappear on restart. Saved settings persist. A stale or foreign callback cannot apply a choice.

Text fields use a temporary Force Reply in the same topic. The response belongs to that actor and prompt. `/cancel` and Close cancel input; accepted input and its temporary prompt are removed. Provider keys follow the separate pre-journal path described in [first run](first-run.md).

## Settings and guide

Settings separates inbound AUDIO transcription from spoken final answers. Personal settings control final-answer notifications and `/context` depth. Language, mirror visibility and tool detail remain global. Economy is the initial mirror mode; the detailed mode is an advanced choice.

The built-in guide has six illustrated Rich Message pages and a downloadable PDF in English and Russian. Its text lives in `src/user-guide.mjs`; `scripts/preview-ui.mjs` produces HTML previews from the same menu renderers. Published PDFs live in `assets/` and are included in the image. Review regenerated PDFs visually before replacing them.

## Ownership and checks

`control-menu.mjs` owns the General panel, daily rotation and shared settings views. `launch-menu.mjs` owns personal topic/profile drafts. `user-settings.mjs` owns durable preferences, one-time import and catalog reads. `setup.mjs` owns connection setup. They reuse the existing Telegram client, state store and session creation path.

After deployment, check the pinned menu, one topic-creation flow, profile save/delete/restore, model-family expansion, stale callbacks, `/reset` and `/session`. Validate Rich HTML through Telegram's prepared-message API and inspect phone-sized previews. Prepared-message acceptance verifies the API parser, not the exact layout of every Telegram client.
