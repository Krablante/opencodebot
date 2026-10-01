# Optional WireGuard access

[English](wireguard.md) · [Русский](../ru/wireguard.md) · [All languages](../README.md)

WireGuard gives a remote phone/laptop a private route to the OpenCodez web UI. Telegram polling, sessions, files and LAN access work independently. Use an existing trusted VPN if you already have one; do not expose the OpenCodez port directly to the internet.

## Requirements

The bundled helper operates a Linux host with `wg`, `wg-quick`, systemd, iptables and sudo access. Optional `qrencode` produces a phone QR. Forward one router UDP port to that host, choose a public endpoint and know the actual LAN subnet/DNS/outbound interface. Clients use the official WireGuard app and their own device configuration.

## Configuration

Put network settings in private runtime config. These values are examples; use your actual network:

```json
{ "wireguard": { "enabled": false, "interface": "wg0", "listenPort": 51820,
  "serverAddress": "10.77.0.1/24", "subnet": "10.77.0.0/24",
  "lanSubnet": "10.0.0.0/24", "dns": "10.0.0.1", "wanInterface": "eth0" } }
```

`stateDir` optionally selects private key/peer storage; otherwise it is beside bot state. `serverAddress`/`subnet` define the tunnel network, `lanSubnet` is the client route, `dns` is client DNS and `wanInterface` is the host's LAN/NAT interface. Match `listenPort` to the router's UDP forward. `enabled` is informational: invoking the helper explicitly installs/enables/restarts the interface regardless of that value.

## Server and peers

```bash
npm run wireguard -- init
npm run wireguard -- peer alice-phone --endpoint home.example.com
```

`init` reuses/creates server keys, writes configuration, installs it into `/etc/wireguard` and restarts `wg-quick@<interface>`. `peer` writes the client configuration before registering the peer and installing the server configuration. If host installation fails, the client key is retained and `init` can retry. The helper performs one restart per installation.

`WG_ENDPOINT` can supply the public endpoint instead of `--endpoint`. Each device needs its own peer. Files live in `<stateDir>/peers/<name>.conf` and optional `.png`; private keys are never printed. Send configs/QR only through a private channel and keep them out of Git and diagnostic bundles.

Import the device file or scan the QR, enable the tunnel and open the private OpenCodez URL. The web UI/server selector remains the same. Turning the tunnel on/off requires no bot restart.

## Verification and repair

```bash
sudo systemctl status wg-quick@wg0 --no-pager
sudo wg show
```

No handshake usually means endpoint, UDP forwarding or firewall trouble. Handshake without LAN access points to routes, `wanInterface`, forwarding rules or the web service itself. If a direct LAN IP works but a hostname fails, check DNS separately.

There is no helper revoke command. To revoke a device, remove its entry from private `<stateDir>/peers.json`, run `npm run wireguard -- init`, then remove the obsolete peer config/QR. This is an explicit access change; preserve recovery material when merely disabling a tunnel. VPN troubleshooting does not require restarting the Telegram bot.
