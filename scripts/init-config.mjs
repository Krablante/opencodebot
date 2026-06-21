import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, "..")
const source = path.join(projectRoot, "config.example.json")
const target = process.env.OPENCODEBOT_CONFIG || "/home/bloob/politia/state/projects/tg/opencodebot/config.json"

await fs.mkdir(path.dirname(target), { recursive: true })
try {
  await fs.access(target)
  console.log(`Config already exists: ${target}`)
} catch {
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o600)
  console.log(`Created config: ${target}`)
}
