import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MANAGED_HEADER = "// Managed by opencodebot. Use the opencodez plugin installer to update this file.\n"
const TARGET_FILE_NAME = "opencodebot-artifacts.js"

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function defaultSourcePath() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "plugins",
    "opencodebot-artifacts",
    "src",
    "index.js",
  )
}

export function defaultOpenCodezConfigRoot({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const xdgConfigHome = String(env.XDG_CONFIG_HOME || "").trim()
  return path.join(xdgConfigHome || path.join(homeDir, ".config"), "opencodez")
}

export function resolveOpenCodezPluginPaths({
  configRoot = defaultOpenCodezConfigRoot(),
  sourcePath = defaultSourcePath(),
} = {}) {
  if (!path.isAbsolute(configRoot)) throw new Error("OpenCodez config root must be an absolute path")
  if (!path.isAbsolute(sourcePath)) throw new Error("OpenCodeBot plugin source path must be absolute")
  return {
    configRoot,
    sourcePath,
    targetPath: path.join(configRoot, "plugins", TARGET_FILE_NAME),
  }
}

export async function inspectOpenCodezPlugin(options = {}) {
  const paths = resolveOpenCodezPluginPaths(options)
  const sourceBytes = await fs.readFile(paths.sourcePath)
  const expectedBytes = managedPluginBytes(sourceBytes)
  const targetBytes = await readIfExists(paths.targetPath)
  const headerBytes = Buffer.from(MANAGED_HEADER, "utf8")
  const targetManaged = Boolean(targetBytes && targetBytes.subarray(0, headerBytes.length).equals(headerBytes))
  const targetSha256 = targetBytes ? sha256(targetBytes) : null
  const expectedSha256 = sha256(expectedBytes)
  let status = "missing"
  if (targetBytes && targetSha256 === expectedSha256) status = "current"
  else if (targetBytes && targetManaged) status = "outdated"
  else if (targetBytes) status = "unmanaged"
  return {
    ...paths,
    status,
    sourceSha256: sha256(sourceBytes),
    expectedSha256,
    targetSha256,
    targetManaged,
  }
}

export async function installOpenCodezPlugin(options = {}) {
  const before = await inspectOpenCodezPlugin(options)
  if (before.status === "current") return { ...before, changed: false }
  if (before.status === "unmanaged") {
    throw new Error(`refusing to replace unmanaged OpenCodez plugin: ${before.targetPath}`)
  }

  const sourceBytes = await fs.readFile(before.sourcePath)
  const targetBytes = managedPluginBytes(sourceBytes)
  const targetDir = path.dirname(before.targetPath)
  const tempPath = path.join(targetDir, `.${TARGET_FILE_NAME}.${process.pid}.${Date.now()}.tmp`)
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 })
  try {
    await fs.writeFile(tempPath, targetBytes, { flag: "wx", mode: 0o600 })
    await fs.rename(tempPath, before.targetPath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }

  const after = await inspectOpenCodezPlugin(options)
  if (after.status !== "current") throw new Error("OpenCodeBot plugin verification failed after install")
  return { ...after, changed: true }
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

function managedPluginBytes(sourceBytes) {
  return Buffer.concat([Buffer.from(MANAGED_HEADER, "utf8"), sourceBytes])
}
