# WireGuard

WireGuard is optional. opencodebot does not need it for Telegram long polling, `/new`, `/q`, attachments, mirror events, or normal LAN access to OpenCodez. It is only a private tunnel for opening the same LAN OpenCodez web UI from a phone or laptop when you are away from home.

The useful mental model is simple: Telegram keeps working over the public Telegram API, OpenCodez keeps running on your private machine, and WireGuard gives your device a private route back into that LAN. Do not expose OpenCodez itself to the public internet just to use the web UI remotely.

## Shape

```text
phone or laptop away from home
  -> WireGuard tunnel
    -> your home/server LAN
      -> OpenCodez web UI
      -> OpenCodez server selector and cached web assets
```

With OpenCodez, this is especially convenient because the web UI is still the full local UI: selectable System prompts, server selector, and cached frontend behavior work the same way as they do on the LAN. The tunnel only changes how the browser reaches the private address.

## What Must Be Ready

On the server side you need a Linux host:

- A machine running OpenCodez and opencodebot.
- WireGuard installed on that machine: `wg` and `wg-quick` must exist.
- A UDP port forwarded from the router to that machine. The default in `config.example.json` is `51820/udp`.
- A public endpoint for the peer config: either your public IP address or a DNS name that points to it.
- A LAN subnet and DNS value that match your network, not necessarily the sample values in this repo.

On the client side your friend needs:

- The official WireGuard app on iOS, Android, macOS, Windows, or Linux.
- Either a QR code for phones or a `.conf` file for laptops/desktops.
- The OpenCodez web URL to open after the tunnel is active.

## Router Port Forward

WireGuard uses UDP, not TCP. On your router, forward one UDP port from the internet to the machine that runs `wg0`.

The default helper config uses:

```text
external port: 51820/udp
internal host: the OpenCodez/opencodebot machine
internal port: 51820/udp
```

If your ISP/router blocks that port, choose another UDP port and set `wireguard.listenPort` in runtime config before generating peer configs. The port in the peer config must match the forwarded port.

Do not forward OpenCodez's web port directly. The safer pattern is one public UDP WireGuard port, then private HTTP inside the tunnel.

## Runtime Config

The sample WireGuard block is a starting point, not a universal network config:

```json
{
  "wireguard": {
    "enabled": false,
    "interface": "wg0",
    "listenPort": 51820,
    "serverAddress": "10.77.0.1/24",
    "subnet": "10.77.0.0/24",
    "lanSubnet": "192.168.1.0/24",
    "dns": "192.168.1.50",
    "wanInterface": "eno1"
  }
}
```

Adjust these before creating peers:

- `listenPort`: UDP port forwarded on the router.
- `serverAddress` and `subnet`: private WireGuard network. The defaults are fine unless they conflict with your existing networks.
- `lanSubnet`: the LAN range clients should reach through the tunnel, such as `192.168.1.0/24` or `10.0.0.0/24`.
- `dns`: DNS server pushed to clients. This is often the LAN address of your router, Pi-hole, AdGuard, or the OpenCodez host.
- `wanInterface`: host network interface used for outbound LAN/NAT rules, such as `eth0`, `eno1`, or `wlan0`.
- `stateDir`: private runtime storage for server keys, peer configs, and QR images.

`wireguard.enabled` is informational for this project. Running the helper is the action that installs and restarts `wg-quick@<interface>`.

## Server Setup

Initialize WireGuard on the server:

```bash
npm run wireguard -- init
```

The helper creates or reuses the server key, writes a WireGuard config under the configured state directory, installs it into `/etc/wireguard`, enables `wg-quick@wg0`, and restarts the interface. Private keys are written to files, not printed.

Create a peer for a phone or laptop:

```bash
npm run wireguard -- peer alice-phone --endpoint home.example.com
```

You can also set the endpoint through an environment variable:

```bash
WG_ENDPOINT=home.example.com npm run wireguard -- peer alice-laptop
```

Peer files are written under:

```text
<wireguard.stateDir>/peers/
```

For each peer the helper writes:

```text
alice-phone.conf
alice-phone.png   # only when qrencode is installed
```

Create one peer per device. Do not reuse the same peer config for multiple devices; it makes debugging and revocation annoying.

## Giving Access To A Friend

For a phone, send or show the QR code from the generated `.png` file. In the WireGuard mobile app, choose the QR-code import option and scan it.

For a laptop or desktop, send the `.conf` file through a private channel, then import it in the WireGuard app. Treat that file like a password: it contains the client private key.

After import, the friend should:

1. Turn on the tunnel in the WireGuard app.
2. Open the private OpenCodez URL you gave them.
3. If the page does not load, try the direct LAN URL first, then the friendly hostname.
4. Turn the tunnel off when they do not need private access.

The Telegram bot does not need to be restarted when a friend turns the tunnel on or off.

## Testing

From the server:

```bash
sudo systemctl status wg-quick@wg0 --no-pager
sudo wg show
```

From the client, with the tunnel active:

```text
open the OpenCodez LAN URL in a browser
```

If DNS is configured for your LAN name, test the friendly URL too. If the friendly URL fails but the raw LAN IP works, WireGuard is probably fine and DNS/redirect config is the thing to fix.

## Troubleshooting

If the client shows no handshake, check the router port forward, endpoint hostname, endpoint IP, and whether the server firewall allows `listenPort/udp`.

If the client handshakes but cannot open OpenCodez, check `lanSubnet`, host firewall rules, `wanInterface`, and whether the OpenCodez web UI is reachable from another LAN device.

If DNS names do not resolve inside the tunnel, check `wireguard.dns`. Use the LAN IP directly to separate DNS issues from routing issues.

If a peer should lose access, the current helper does not have a revoke command yet. Remove the peer from `<wireguard.stateDir>/peers.json`, regenerate the server config with `npm run wireguard -- init`, and restart the interface. Do not leave old peer configs around indefinitely.

## Boundaries

WireGuard private keys belong under runtime state and `/etc/wireguard`, never in the repo. Peer `.conf` files and QR images are runtime artifacts and should stay out of git.

Keep WireGuard optional. If WireGuard is down, Telegram long polling, `/new`, `/q`, attachments, mirror events, and LAN web should still behave normally. Debug WireGuard as private network access, not as bot runtime.
