#!/usr/bin/env node

import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  defaultOpenCodezConfigRoot,
  inspectOpenCodezPlugin,
  installOpenCodezPlugin,
} from "../src/opencodez-plugin-installer.mjs"

export async function main(argv = process.argv.slice(2)) {
  const { command, configRoot } = parseArgs(argv)
  const result = command === "install"
    ? await installOpenCodezPlugin({ configRoot })
    : await inspectOpenCodezPlugin({ configRoot })
  console.log(`status: ${result.status}`)
  console.log(`changed: ${result.changed === true ? "yes" : "no"}`)
  console.log(`source: ${result.sourcePath}`)
  console.log(`target: ${result.targetPath}`)
  console.log(`source_sha256: ${result.sourceSha256}`)
  console.log(`target_sha256: ${result.targetSha256 || "absent"}`)
  if (command === "check" && result.status !== "current") process.exitCode = 1
  return result
}

function parseArgs(argv) {
  const args = [...argv]
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "check"
  if (!["check", "install"].includes(command)) {
    throw new Error("usage: opencodez-plugin.mjs [check|install] [--config-root <absolute-path>]")
  }
  let configRoot = defaultOpenCodezConfigRoot()
  while (args.length) {
    const argument = args.shift()
    if (argument === "--config-root") {
      configRoot = args.shift()
      if (!configRoot) throw new Error("--config-root requires an absolute path")
      continue
    }
    if (argument.startsWith("--config-root=")) {
      configRoot = argument.slice("--config-root=".length)
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }
  return { command, configRoot }
}

const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isEntrypoint) {
  main().catch((error) => {
    console.error(`OpenCodeBot OpenCodez plugin failed: ${error.message}`)
    process.exitCode = 1
  })
}
