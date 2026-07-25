# Interface Language

OpenCodeBot has one global interface language for all chats, topics, recipients, command menus, buttons, status messages, and asynchronous notifications.

Commands always remain in English. The preferred switch is `General → System`; the direct command remains available
without restarting the bot:

```text
/lang
/lang eng
/lang ru
```

`/lang en` is accepted as a convenience alias for `/lang eng`. The selected language is stored as `ui.language` in the existing atomic `state.json` and survives restart. A command sent in any permitted topic changes the interface everywhere.

The panel is redrawn immediately in the selected language. The response to `/lang eng|ru` is likewise written in the
newly selected language. OpenCodeBot also refreshes Telegram's command-menu descriptions. If Telegram temporarily rejects
that refresh, normal interface text still switches immediately and startup retries the menu synchronization.

## Scope

The switch localizes bot-owned interface text:

- command descriptions, `/help`, statuses, successes, and errors;
- prompt queue, reset, compaction, context export, and session details;
- Final Voice controls and progress messages;
- speech and artifact inboxes;
- question prompts and static buttons;
- update controls and progress;
- final notifications, run alerts, reconciliation notices, and static tool labels.

It deliberately does not translate user or model content, speech transcripts, model-generated question options, paths, filenames, server/model identifiers, operator logs, or provider diagnostics. Final Voice summary language remains controlled by its independent global prompt and TTS profile.

Existing Telegram history and topic titles are never renamed when the interface language changes.

## Configuration

New state without a saved choice uses:

```json
{
  "ui": {
    "defaultLanguage": "en"
  }
}
```

Supported config values are `en` and `ru`; `eng`, `rus`, and full English names are normalized. Once `/lang` has saved a state override, the state value wins over the config fallback.

## Source Catalogs

Translations are source-controlled and dependency-free:

```text
src/i18n/index.mjs
src/i18n/en.mjs
src/i18n/ru.mjs
```

Catalogs must contain exactly the same keys and matching value types. Validation runs when the i18n module loads, so an incomplete translation fails checks and startup instead of silently producing a mixed-language interface.

Dynamic provider errors may remain in their original language inside a localized error wrapper. This preserves accurate diagnostics without attempting unreliable runtime machine translation.

## Operations

Useful smoke sequence:

1. Select Russian in `General → System` and inspect the panel plus Telegram command menu.
2. Open Help, run `/session`, `/tts`, and one harmless status/error flow.
3. Trigger one asynchronous notification or question and verify it uses Russian.
4. Select English in the panel and repeat the checks.
5. Return to the preferred production language.

Rollback is one panel click or `/lang eng`; no restart, database migration, or deployment change is required.
