import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, "..")
const configSource = path.join(projectRoot, "config.example.json")
const serversSource = path.join(projectRoot, "servers.example.json")
const target = path.resolve(process.env.OPENCODEBOT_CONFIG || path.join(projectRoot, "config.local.json"))
const targetDir = path.dirname(target)
const serversTarget = path.join(targetDir, "servers.json")

await fs.mkdir(targetDir, { recursive: true })
await createConfig()
await createServers()

async function createConfig() {
  try {
    await fs.access(target)
    console.log(`Config already exists: ${target}`)
    return
  } catch {}

  const config = JSON.parse(await fs.readFile(configSource, "utf8"))
  config.paths = { ...config.paths, serversJson: "servers.json" }
  await fs.writeFile(target, JSON.stringify(config, null, 2) + "\n")
  await safeChmod(target, 0o600)
  console.log(`Created config: ${target}`)
}

async function createServers() {
  try {
    await fs.access(serversTarget)
    console.log(`Servers config already exists: ${serversTarget}`)
    return
  } catch {}

  await fs.copyFile(serversSource, serversTarget)
  await safeChmod(serversTarget, 0o600)
  console.log(`Created servers config: ${serversTarget}`)
}

async function safeChmod(filePath, mode) {
  try {
    await fs.chmod(filePath, mode)
  } catch (error) {
    if (process.platform !== "win32") throw error
  }
}
