#!/usr/bin/env node

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const unitDir = path.join(os.homedir(), ".config", "systemd", "user")
const servicePath = path.join(unitDir, "opencodebot-update.service")
const pathUnitPath = path.join(unitDir, "opencodebot-update.path")
const stateDir = path.resolve(optionValue("--state-dir") || process.env.OPENCODEBOT_STATE_DIR || path.join(os.homedir(), "politia", "state", "projects", "tg", "opencodebot"))
const runtimeDir = path.join(stateDir, "updates")

if (process.platform !== "linux") {
  throw new Error("The unattended update runner is available only on the Linux host running opencodebot")
}

const uninstall = process.argv.includes("--uninstall")
if (uninstall) {
  await systemctl(["disable", "--now", "opencodebot-update.path"], { allowFailure: true })
  await fs.rm(servicePath, { force: true })
  await fs.rm(pathUnitPath, { force: true })
  await fs.rm(path.join(runtimeDir, "runner.json"), { force: true })
  await systemctl(["daemon-reload"])
  console.log("Removed the opencodebot update runner.")
  process.exit(0)
}

const repository = optionValue("--repository") || process.env.OPENCODEBOT_UPDATE_REPOSITORY || "Krablante/opencodebot"
const branch = optionValue("--branch") || process.env.OPENCODEBOT_UPDATE_BRANCH || "main"
await fs.mkdir(unitDir, { recursive: true })
await fs.mkdir(runtimeDir, { recursive: true })

const service = `[Unit]
Description=Apply one approved opencodebot update

[Service]
Type=oneshot
UMask=0077
TimeoutStartSec=30min
WorkingDirectory=${pathValue(projectRoot)}
Environment=${unitValue(`OPENCODEBOT_UPDATE_RUNTIME_DIR=${runtimeDir}`)}
Environment=${unitValue(`OPENCODEBOT_UPDATE_REPOSITORY=${repository}`)}
Environment=${unitValue(`OPENCODEBOT_UPDATE_BRANCH=${branch}`)}
ExecStart=/usr/bin/env node ${unitValue(path.join(projectRoot, "scripts", "apply-update.mjs"))}
`

const pathUnit = `[Unit]
Description=Watch for approved opencodebot update requests

[Path]
PathExists=${pathValue(path.join(runtimeDir, "request.json"))}
Unit=opencodebot-update.service

[Install]
WantedBy=default.target
`

await fs.writeFile(servicePath, service, { mode: 0o644 })
await fs.writeFile(pathUnitPath, pathUnit, { mode: 0o644 })
await systemctl(["daemon-reload"])
await systemctl(["enable", "--now", "opencodebot-update.path"])
await systemctl(["is-active", "opencodebot-update.path"])
await writeJsonAtomic(path.join(runtimeDir, "runner.json"), {
  installedAt: new Date().toISOString(),
  projectRoot,
  stateDir,
  repository,
  branch,
  unit: "opencodebot-update.path",
})
console.log(`Installed opencodebot update runner for ${runtimeDir}`)

function unitValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function pathValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(" ", "\\x20")
}

function optionValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ""
}

async function systemctl(args, { allowFailure = false } = {}) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn("systemctl", ["--user", ...args], { stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (status) => resolve(status ?? 1))
  })
  if (code !== 0 && !allowFailure) throw new Error(`systemctl --user ${args.join(" ")} failed with exit ${code}`)
}

async function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  await fs.rename(temp, filePath)
}
