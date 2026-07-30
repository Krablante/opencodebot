import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  inspectOpenCodezPlugin,
  installOpenCodezPlugin,
} from "../src/opencodez-plugin-installer.mjs"

test("OpenCodeBot plugin installer creates and verifies a managed copy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencodebot-plugin-"))
  const configRoot = path.join(root, "config")
  const sourcePath = path.join(root, "source.js")
  await fs.writeFile(sourcePath, "export const plugin = true\n")
  try {
    assert.equal((await inspectOpenCodezPlugin({ configRoot, sourcePath })).status, "missing")
    const installed = await installOpenCodezPlugin({ configRoot, sourcePath })
    assert.equal(installed.status, "current")
    assert.equal(installed.changed, true)
    assert.equal((await fs.stat(installed.targetPath)).mode & 0o777, 0o600)
    const repeated = await installOpenCodezPlugin({ configRoot, sourcePath })
    assert.equal(repeated.status, "current")
    assert.equal(repeated.changed, false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("OpenCodeBot plugin installer updates managed copies and preserves unmanaged files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencodebot-plugin-"))
  const configRoot = path.join(root, "config")
  const sourcePath = path.join(root, "source.js")
  try {
    await fs.writeFile(sourcePath, "export const version = 1\n")
    const installed = await installOpenCodezPlugin({ configRoot, sourcePath })
    await fs.writeFile(sourcePath, "export const version = 2\n")
    assert.equal((await inspectOpenCodezPlugin({ configRoot, sourcePath })).status, "outdated")
    assert.equal((await installOpenCodezPlugin({ configRoot, sourcePath })).status, "current")

    await fs.writeFile(installed.targetPath, "export const owner = 'operator'\n")
    assert.equal((await inspectOpenCodezPlugin({ configRoot, sourcePath })).status, "unmanaged")
    await assert.rejects(
      installOpenCodezPlugin({ configRoot, sourcePath }),
      /refusing to replace unmanaged OpenCodez plugin/u,
    )
    assert.equal(await fs.readFile(installed.targetPath, "utf8"), "export const owner = 'operator'\n")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
