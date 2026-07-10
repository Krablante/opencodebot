import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { promises as fsp } from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

export async function prepareSavedFilesForServer(files = [], { server, sessionID }) {
  if (!Array.isArray(files) || !files.length) return files
  return Promise.all(files.map((file) => transferSavedFile(file, { server, sessionID })))
}

export function targetUploadPath({ server, sessionID, filename, uniqueID = randomUUID() }) {
  if (!server?.uploadRoot) return ""
  const style = pathStyle(server)
  const segments = [safeSegment(sessionID || "session"), safeSegment(uniqueID), safeFilename(filename || "file")]
  return joinServerPath(server.uploadRoot, segments, style)
}

export function joinServerPath(root, segments, style = "posix") {
  const separator = style === "windows" ? "\\" : "/"
  const cleanRoot = trimTrailingSeparators(String(root || ""), style)
  return [cleanRoot, ...segments.map((segment) => String(segment || "").replace(/[\\/]+/g, "-")).filter(Boolean)].join(separator)
}

export function pathStyle(server) {
  const explicit = server?.pathStyle || server?.transfer?.pathStyle
  if (explicit === "windows" || explicit === "posix") return explicit
  const uploadRoot = String(server?.uploadRoot || server?.home || "")
  if (/^[A-Za-z]:[\\/]/.test(uploadRoot) || uploadRoot.startsWith("\\\\")) return "windows"
  return "posix"
}

async function transferSavedFile(file, { server, sessionID }) {
  if (!file || file.type !== "saved_file" || !file.path || !server?.uploadRoot) return file
  const targetPath = targetUploadPath({ server, sessionID, filename: file.filename })
  await transferFile({ localPath: file.path, targetPath, server })
  return {
    ...file,
    localPath: file.path,
    path: targetPath,
    transferred: true,
  }
}

export async function transferFile({ localPath, targetPath, server }) {
  const transfer = server.transfer || { type: "local" }
  if (transfer.type === "local") {
    await fsp.mkdir(parentPath(targetPath, pathStyle(server)), { recursive: true })
    await fsp.copyFile(localPath, targetPath)
    return
  }
  if (transfer.type === "ssh") {
    await transferFileViaSsh({ localPath, targetPath, server, transfer })
    return
  }
  throw new Error(`unsupported upload transfer type for ${server.id}: ${transfer.type}`)
}

async function transferFileViaSsh({ localPath, targetPath, server, transfer }) {
  const target = sshTarget(transfer)
  const style = pathStyle(server)
  const targetDir = parentPath(targetPath, style)
  if (style === "windows") {
    await run("ssh", [...sshArgs(transfer), target, windowsMkdirCommand(targetDir)])
    await run("scp", [...scpArgs(transfer), localPath, `${target}:${scpRemotePath(targetPath, style)}`])
    return
  }
  await run("ssh", [...sshArgs(transfer), target, `mkdir -p -- ${shellQuote(targetDir)}`])
  await runWithInput("ssh", [...sshArgs(transfer), target, `cat > ${shellQuote(targetPath)}`], localPath)
}

function sshTarget(transfer) {
  const host = transfer.host || transfer.sshHost
  if (!host) throw new Error("ssh upload transfer requires transfer.host")
  return transfer.user ? `${transfer.user}@${host}` : host
}

function sshArgs(transfer) {
  const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"]
  if (transfer.port) args.push("-p", String(transfer.port))
  if (transfer.identityFile) args.push("-i", String(transfer.identityFile))
  return args
}

function scpArgs(transfer) {
  return sshArgs(transfer).map((arg) => (arg === "-p" ? "-P" : arg))
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`))
    })
  })
}

function runWithInput(command, args, inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    createReadStream(inputPath).on("error", reject).pipe(child.stdin)
    child.on("close", (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`))
    })
  })
}

function parentPath(filePath, style) {
  if (style === "windows") {
    const index = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"))
    return index === -1 ? "." : filePath.slice(0, index)
  }
  return path.posix.dirname(filePath)
}

function trimTrailingSeparators(value, style) {
  if (style === "windows") {
    if (/^[A-Za-z]:[\\/]?$/.test(value)) return value.replace("/", "\\")
    if (value.startsWith("\\\\")) return value.replace(/[\\/]+$/, "") || value
  }
  return value.replace(/[\\/]+$/, "") || value
}

function safeSegment(value) {
  const text = String(value || "segment").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return text || shortHash(String(value || "segment"))
}

export function safeFilename(value) {
  const text = String(value || "file")
    .replace(/[\x00-\x1f\x7f/\\]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160)
  return text || "file"
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function scpRemotePath(value, style) {
  if (style === "windows") return String(value).replace(/\\/g, "/")
  return shellQuote(value)
}

function windowsMkdirCommand(dir) {
  const quoted = String(dir).replace(/'/g, "''")
  return `powershell.exe -NoProfile -Command "New-Item -ItemType Directory -Force -LiteralPath '${quoted}' | Out-Null"`
}
