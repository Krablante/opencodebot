# Final Voice

Final Voice turns a completed OpenCode answer into a short spoken Telegram reply without delaying or weakening the normal text flow.

The feature is optional and disabled by default. OpenCodeBot performs orchestration and Telegram delivery; model inference stays in a separate OpenAI-compatible TTS service.

## Architecture

```text
OpenCode final answer
  -> bounded OpenCodeBot background queue
  -> OpenAI-compatible /chat/completions summary
  -> OpenAI-compatible /v1/audio/speech synthesis
  -> Telegram Bot API sendVoice reply to the exact final message
```

OpenCodeBot owns:

- global settings and commands;
- summary prompt and provider credentials;
- bounded background work and deduplication;
- the Telegram bot token and final-message reply routing.

The TTS provider owns only text-to-audio conversion. It must not receive Telegram credentials, session data, or DeepSeek credentials. Python, PyTorch, models, and FFmpeg do not belong in the OpenCodeBot image.

## Configuration

`config.example.json` contains a complete disabled DeepSeek plus Silero example. Copy its `finalVoice` block into the effective runtime config and set deployment-specific values.

The production-compatible DeepSeek preset uses:

- `https://api.deepseek.com/chat/completions`;
- `deepseek-v4-flash`;
- thinking enabled;
- `reasoning_effort: max`;
- `max_tokens: 393216`;
- no temperature override.

`summary.requestBody` is passed through for OpenAI-compatible provider options, but OpenCodeBot always owns and overwrites `model`, `messages`, and `stream`. This permits provider-specific reasoning options without provider-specific code.

TTS is configured as named profiles. Each profile fixes the operator-controlled endpoint, model, output format, timeout, and available Telegram-selectable voices. The bot never discovers models or endpoints dynamically.

Secrets stay in `token.env`:

```dotenv
DEEPSEEK_API_KEY=replace-me
SILERO_TTS_API_KEY=optional-private-bridge-token
```

`DEEPSEEK_API_KEY` is required when Final Voice is enabled. TTS bearer authentication is optional: if the configured environment variable is empty, OpenCodeBot sends no Authorization header.

When `finalVoice.enabled` is false:

- provider clients perform no requests;
- no worker or timer is kept alive;
- missing keys do not block startup;
- topic commands report that deployment access is disabled.

## Commands And Topic State

The compact interface is:

```text
/tts                         show readiness and effective global settings
/tts on|off                  explicitly enable or disable it
/tts status                  show readiness and effective settings
/tts prompt                  show the effective prompt
/tts prompt <text>           set the global prompt
/tts prompt reset            restore the deployment default
/tts voice [name]            list or select a configured voice
/tts engine [profile]        list or select a configured TTS profile
/tts minlength [number]      set the automatic-final threshold
/tts intro [text|off|reset]  configure the spoken intro
/tts help                    show the complete command help
/speak                       reply to text, a Rich Message, or quoted text for one manual voice
```

Legacy commands remain accepted: `/озвучка`, `/промпт`, `/промпт_сброс`, `/голос`, `/движок`, `/минимум`, `/шаги`, `/стартовый`, `/озвучь`, `/статус`, `/помощь`, and their English aliases from the previous service.

Telegram Bot API command-menu names permit only lowercase English letters, digits, and underscores. The compact visible
menu advertises `/speak`; Final Voice configuration lives in the General control panel and `/tts` remains available as a
typed accelerator. Cyrillic aliases work when typed manually.

All Final Voice settings are global and stored once in the existing atomic `state.json`: automatic on/off, prompt, TTS profile, voice, minimum final length, and intro. The preferred UI is `General → Voice`; commands remain available as direct accelerators. Changing any setting from the panel or one topic immediately affects every topic. Telegram topic data is used only to route the resulting voice reply. A session `/reset` does not reset Final Voice settings.

Panel buttons set explicit on/off values and never perform a blind toggle. Bare `/tts` is likewise status-only so that
checking state cannot accidentally disable automatic voice. `/tts toggle` remains available only as an explicit legacy
shortcut.

On first startup after upgrading from the earlier topic-local format, OpenCodeBot migrates the enabled state and existing overrides into the single global settings object and removes the obsolete topic map. Existing prompts are preserved.

The legacy `/steps` command remains understandable but reports that the current OpenAI-compatible Silero profile does not use a synthesis-step parameter. Supertonic is not bundled or emulated.

## Runtime Behavior

The renderer calls Final Voice only after the final RichMessage has been successfully sent or updated. The callback passes the unformatted final answer and exact Telegram message ID, then returns after a synchronous queue operation. Summary and TTS requests never delay the final text.

Automatic jobs are skipped when:

- the deployment gate is off;
- global automatic voice is off;
- final text is below `minFinalChars`;
- a provider is unconfigured;
- the same assistant message has already been queued or sent;
- the bounded queue is full.

Manual `/speak` jobs accept ordinary reply text, captions, Telegram Rich Message text, and `quote.text` from external
replies. They ignore the global automatic gate and minimum length, but still require the deployment gate and configured
providers. When the original message cannot be replied to in the current chat, the voice reply targets the `/speak`
command message instead.

The configured intro template is rendered only after summary generation and prepended to the TTS input. `{topicname}`
and `{server}` come from the exact automatic-final binding or the current active binding for manual `/speak`; they are
never sent to the summary provider. Disabled historical bindings are not used for intro metadata.

The queue is intentionally in-memory. A restart drops incomplete voice work, while existing renderer markers prevent old finals from being replayed. Successful Telegram deliveries are recorded in a bounded persistent marker list. This provides clean at-most-once behavior without a second job database.

Provider failures never alter the final text. Automatic failures are logged structurally. Manual failures replace the temporary progress message with a concise retry notice.

Logs include identifiers, durations, character counts, status codes, and byte sizes. They do not include API keys, final text, prompts, summaries, provider response bodies, or audio bytes.

## Audio Contract

OpenCodeBot sends the standard JSON fields:

```json
{
  "model": "silero-ru-v5.5",
  "input": "spoken summary",
  "voice": "xenia",
  "response_format": "opus",
  "speed": 1
}
```

OGG/Opus is preferred. MP3 and M4A responses are also supported when their configured format, response Content-Type, and file signature agree. Responses are streamed into a bounded buffer and aborted immediately when `maxResponseBytes` is exceeded.

For Opus, OpenCodeBot requires both `OggS` and `OpusHead` signatures before calling Telegram `sendVoice`. WAV or PCM are never transcoded in the bot.

## Operations

Recommended deployment order:

1. Deploy OpenCodeBot code with `finalVoice.enabled: false`.
2. Deploy and verify the private TTS endpoint.
3. Add runtime secrets and provider URLs.
4. Set the deployment gate to true.
5. Disable the previous Telegram/MTProto sender before enabling `/tts on` globally.
6. Test one final answer and verify exactly one voice reply.
7. Verify final answers from more than one topic use the same settings.

Do not run the old automatic sender and Final Voice simultaneously: both can react to the same final answer and produce duplicates.

Useful checks:

```bash
docker compose logs --since=10m opencodebot
curl -fsS http://TTS_HOST:8000/healthz
```

`/tts status` deliberately does not probe providers. It reports configuration readiness and queue state without introducing health-polling traffic or startup coupling.

## Rollback

Turn off voice globally with `/tts off`, or set the deployment gate to false and restart OpenCodeBot. Text behavior is unaffected. The previous service can then be re-enabled if it was preserved for rollback, but the two automatic senders must not overlap.
