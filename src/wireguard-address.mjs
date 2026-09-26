export function nextPeerAddress(peers, subnet, serverAddress) {
  const [base, prefixText] = String(subnet || "").split("/")
  const prefix = Number(prefixText)
  if (!/^\d{1,2}$/.test(prefixText || "") || prefix < 0 || prefix > 30) {
    throw new Error("wireguard.subnet must be an IPv4 CIDR with usable host addresses")
  }
  const size = 2 ** (32 - prefix)
  const first = Math.floor(ipv4Number(base) / size) * size + 1
  const last = first + size - 3 // Reserve network and broadcast addresses.
  const server = ipv4Number(String(serverAddress || "").split("/")[0])
  if (server < first || server > last) throw new Error("wireguard.serverAddress must be inside wireguard.subnet")
  const used = new Set(peers.map((peer) => peer.address))
  for (let value = first; value <= last; value++) {
    const address = [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".")
    if (value !== server && !used.has(address)) return address
  }
  throw new Error("WireGuard peer subnet is full")
}

function ipv4Number(value) {
  const octets = String(value || "").split(".")
  if (octets.length !== 4 || octets.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
    throw new Error(`Invalid WireGuard IPv4 address: ${value}`)
  }
  return octets.reduce((number, part) => number * 256 + Number(part), 0)
}
