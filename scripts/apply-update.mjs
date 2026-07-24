#!/usr/bin/env node

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { classifyChangedPaths, isGitRevision } from "../src/update-shared.mjs"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const startedAt = Date.now()

if (isMain(import.meta.url)) {
  await main().catch((error) => {
    console.error(`[opencodebot-update] ${error.stack || error.message || error}`)
    process.exitCode = 1
  })
}

async function main() {
  if (process.platform !== "linux") throw new Error("The unattended host update runner requires Linux and systemd")
  const runtimeDir = path.resolve(process.env.OPENCODEBOT_UPDATE_RUNTIME_DIR || path.join(os.homedir(), "politia", "state", "projects", "tg", "opencodebot", "updates"))
  const repository = process.env.OPENCODEBOT_UPDATE_REPOSITORY || "Krablante/opencodebot"
  const branch = process.env.OPENCODEBOT_UPDATE_BRANCH || "main"
  const requestPath = path.join(runtimeDir, "request.json")
  const processingPath = path.join(runtimeDir, "request.processing.json")
  const statusPath = path.join(runtimeDir, "status.json")
  await fs.mkdir(runtimeDir, { recursive: true })

  try {
    await fs.rename(requestPath, processingPath)
  } catch (error) {
    if (error.code === "ENOENT") return
    throw error
  }

  let request
  let replacementStarted = false
  let previousImage = ""
  let components = { plugin: false, skill: false }
  try {
    request = validateUpdateRequest(JSON.parse(await fs.readFile(processingPath, "utf8")))
    const status = (stage, extra = {}) => writeStatus(statusPath, request.id, stage, extra)

    await status("preparing")
    await ensureCleanCheckout()
    await run("git", ["fetch", "--prune", "origin", branch])
    await verifyRepository(repository, branch, request)
    const changedPaths = (await capture("git", ["diff", "--name-only", `${request.baseSha}..${request.targetSha}`]))
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
    components = classifyChangedPaths(changedPaths)

    const head = (await capture("git", ["rev-parse", "HEAD"])).trim()
    if (head !== request.targetSha) await run("git", ["merge", "--ff-only", request.targetSha])

    await status("installing", { components })
    await run(npmCommand(), ["ci"])
    await status("checking", { components })
    await run(npmCommand(), ["run", "check"])
    await run(npmCommand(), ["run", "smoke"])

    previousImage = await currentContainerImage()
    if (previousImage) await run("docker", ["image", "tag", previousImage, "opencodebot:rollback"])

    await status("building", { components })
    await run("docker", ["compose", "build", "opencodebot"], {
      env: { ...process.env, OPENCODEBOT_BUILD_SHA: request.targetSha },
    })
    await status("restarting", { components })
    replacementStarted = true
    await run("docker", ["compose", "up", "-d", "--no-build", "--no-deps", "--force-recreate", "opencodebot"])
    await status("verifying", { components })
    await run(npmCommand(), ["run", "smoke:live"])

    await status("succeeded", {
      components,
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    })
  } catch (error) {
    let rolledBack = false
    if (replacementStarted && previousImage) {
      try {
        if (request?.id) await writeStatus(statusPath, request.id, "rolling_back", { components })
        await run("docker", ["image", "tag", previousImage, "opencodebot:current"])
        await run("docker", ["compose", "up", "-d", "--no-build", "--no-deps", "--force-recreate", "opencodebot"])
        rolledBack = true
      } catch (rollbackError) {
        console.error(`[opencodebot-update] rollback failed: ${rollbackError.message}`)
      }
    }
    if (request?.id) {
      await writeStatus(statusPath, request.id, "failed", {
        components,
        durationMs: Date.now() - startedAt,
        rolledBack,
        serviceMayHaveChanged: replacementStarted && !rolledBack,
        error: friendlyError(error),
        completedAt: new Date().toISOString(),
      })
    }
    throw error
  } finally {
    await fs.rm(processingPath, { force: true })
  }
}

export function validateUpdateRequest(value) {
  if (!value || typeof value !== "object") throw new Error("Update request must be a JSON object")
  const id = String(value.id || "").trim()
  const baseSha = String(value.baseSha || "").trim().toLowerCase()
  const targetSha = String(value.targetSha || "").trim().toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error("Update request has an invalid id")
  if (!isGitRevision(baseSha) || !isGitRevision(targetSha)) throw new Error("Update request has an invalid Git revision")
  if (baseSha === targetSha) throw new Error("Update request target matches the deployed revision")
  return { id, baseSha, targetSha, requestedAt: value.requestedAt || null }
}

async function ensureCleanCheckout() {
  const status = (await capture("git", ["status", "--porcelain"])).trim()
  if (status) throw new Error("The opencodebot checkout is not clean; automatic update was blocked")
}

async function verifyRepository(repository, branch, request) {
  const remote = (await capture("git", ["remote", "get-url", "origin"])).trim()
  if (githubSlug(remote).toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`origin does not match the configured GitHub repository ${repository}`)
  }
  await run("git", ["cat-file", "-e", `${request.baseSha}^{commit}`])
  await run("git", ["cat-file", "-e", `${request.targetSha}^{commit}`])
  if (!(await succeeds("git", ["merge-base", "--is-ancestor", "HEAD", request.targetSha]))) {
    throw new Error("The target revision cannot be applied as a fast-forward")
  }
  if (!(await succeeds("git", ["merge-base", "--is-ancestor", request.targetSha, `origin/${branch}`]))) {
    throw new Error(`The target revision is not part of origin/${branch}`)
  }
}

function githubSlug(remote) {
  const value = String(remote || "").trim().replace(/\.git$/, "")
  const ssh = /^git@github\.com:(.+\/.+)$/.exec(value)
  if (ssh) return ssh[1]
  try {
    const url = new URL(value)
    if (url.hostname.toLowerCase() === "github.com") return url.pathname.replace(/^\//, "")
  } catch {}
  return ""
}

async function currentContainerImage() {
  const container = (await capture("docker", ["compose", "ps", "-q", "opencodebot"])).trim()
  if (!container) return ""
  return (await capture("docker", ["inspect", "--format={{.Image}}", container])).trim()
}

async function writeStatus(statusPath, id, stage, extra = {}) {
  await writeJsonAtomic(statusPath, {
    id,
    stage,
    updatedAt: new Date().toISOString(),
    ...extra,
  })
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  await fs.rename(temp, filePath)
}

async function run(command, args, options = {}) {
  console.log(`[opencodebot-update] ${command} ${args.join(" ")}`)
  await spawnCommand(command, args, { ...options, stdio: "inherit" })
}

async function capture(command, args) {
  const result = await spawnCommand(command, args, { stdio: ["ignore", "pipe", "pipe"] })
  return result.stdout
}

async function succeeds(command, args) {
  try {
    await spawnCommand(command, args, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
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
      else reject(new Error(`${command} ${args[0] || ""} failed (${signal || `exit ${code}`}): ${stderr.trim()}`))
    })
  })
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}

function friendlyError(error) {
  const home = process.env.HOME
  const message = String(error?.message || error || "Unknown update failure")
  return (home ? message.replaceAll(home, "~") : message).replace(/\s+/g, " ").slice(0, 500)
}

function isMain(url) {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url)
}
