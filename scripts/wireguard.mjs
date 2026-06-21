import fs from "node:fs/promises"
import path from "node:path"
import { execFile as execFileCallback } from "node:child_process"
import { spawn } from "node:child_process"
import { promisify } from "node:util"
import { loadConfig } from "../src/config.mjs"

const execFile = promisify(execFileCallback)
const config = loadConfig(process.env.OPENCODEBOT_CONFIG)
const wg = config.wireguard
const command = process.argv[2]

if (!command || !["init", "peer"].includes(command)) {
  usage()
  process.exit(command ? 1 : 0)
}

if (command === "init") await initServer()
if (command === "peer") await createPeer(process.argv[3] || "phone")

async function initServer() {
  await fs.mkdir(wg.stateDir, { recursive: true, mode: 0o700 })
  const serverPrivate = await readOrCreateKey(path.join(wg.stateDir, "server.key"))
  const serverPublic = await publicKey(serverPrivate)
  await fs.writeFile(path.join(wg.stateDir, "server.pub"), serverPublic + "\n", { mode: 0o600 })
  await writeConfig()
  await installConfig()
  console.log("WireGuard server config installed. Private key was not printed.")
}

async function createPeer(name) {
  await fs.mkdir(path.join(wg.stateDir, "peers"), { recursive: true, mode: 0o700 })
  const serverPublic = (await fs.readFile(path.join(wg.stateDir, "server.pub"), "utf8")).trim()
  const peers = await readPeers()
  const existing = peers.find((peer) => peer.name === name)
  if (existing) throw new Error(`Peer already exists: ${name}`)
  const peerPrivate = await genkey()
  const peerPublic = await publicKey(peerPrivate)
  const address = nextPeerAddress(peers)
  const endpoint = await endpointValue()
  peers.push({ name, publicKey: peerPublic, address, createdAt: new Date().toISOString() })
  await writePeers(peers)
  await writeConfig()
  await installConfig()
  const peerConfig = `[Interface]\nPrivateKey = ${peerPrivate}\nAddress = ${address}/32\nDNS = ${wg.dns}\n\n[Peer]\nPublicKey = ${serverPublic}\nEndpoint = ${endpoint}:${wg.listenPort}\nAllowedIPs = ${wg.subnet}, ${wg.lanSubnet}\nPersistentKeepalive = 25\n`
  const peerPath = path.join(wg.stateDir, "peers", `${name}.conf`)
  await fs.writeFile(peerPath, peerConfig, { mode: 0o600 })
  await maybeQr(peerPath, path.join(wg.stateDir, "peers", `${name}.png`))
  await reloadInterface()
  console.log(`Peer created: ${name}`)
  console.log(`Config file: ${peerPath}`)
  console.log("Private key was written to the config file and was not printed.")
}

async function writeConfig() {
  const serverPrivate = (await fs.readFile(path.join(wg.stateDir, "server.key"), "utf8")).trim()
  const peers = await readPeers()
  const lines = [
    "[Interface]",
    `Address = ${wg.serverAddress}`,
    `ListenPort = ${wg.listenPort}`,
    `PrivateKey = ${serverPrivate}`,
    `PostUp = sysctl -w net.ipv4.ip_forward=1; iptables -C FORWARD -i ${wg.interface} -j ACCEPT || iptables -A FORWARD -i ${wg.interface} -j ACCEPT; iptables -C FORWARD -o ${wg.interface} -m state --state RELATED,ESTABLISHED -j ACCEPT || iptables -A FORWARD -o ${wg.interface} -m state --state RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -C POSTROUTING -s ${wg.subnet} -o ${wg.wanInterface} -j MASQUERADE || iptables -t nat -A POSTROUTING -s ${wg.subnet} -o ${wg.wanInterface} -j MASQUERADE`,
    `PostDown = iptables -D FORWARD -i ${wg.interface} -j ACCEPT 2>/dev/null || true; iptables -D FORWARD -o ${wg.interface} -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true; iptables -t nat -D POSTROUTING -s ${wg.subnet} -o ${wg.wanInterface} -j MASQUERADE 2>/dev/null || true`,
    "",
  ]
  for (const peer of peers) {
    lines.push("[Peer]", `# ${peer.name}`, `PublicKey = ${peer.publicKey}`, `AllowedIPs = ${peer.address}/32`, "")
  }
  await fs.writeFile(path.join(wg.stateDir, `${wg.interface}.conf`), lines.join("\n"), { mode: 0o600 })
}

async function installConfig() {
  await execFile("sudo", ["install", "-d", "-m", "700", "-o", "root", "-g", "root", "/etc/wireguard"])
  await execFile("sudo", ["install", "-m", "600", "-o", "root", "-g", "root", path.join(wg.stateDir, `${wg.interface}.conf`), `/etc/wireguard/${wg.interface}.conf`])
  await execFile("sudo", ["systemctl", "enable", `wg-quick@${wg.interface}`])
  await execFile("sudo", ["systemctl", "restart", `wg-quick@${wg.interface}`])
}

async function reloadInterface() {
  await execFile("sudo", ["systemctl", "restart", `wg-quick@${wg.interface}`])
}

async function readOrCreateKey(filePath) {
  try {
    return (await fs.readFile(filePath, "utf8")).trim()
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    const key = await genkey()
    await fs.writeFile(filePath, key + "\n", { mode: 0o600 })
    return key
  }
}

async function genkey() {
  const { stdout } = await execFile("wg", ["genkey"])
  return stdout.trim()
}

async function publicKey(privateKey) {
  return runWithInput("wg", ["pubkey"], privateKey + "\n")
}

function runWithInput(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`${command} failed: ${stderr.trim() || code}`))
    })
    child.stdin.end(input)
  })
}

async function readPeers() {
  try {
    return JSON.parse(await fs.readFile(path.join(wg.stateDir, "peers.json"), "utf8"))
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return []
  }
}

async function writePeers(peers) {
  await fs.writeFile(path.join(wg.stateDir, "peers.json"), JSON.stringify(peers, null, 2) + "\n", { mode: 0o600 })
}

function nextPeerAddress(peers) {
  const used = new Set(peers.map((peer) => peer.address))
  for (let host = 2; host < 255; host++) {
    const address = `10.77.0.${host}`
    if (!used.has(address)) return address
  }
  throw new Error("WireGuard peer subnet is full")
}

async function endpointValue() {
  const argIndex = process.argv.indexOf("--endpoint")
  if (argIndex !== -1 && process.argv[argIndex + 1]) return process.argv[argIndex + 1]
  if (process.env.WG_ENDPOINT) return process.env.WG_ENDPOINT
  const { stdout } = await execFile("curl", ["-fsS", "https://api.ipify.org"])
  return stdout.trim()
}

async function maybeQr(peerPath, qrPath) {
  try {
    await execFile("qrencode", ["-o", qrPath, "-r", peerPath])
    await fs.chmod(qrPath, 0o600)
    console.log(`QR file: ${qrPath}`)
  } catch {
    console.log("qrencode is not installed; peer config was still created.")
  }
}

function usage() {
  console.log("Usage:")
  console.log("  npm run wireguard -- init")
  console.log("  npm run wireguard -- peer phone --endpoint <public-ip-or-name>")
}
