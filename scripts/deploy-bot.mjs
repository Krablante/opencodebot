#!/usr/bin/env node

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const deployAll = process.argv.includes("--all")
const revision = (await capture("git", ["rev-parse", "HEAD"])).trim().toLowerCase()
const status = (await capture("git", ["status", "--porcelain"])).trim()
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Could not resolve the current Git revision")
if (status) throw new Error("Refusing to deploy from a dirty checkout")

await run(npmCommand(), ["ci"])
await run(npmCommand(), ["run", "check"])
await run(npmCommand(), ["run", "smoke"])
await run("docker", ["compose", "build", ...(deployAll ? [] : ["opencodebot"])], {
  env: { ...process.env, OPENCODEBOT_BUILD_SHA: revision },
})
await run("docker", deployAll
  ? ["compose", "up", "-d", "--no-build"]
  : ["compose", "up", "-d", "--no-build", "--no-deps", "--force-recreate", "opencodebot"])
await run(npmCommand(), ["run", "smoke:live"])
console.log(`Deployed ${deployAll ? "the full Compose project" : "opencodebot"} at ${revision.slice(0, 12)}.`)

async function run(command, args, options = {}) {
  console.log(`[deploy:bot] ${command} ${args.join(" ")}`)
  await spawnCommand(command, args, { ...options, stdio: "inherit" })
}

async function capture(command, args) {
  const result = await spawnCommand(command, args, { stdio: ["ignore", "pipe", "pipe"] })
  return result.stdout
}

function spawnCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, ...options })
    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => { stdout += chunk })
    child.stderr?.on("data", (chunk) => { stderr += chunk })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} failed (${signal || `exit ${code}`}): ${stderr.trim()}`))
    })
  })
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}
