# General Control Menu

OpenCodeBot keeps one persistent control-panel message in the Telegram forum's General topic. It is the primary interface
for session discovery and settings that are not tied to one OpenCodez topic. Commands remain available as accelerators
and for actions whose target is the current topic or replied message.

## User Contract

The panel is created or recovered at startup, edited in place, and pinned without a notification. Its home page shows:

- currently running session and queued-prompt counts;
- global automatic Final Voice state;
- global mirror state and detail mode;
- global interface language;
- entry points for a new session, recent sessions, voice, personal settings, system settings, and help.

`/menu`, `/start`, and `/help` all lead to the panel. In General, the command message is removed after the panel is
refreshed. In another topic, the bot returns a temporary `Open panel` link to General instead of creating another menu.
The link message is removed after 30 seconds.

The panel deliberately uses an inline keyboard rather than a persistent reply keyboard. It does not occupy the message
composer and cannot leak topic-specific actions into unrelated topics.

## Scope

The panel labels shared and personal state explicitly:

- `Voice` controls global Final Voice settings for every topic.
- `My settings` controls the callback user's final-answer DMs and personal `/context` depth.
- `System` controls the global interface language, mirroring switch, and mirror detail mode; Sounds and debug state are
  shown read-only.
- `Sessions` lists the twelve most recently active bindings and links to their Telegram topics. Destructive session
  actions are intentionally not offered from General.

The following actions remain topic commands because their target comes from the current forum topic:

```text
/session
/q
/compact
/context
/reset
/kill
```

`/speak` also remains a command because its source is the replied Telegram message. Setup and operator commands such as
`/artifacts_here`, `/sounds_here`, `/debug_on`, and `/update` remain accepted when typed but are hidden from Telegram's
normal slash suggestions.

The visible slash menu is intentionally limited to:

```text
/menu
/new
/session
/q
/compact
/context
/speak
/reset
/kill
/help
```

Hiding an operator command from `setMyCommands` does not remove its handler or break existing operational procedures.
Telegram Bot API command scopes do not support different lists per forum topic, so one small group-wide list is the
least surprising behavior.

## Interaction Details

Buttons always encode an explicit desired value such as on, off, `full`, or `economy`. They do not perform blind toggles.
This prevents stale buttons or status checks from unexpectedly reversing a setting. For the same reason, bare `/tts`
is status-only; use `/tts on` or `/tts off` to mutate automatic Final Voice.

Final Voice prompt and intro edits use a temporary Force Reply in General. The pending input is held in memory for five
minutes, belongs to the Telegram user who opened it, and is accepted only as a reply to that exact prompt. On success or
`/cancel`, the temporary prompt and response are removed and the one persistent panel is refreshed. The pending input is
not durable across restart because it is UI interaction state, not bot configuration.

Callbacks are handled only after the normal allowed-chat and allowed-user checks. A callback from an old panel message
receives a stale-panel alert and cannot change state.

## State And Recovery

Only the panel location is durable:

```json
{
  "telegram": {
    "controlMenu": {
      "chatId": -100123,
      "messageId": 456
    }
  }
}
```

At startup the bot edits this message with fresh state and pins it. If Telegram reports that the message was deleted or
can no longer be edited, the stale reference is cleared and one replacement panel is created. Pin failure is logged but
does not remove or duplicate the working panel.

The implementation lives in `src/control-menu.mjs`. It uses the existing Telegram transport, state store, prompt queue,
Final Voice module, and session-creation function. It does not maintain a second command implementation or introduce a
UI framework.

## Operations

After deployment:

1. Open General and verify one pinned `OpenCodeBot · Control center` message.
2. Confirm that `/menu` refreshes that message without creating a second panel.
3. Open `Sessions` and follow one topic link.
4. Change one reversible setting, verify its displayed state, and restore the preferred value.
5. Open `Voice → Advanced settings`, start a prompt or intro edit, then send `/cancel` as a reply.
6. Verify Telegram's slash suggestions contain ten commands and hidden operator commands still work when typed.

If the panel was manually deleted, run `/menu` or restart the service. If it exists but cannot be pinned, grant the bot
`Pin messages` permission; the menu remains usable through `/menu` while unpinned.
