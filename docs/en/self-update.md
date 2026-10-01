# Updates

[English](self-update.md) · [Русский](../ru/self-update.md) · [All languages](../README.md)

The ordinary update path is `git pull --ff-only` and `npm run deploy:bot`. Optional Telegram approval automates the same bot-only rollout through a fixed Linux host runner. It never deploys or restarts OpenCodez, installed plugins or skills.

## Configuration

Scheduled checks are disabled by default. `/update` checks immediately without enabling or moving a schedule. Automatic checks require an explicit time and IANA zone:

```json
{ "updates": { "enabled": true, "repository": "Krablante/opencodebot",
  "branch": "main", "checkAt": "07:00", "timeZone": "Europe/London" } }
```

The scheduler checks once per minute and persists the last calendar date in the chosen zone. Restart after the scheduled time performs a missed check. There is no source-code schedule fallback. The deployed revision comes only from image `OPENCODEBOT_BUILD_SHA`; missing/malformed metadata disables update checks until a correctly labelled deployment.

## Telegram UX

An offer shows deployed/target revisions, grouped notes and GitHub comparison. **Update & restart** approves that exact target. **Not now** suppresses it until the next scheduled calendar day; with scheduling off it closes only the manual offer.

Notes come from the exact Git range: `feat:`, `fix:` and `perf:` become user-facing groups, other subjects collapse into maintenance. Eight entries are shown at most. GitHub releases remain the full published record; there is no duplicate hand-maintained changelog.

The same card advances through verification, dependency installation, syntax, image build, restart and live health. Saved run/message identity lets the new bot finish the original card. A host run stops after 30 minutes; the bot marks stale progress interrupted after 35 minutes and releases its lock for retry.

Compose files and `scripts/apply-update.mjs`/`scripts/install-update-runner.mjs` require manual deployment. The offer lists paths and the appropriate `deploy:bot`/`deploy:all` plus runner installation when needed. Plugin/skill changes report the separate installed-copy follow-up.

## Host boundary

The bot container has neither a Docker socket nor source checkout. Approval writes a UUID and two full Git revisions into atomic files on its state mount:

```text
state/updates/request.json → user systemd.path → scripts/apply-update.mjs
state/updates/status.json  ← fixed host runner ← bot deployment/health
```

The runner checks clean source, origin, branch ancestry and fast-forward safety. Commands use fixed argument arrays; callback data is never shell input. It installs dependencies, checks syntax, tags the existing image for rollback, builds the approved revision, recreates only the bot and runs live health.

If replacement/health fails, it restores the previous image and checks it. Source may remain fast-forwarded; image revision remains authoritative, and retry needs no destructive Git reset. Image rollback does not undo state migrations or external effects. Journal-incompatible revisions, including adding/removing inbox support, need a matching stopped-state backup and manual deployment. [State compatibility](config-runtime.md#paths-and-state) explains rollback to pre-inbox code.

## Install the runner

The checker works on all supported clients; unattended apply requires Linux/systemd on the Compose host. Install once:

```bash
npm run update-runner:install
systemctl --user status opencodebot-update.path
```

State is selected by `--state-dir`, process `OPENCODEBOT_STATE_DIR`, Compose `.env`, or `./state`. It must be the host source mounted as `/app/state`. The installer creates user units under `~/.config/systemd/user` and a non-secret `updates/runner.json` readiness marker.

```bash
npm run update-runner:install -- --state-dir /absolute/host/state
npm run update-runner:uninstall
```

Reinstall after changing repository, branch, checkout or state path. Direct runner execution uses the same state convention, or `OPENCODEBOT_UPDATE_RUNTIME_DIR`; it has no installation-specific path fallback.

## Verify a rollout

```bash
npm run deploy:bot
npm run health:live
docker compose logs --since=2m opencodebot
```

Health inspects the deployed process and required APIs without sending messages. Confirm its image revision matches the committed target. `/update` should report up to date after publication. Do not manufacture a production commit solely to test a button; validation/protocol checks use isolated smoke, and the next real approved update exercises apply.
