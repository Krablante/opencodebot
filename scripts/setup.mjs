import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomBytes } from "node:crypto"
import readline from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { loadEnvFile } from "../src/config/common.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const composeEnvPath = path.resolve(process.env.OPENCODEBOT_COMPOSE_ENV || path.join(root, ".env"))
const composeEnv = loadEnvFile(composeEnvPath)
const configPath = path.resolve(process.env.OPENCODEBOT_CONFIG || composeEnv.OPENCODEBOT_CONFIG_FILE || path.join(root, "config.local.json"))
const dir = path.dirname(configPath)
const io = readline.createInterface({ input: process.stdin, output: process.stdout })
try {
  const old = await json(configPath, {})
  const tokenPath = composeEnv.OPENCODEBOT_TOKEN_ENV_FILE || path.join(dir, "token.env")
  const serversPath = composeEnv.OPENCODEBOT_SERVERS_FILE || path.join(dir, "servers.json")
  const stateDir = composeEnv.OPENCODEBOT_STATE_DIR || path.join(dir, "state")
  const existing = loadEnvFile(tokenPath)
  const token = existing.OPENCODEBOT_TOKEN || await io.question("Telegram bot token (from BotFather): ")
  const userId = existing.OPENCODEBOT_ALLOWED_USER_IDS || await io.question("Your numeric Telegram user ID: ")
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token.trim()) || !/^\d+(?:[, ]+\d+)*$/.test(userId.trim())) throw new Error("Invalid Telegram token or user ID")
  if (!userId.trim().split(/[, ]+/).every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)) throw new Error("Use positive numeric Telegram user IDs")
  const oldServerData = await json(serversPath, { servers: [] })
  const oldServers = Array.isArray(oldServerData) ? oldServerData : oldServerData.servers || []
  const first = oldServers[0]
  const native = process.argv.includes("--node") || process.platform === "win32"
  const defaultUrl = native ? "http://127.0.0.1:4096" : "http://host.docker.internal:4096"
  const url = first?.url || (await io.question(`OpenCodez URL reachable from the bot [${defaultUrl}]: `)).trim() || defaultUrl
  if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("Use an HTTP(S) OpenCodez URL")
  const password = Object.hasOwn(existing, "OPENCODEZ_SERVER_PASSWORD") ? existing.OPENCODEZ_SERVER_PASSWORD : (await io.question("OpenCodez password (leave blank if authentication is disabled): ")).trim()
  const home = first?.home || (await io.question(`Absolute home directory on the OpenCodez server [${os.homedir()}]: `)).trim() || os.homedir()
  if (!/^\/|^[a-zA-Z]:[\\/]|^\\\\/.test(home)) throw new Error("Use an absolute server home directory")
  const gatewayUrl = old.artifacts?.gatewayUrl || (await io.question(`Artifact gateway URL reachable from OpenCodez [http://${os.hostname()}:8788]: `)).trim() || `http://${os.hostname()}:8788`
  const sshHost = first ? "" : (await io.question("SSH target for incoming files (blank when bot and OpenCodez share the filesystem): ")).trim()
  if (sshHost && !/^[A-Za-z0-9_.@:\[\]-]+$/.test(sshHost)) throw new Error("Invalid SSH target")
  const gateway = new URL(gatewayUrl)
  if (!["http:", "https:"].includes(gateway.protocol) || gateway.username || gateway.password) throw new Error("Use an HTTP(S) gateway URL without embedded credentials")
  const example = await json(path.join(root, "config.example.json"))
  const config = { ...example, ...old, paths: { ...example.paths, ...old.paths, serversJson: old.paths?.serversJson || "servers.json" },
    defaultPrompt: { ...example.defaultPrompt, ...old.defaultPrompt, serverID: old.defaultPrompt?.serverID || first?.id || "local" },
    artifacts: { ...example.artifacts, ...old.artifacts, enabled: true, gatewayUrl },
    telegram: { ...example.telegram, ...old.telegram },
  }
  const env = { ...existing, OPENCODEBOT_TOKEN: token.trim(), OPENCODEBOT_ALLOWED_USER_IDS: userId.trim(), OPENCODEZ_SERVER_PASSWORD: password,
    OPENCODEBOT_ARTIFACT_TOKEN: existing.OPENCODEBOT_ARTIFACT_TOKEN || randomBytes(32).toString("hex") }
  const serverPath = /^[a-zA-Z]:[\\/]|^\\\\/.test(home) ? path.win32 : path.posix
  const oldArtifactRoot = old.artifactUploads?.root
  const artifactRoot = first?.artifactUploadRoot || (oldArtifactRoot ? oldArtifactRoot.startsWith("~/") ? serverPath.join(home, oldArtifactRoot.slice(2)) : oldArtifactRoot : serverPath.join(home, "opencodebot-files"))
  const uploadRoot = first?.uploadRoot || serverPath.join(home, ".opencodebot", "uploads")
  const server = first || { id: "local", label: "OpenCodez", url, home, uploadRoot, artifactUploadRoot: artifactRoot,
    pathStyle: serverPath === path.win32 ? "windows" : "posix", transfer: sshHost ? { type: "ssh", host: sshHost } : { type: "local" } }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
  await write(configPath, JSON.stringify(config, null, 2) + "\n")
  if (!oldServers.length) await write(serversPath, JSON.stringify({ servers: [server] }, null, 2) + "\n")
  await write(tokenPath, Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join("\n") + "\n")
  const local = server.transfer?.type !== "ssh"
  if (local && serverPath !== path.win32) {
    await fs.mkdir(artifactRoot, { recursive: true, mode: 0o700 })
    await fs.mkdir(uploadRoot, { recursive: true, mode: 0o700 })
  }
  const compose = { OPENCODEBOT_CONFIG_FILE: configPath, OPENCODEBOT_SERVERS_FILE: serversPath,
    OPENCODEBOT_TOKEN_ENV_FILE: tokenPath, OPENCODEBOT_STATE_DIR: stateDir,
    ...(local && serverPath !== path.win32 ? { OPENCODEBOT_UPLOAD_ROOT: uploadRoot, OPENCODEBOT_ARTIFACT_UPLOAD_SOURCE: artifactRoot, OPENCODEBOT_ARTIFACT_UPLOAD_ROOT: artifactRoot } : {}),
    ...composeEnv }
  const existingComposeText = await fs.readFile(composeEnvPath, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error })
  const additions = Object.entries(compose).filter(([key]) => !Object.hasOwn(composeEnv, key)).map(([k, v]) => `${k}="${String(v).replaceAll("\\", "/").replaceAll('"', '\\"').replaceAll("$", "$$")}"`).join("\n")
  if (additions) await write(composeEnvPath, `${existingComposeText}${existingComposeText && !existingComposeText.endsWith("\n") ? "\n" : ""}${additions}\n`)
  console.log("Configuration ready. Start with npm run deploy:bot (Docker) or npm start (Node), then add the bot as an administrator to a forum group and run /setup.")
  if (serverPath === path.win32 && local) console.log("Windows server paths: use npm start on Windows, or configure SSH transfer before using a Linux Docker container.")
} finally { io.close() }

async function json(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")) }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error }
}
async function write(file, text) {
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, text, { mode: 0o600 })
  await fs.rename(temp, file)
}
