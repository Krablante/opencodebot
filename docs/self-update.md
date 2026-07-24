# Self-Update

opencodebot checks its public GitHub `main` branch every day at `07:00 Europe/London`. When a newer commit exists, it
posts one concise update card in the Telegram General topic. `/update` performs the same check immediately and reports
in the topic where the command was used. A manual check does not move or disable the daily schedule.

The feature deliberately owns only opencodebot. It never deploys bundled OpenCodez plugin or skill copies, never calls
the Politia harness, and never restarts OpenCodez. If the exact Git range includes
`plugins/opencodebot-artifacts/` or `skills/telegram-artifact-send/`, the offer and final success card identify those
source changes and tell the operator to apply the installed copies manually when convenient.

## Telegram UX

The update card shows the deployed and target short revisions, commit count, grouped user-facing notes, a GitHub compare
link, and two actions:

- `Update & restart` queues the exact displayed target revision.
- `Not now` removes the buttons and suppresses the same revision until the next London calendar day.

One-click update is deliberately unavailable when the range changes `docker-compose*.yml`,
`scripts/apply-update.mjs`, or `scripts/install-update-runner.mjs`. Those files define the deployment control plane;
using their new contents to roll back an old image would not restore the old runtime contract. The card shows the exact
paths and one host command using `deploy:bot` or `deploy:all` instead.

Notes come from the exact GitHub compare range. `feat:`, `fix:`, and `perf:` commit subjects become New, Fixed, and
Performance sections. Documentation, test, refactor, build, and chore commits collapse into one technical-maintenance
count. At most eight user-facing entries are shown; GitHub remains the full record. Keep commit subjects concise and
human-readable so update cards stay useful without a second manually synchronized changelog.

During an approved update, the same Telegram message moves through queue, repository verification, dependency install,
checks, image build, restart, and live verification. The active run and message identity are durable. After Compose
restarts the bot, the new process reads the host result and edits the original card to success or failure.
If the host runner stops reporting progress, the bot marks the run interrupted after 35 minutes, removes stale request
files, and releases the update lock so `/update` can retry. The systemd service timeout remains 30 minutes, leaving a
five-minute recovery margin.

## Architecture

The bot container has no Docker socket and no source checkout. Approval is passed through two atomic JSON files in the
already mounted state directory:

```text
bot: /app/state/updates/request.json
                 |
                 v
user systemd.path -> scripts/apply-update.mjs
                 |
                 v
bot: /app/state/updates/status.json
```

There is no HTTP listener, privileged sidecar, or long-running updater daemon. The host runner accepts only a UUID plus
two full Git revisions. It validates origin, branch ancestry, a clean checkout, and fast-forward safety before executing
fixed argument arrays; Telegram callback data is never interpreted as a shell command.

The runner then:

1. fetches the configured branch and fast-forwards the checkout to the approved target;
2. runs `npm ci`, `npm run check`, and `npm run smoke`;
3. preserves the running image as `opencodebot:rollback`;
4. builds `opencodebot:current` with the target Git revision in its environment and OCI image label;
5. force-recreates only the `opencodebot` Compose service with `--no-deps`;
6. runs `npm run smoke:live`;
7. restores the previous image if replacement or live verification fails.

Source may remain fast-forwarded after a failed build. That is intentional: the running image revision remains the
deployment source of truth, `/update` offers the same target again, and retry does not require a destructive Git reset.

## Configuration

Shareable defaults:

```json
{
  "updates": {
    "enabled": true,
    "repository": "Krablante/opencodebot",
    "branch": "main",
    "checkAt": "07:00",
    "timeZone": "Europe/London"
  }
}
```

Use an IANA time zone. `Europe/London` tracks GMT and British Summer Time automatically. The scheduler checks London
calendar time once per minute and persists the last completed calendar date, so a restart after 07:00 performs the
missed check instead of waiting until the next day.

The running Git revision comes from `OPENCODEBOT_BUILD_SHA`. Do not set it by hand in runtime config. `npm run deploy:bot`
derives it from the clean checkout and supplies it to Docker. An image with missing or malformed revision metadata can
run normally, but automatic and manual update checks stay disabled until one correctly labelled rebuild.

## Install The Linux Host Runner

The Telegram checker and `/update` work on every supported client and do not depend on the OpenCodez target server OS.
The unattended apply runner is intentionally Linux/systemd-only because it operates the host running the canonical
Compose service. Windows OpenCodez servers and Windows Telegram users require no updater installation or special paths.

On the Linux Compose host:

```bash
npm run update-runner:install
systemctl --user status opencodebot-update.path
```

The installer defaults to Politia state at `~/politia/state/projects/tg/opencodebot`. A standalone deployment can name
the host bind-mount source explicitly:

```bash
npm run update-runner:install -- --state-dir /absolute/host/state
```

The selected host state directory must be the source mounted at `/app/state`. The installer writes only user units under
`~/.config/systemd/user/`, enables `opencodebot-update.path`, and leaves a non-secret `updates/runner.json` readiness
marker for the container. Remove it with `npm run update-runner:uninstall`.

Re-run the installer after changing the configured repository, branch, project location, or host state path so the fixed
host runner contract stays aligned with the container checker.

## Manual Deployment And Verification

Use the cross-platform deployment wrapper instead of rebuilding an unlabelled image manually:

```bash
npm run deploy:bot
```

It refuses a dirty checkout, runs local checks, builds with the exact Git revision, recreates only opencodebot, and runs
live smoke. The same npm command can be launched from PowerShell when Docker Desktop is the deployment host; only the
unattended systemd runner remains Linux-specific.

Operational checks:

```bash
npm run check
npm test
npm run smoke
systemctl --user status opencodebot-update.path
docker compose ps
docker compose logs --since=2m opencodebot
npm run smoke:live
```

In Telegram, `/update` should report the current labelled revision when GitHub has no newer commit. Do not manufacture a
remote update on the production branch merely to test the button. Runner validation and callback/file protocol are
covered by local smoke invariants; the next real approved commit exercises the complete apply path.
