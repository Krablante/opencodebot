import fs from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, "..")
const roots = [path.join(projectRoot, "src"), path.join(projectRoot, "scripts"), path.join(projectRoot, "plugins")]
const files = []

for (const root of roots) {
  await collectMjs(root, files)
}

let failed = false
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" })
  if (result.status !== 0) failed = true
}

if (failed) process.exit(1)

async function collectMjs(dir, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) await collectMjs(entryPath, out)
    else if (entry.isFile() && [".mjs", ".js"].includes(path.extname(entry.name))) out.push(entryPath)
  }
}
