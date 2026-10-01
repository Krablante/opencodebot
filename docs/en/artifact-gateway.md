# Artifact delivery

[English](artifact-gateway.md) · [Русский](../ru/artifact-gateway.md) · [All languages](../README.md)

FILES has two independent directions. Agents stream local files/text to the bot's gateway, which posts them to one chosen topic. Telegram users drop files into that topic, and the bot saves them on a chosen OpenCodez server. Outbound agent delivery needs no SSH or Telegram token on the agent; incoming remote storage can use SSH.

## Setup

`/setup` prepares FILES, enables the gateway when requested and shows the gateway URL plus a personal artifact-token screen. Install the bundled plugin and full skill on every agent host. A gateway connection and a writable incoming dropbox are different checks: verify both directions.

Manual configuration:

```json
{ "artifacts": { "enabled": true, "listenHost": "0.0.0.0", "port": 8788,
  "tokenEnvNames": ["OPENCODEBOT_ARTIFACT_TOKEN"] },
  "artifactUploads": { "enabled": true, "root": "~/trash", "dateFolders": true } }
```

Set a long random `OPENCODEBOT_ARTIFACT_TOKEN` in private environment, then run `/artifacts_here` in the destination. Running it elsewhere replaces the shared target and disables any agent binding in the new FILES topic. Ordinary text there shows dropbox help. Keep the gateway on trusted networks and match its listener to [Compose ports/mounts](docker.md).

## User-dropped files

Empty captions use the default server. The first caption word selects a server; unknown IDs are rejected before downloading. Comma-separated names apply by position across an album:

```text
workstation photo, backup, , report.pdf
```

Names without a dot inherit the complete suffix beginning at the source's first dot: `backup` plus `archive.tar.gz` becomes `backup.tar.gz`. A name with a dot is exact. Empty/missing positions retain source names; extra names are ignored. Sanitization prevents caption names from creating directories. Count and actual batch size limits apply here too.

The final path is `artifactUploadRoot`, or `artifactUploads.root` expanded from server `home`, plus optional `YYYY-MM-DD` and filename. Local paths need writable mounts; remote paths use the server's transfer settings. [Docker](docker.md#artifact-dropbox-paths) covers Linux/macOS/Windows arrangements.

Existing files are never silently overwritten. A collision fails with a rename instruction; complete local/POSIX transfers publish the finished file atomically. Earlier successful files in a multi-file upload remain saved if a later file fails. Retention of final files belongs to the operator.

## Gateway API

All endpoints require `Authorization: Bearer <artifact-token>`. `GET /artifacts/status` reports destination readiness. `POST /artifacts/send` accepts JSON text/display metadata, up to 64 KiB:

```json
{ "caption": "workstation my-app deploy log", "mode": "text", "text": "log excerpt" }
```

Files use streaming bytes rather than JSON paths or base64:

```text
POST /artifacts/send-file
Content-Type: application/octet-stream
X-Opencodebot-Artifact-Meta: <base64url JSON>

<raw bytes>
```

Example decoded metadata:

```json
{ "caption": "workstation my-app screenshot", "mode": "auto",
  "file": { "filename": "screen.png", "contentType": "image/png" } }
```

Client-supplied paths are display metadata only. Spool ownership is process-local, so JSON cannot request a file read or arbitrary cleanup. Files stream to a unique directory with their requested basename. Completed/failed delivery cleans it; abandoned recognized spools older than 24 hours are cleaned hourly.

| Mode or limit | Behavior |
| --- | --- |
| `auto` | Suitable JPEG/PNG/WebP as photos; other files as documents |
| `photo` | Display preference; oversized/rejected photos fall back to lossless documents |
| `document` | Lossless file delivery |
| `text` | Expandable quote; plain text if escaping exceeds the Telegram budget |
| Text | 3,400 characters, with a combined caption/path/message limit of 4,096 |
| Cloud files | 50 MiB acceptance limit, with a 32 MiB in-memory spool-to-multipart cap |
| Local files | Up to local Bot API's 2 GB, sent by shared file path |
| Concurrency | Four active deliveries; excess receives `503` and `Retry-After: 5` |

Oversized text is rejected before file delivery. Send long text as a document. The gateway reports message IDs and links for successful sends; an uncertain network result can still require checking the topic before retry.

## OpenCodez plugin

Install `plugins/opencodebot-artifacts/` as a package through your OpenCodez deployment process. Reference its installed directory with an absolute/relative path, `file://` URL or `[spec, options]` tuple. Windows accepts normal absolute paths or `file:///C:/...` URLs.

```jsonc
{ "plugin": [["/path/to/opencodebot/plugins/opencodebot-artifacts",
  { "gatewayUrl": "http://gateway-host:8788" }]] }
```

Keep the token in the host's private environment:

```env
OPENCODEBOT_ARTIFACT_GATEWAY_URL=http://gateway-host:8788
OPENCODEBOT_ARTIFACT_TOKEN=same-private-artifact-token
```

The tool is `opencodebot_send_artifact({ path?, paths?, text?, caption, mode? })`. Local relative paths, POSIX/Windows/UNC paths and file URLs are resolved on the agent host. Multiple paths send a batch with human-readable path captions. The gateway never reads the agent's filesystem itself.

## Skill setup

Install the complete `skills/telegram-artifact-send/` directory, including `agents/openai.yaml`. It triggers only for explicit Telegram/TG/artifacts delivery requests. “Read this file” or “show the log” alone must not send anything to Telegram.

## Updating

Update the bot with `git pull --ff-only` and `npm run deploy:bot`, or `deploy:all` for service changes. Changed plugin/skill source requires refreshing installed copies on each affected OpenCodez host and restarting the owning service to load them. The bot updater reports that follow-up and never restarts OpenCodez.

Verify a small text artifact, a photo, a lossless document, an oversized/rejected photo fallback, and an incoming file with exact byte comparison. Repeat an existing filename to confirm preservation. Perform probes in disposable destinations and preserve real FILES data.
