# WireGuard

WireGuard is an optional convenience module for remote private access. It is not the foundation of opencodebot.

The core bot uses Telegram long polling and OpenCodez HTTP/SSE. LAN web access uses the existing private OpenCodez UI and selector. Both work without WireGuard. WireGuard only gives a phone or laptop a private route back to the LAN so the same private web UI can be opened away from home.

## Shape

```text
remote phone or laptop
  -> WireGuard wg0
    -> nuc LAN routes and DNS
      -> code.communism.mom redirect
        -> 192.168.1.50:4098 OpenCodez UI
```

`code.communism.mom` is intentionally a redirect, not a reverse proxy. OpenCodez uses browser origin as the current server, so proxying the UI through another host can make that host look like another OpenCodez server. Redirecting preserves the canonical `nuc` server at `192.168.1.50:4098`.

## Helper

The helper script manages plain WireGuard defaults:

```text
interface: wg0
server address: 10.77.0.1/24
udp port: 51820
client routes: 10.77.0.0/24, 192.168.1.0/24
dns: 192.168.1.50
```

Initialize the server:

```bash
npm run wireguard -- init
```

Create a peer:

```bash
npm run wireguard -- peer phone --endpoint <public-ip-or-name>
```

Peer configs are written under:

```text
/home/bloob/politia/state/projects/tg/opencodebot/wireguard/peers/
```

If `qrencode` is installed, a PNG QR code is written next to the peer config. Private keys are not printed.

## Firewall And Routes

The host firewall must allow WireGuard clients to reach DNS on `53`, the private HTTP redirect on `80`, and the canonical OpenCodez UI on `4098`. Forwarding and NAT from `wg0` to the LAN let the browser reach other OpenCodez servers through the existing selector.

WireGuard private keys belong under Politia state and `/etc/wireguard`, never in the repo. Peer files and QR images are runtime artifacts and should stay out of git.

## Boundaries

Do not make bot behavior depend on WireGuard state. If WireGuard is down, Telegram long polling, `/new`, `/q`, attachments, mirror events, and LAN web should still behave normally. Debug WireGuard as private network access, not as bot runtime.
