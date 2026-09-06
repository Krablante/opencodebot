import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "./config.mjs"
import { OpenCodeClient } from "./opencode.mjs"
import { TelegramClient } from "./telegram.mjs"

const MAX_IDLE_MS = 20 * 60_000

export function createRuntimeHealth(config) {
  const filePath = `${config.paths.statePath}.health.json`
  const snapshot = {
    pid: process.pid,
    revision: process.env.OPENCODEBOT_BUILD_SHA || "unknown",
    stopping: false,
    loops: { telegram: 0, reconcile: 0 },
  }
  let lastWrite = 0
  let pending = Promise.resolve()
  function save(force = false) {
    if (!force && Date.now() - lastWrite < 30_000) return pending
    lastWrite = Date.now()
    pending = pending.catch(() => {}).then(async () => {
      snapshot.processStart ??= await processStart(snapshot.pid)
      const temporary = `${filePath}.${process.pid}.tmp`
      await fs.writeFile(temporary, JSON.stringify(snapshot) + "\n", { mode: 0o600 })
      await fs.rename(temporary, filePath)
    })
    return pending
  }
  return {
    beat(loop) {
      const first = !snapshot.loops[loop]
      snapshot.loops[loop] = Date.now()
      save(first).catch((error) => console.error(`[opencodebot] runtime health write failed: ${error.message}`))
    },
    async stop() {
      snapshot.stopping = true
      await save(true)
    },
  }
}

export async function checkRuntimeHealth(config, { waitMs = 60_000 } = {}) {
  const deadline = Date.now() + waitMs
  while (true) {
    try {
      const snapshot = JSON.parse(await fs.readFile(`${config.paths.statePath}.health.json`, "utf8"))
      if (!Number.isSafeInteger(snapshot.pid) || snapshot.pid <= 0) throw new Error("Invalid runtime PID")
      process.kill(snapshot.pid, 0)
      if (snapshot.processStart !== await processStart(snapshot.pid)) throw new Error("Runtime process has changed")
      if (snapshot.stopping) throw new Error("The bot is stopping")
      if (snapshot.revision !== (process.env.OPENCODEBOT_BUILD_SHA || "unknown")) throw new Error("Runtime revision does not match the image")
      for (const loop of ["telegram", "reconcile"]) {
        if (loop === "reconcile" && config.reconcile.enabled === false) continue
        if (!snapshot.loops?.[loop] || Date.now() - snapshot.loops[loop] > MAX_IDLE_MS) {
          throw new Error(`${loop} has not reported progress`)
        }
      }
      break
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  const telegram = new TelegramClient(config.telegram.token, config.telegram.botApi)
  const opencode = new OpenCodeClient(config)
  await Promise.all([
    telegram.getMe({ timeoutMs: 5000 }),
    ...config.opencode.servers.filter((server) => !server.offlineOk).map((server) =>
      opencode.listSessions(server.id, { mirror: true, limit: 1, timeoutMs: 5000 })),
  ])
  console.log("Runtime healthy: Telegram polling and session recovery are progressing; required backend APIs are reachable.")
}

async function processStart(pid) {
  if (process.platform !== "linux") return undefined
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
  return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkRuntimeHealth(loadConfig(process.argv[2])).catch((error) => {
    console.error(`Runtime health failed: ${error.message}`)
    process.exitCode = 1
  })
}
