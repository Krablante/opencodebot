# Final Voice

[English](final-voice.md) · [Русский](../ru/final-voice.md) · [All languages](../README.md)

Final Voice adds a short spoken summary after a delivered text answer. It never delays the text. The bot owns the queue and Telegram reply; external OpenAI-compatible services own summarization and synthesis.

```text
delivered final → bounded memory queue → chat/completions → audio/speech → sendVoice
```

## Configuration

It is disabled in the public example. Set `finalVoice.enabled`, a summary provider and at least one TTS profile in private config. Endpoints, models and credentials are not inferred.

```json
{ "finalVoice": {
  "enabled": true,
  "summary": { "baseURL": "https://api.example.com", "model": "summary-model", "apiKeyEnv": "SUMMARY_API_KEY" },
  "tts": { "defaultProfile": "voice", "profiles": { "voice": {
    "baseURL": "http://tts-host:8000/v1", "apiKeyEnv": "TTS_API_KEY", "model": "speech-model",
    "voices": ["speaker"], "defaultVoice": "speaker", "responseFormat": "opus"
  } } }
} }
```

Keep `SUMMARY_API_KEY` and optional `TTS_API_KEY` in private environment. Summary authentication is required; TTS omits its Authorization header when no key is configured. `summary.requestBody` accepts provider-specific options, while the bot always owns `model`, `messages` and `stream`. Limits/timeouts and permitted voices are operator-controlled.

The default summary prompt/intro are Russian. Set `summary.defaultPrompt`, `defaults.introTemplate` and a suitable TTS profile for another speech language. `/lang` changes UI only. There is no Python, PyTorch, FFmpeg or model runtime in the bot image; deploy those independently when your TTS provider needs them.

## Commands and settings

Use **General → Settings → Spoken answers**, or typed shortcuts:

```text
/tts                         readiness and global settings
/tts on|off                  automatic finals on/off
/tts status                  status without provider probes
/tts prompt [text|reset]     show/change summary prompt
/tts voice [name]            list/select a permitted voice
/tts engine [profile]        list/select a TTS profile
/tts minlength [number]      automatic answer-length threshold
/tts intro [text|off|reset]  spoken intro
/tts help                    complete help
/speak                       reply to text for one manual voice
```

Settings persist globally in `state.json`. A topic reset does not reset voice preferences. Bare `/tts` is status-only; panel buttons set explicit values. Deployment configuration fixes provider access, while Telegram controls automatic use, summary prompt, profile/voice, threshold and intro.

## Delivery

Automatic jobs require a delivered final with an exact Telegram message ID, global automatic voice enabled, a configured provider and sufficient text length. Existing queued/sent IDs are deduplicated. The bounded queue drops excess automatic work; manual requests get feedback when full.

`/speak` accepts ordinary/Rich reply text, captions and quoted text. It bypasses automatic on/off and the length threshold, while still requiring deployment access/providers. If the source cannot be replied to in this chat, the result replies to the command.

`{topicname}` and `{server}` in the intro are rendered after summary generation, never sent to the summary provider. Topic metadata uses the canonical active title, removing a managed server suffix before speaking it separately. Latin intro identifiers receive deterministic Russian pronunciation; user/model text is unchanged. A blank line separates intro and summary.

Restart drops unfinished voice work. Successful deliveries retain bounded IDs; a crash between a send and its marker can still leave an uncertain result. Provider failures leave text untouched; manual progress becomes a concise retry notice. Logs contain operational metadata only, without prompts, summaries, response bodies or audio bytes.

## Audio contract

The bot sends standard `model`, `input`, `voice`, `response_format` and `speed` fields to `/audio/speech`. OGG/Opus is preferred and requires `OggS` plus `OpusHead` signatures. MP3/M4A also require agreement between requested format, Content-Type and signature. Responses are read into a bounded buffer; oversized audio is aborted. WAV/PCM is not transcoded in the bot.

## Operations

Deploy/verify the TTS endpoint first, add private config/secrets, then enable automatic voice. Disable any old sender reacting to the same finals before `/tts on`, or both will send. Check one final and a manual `/speak`, then finals from two topics using the same global preferences. `/tts status` reports readiness and queue without probing providers. `/tts off` disables automatic use; `finalVoice.enabled=false` followed by restart disables all voice access.
