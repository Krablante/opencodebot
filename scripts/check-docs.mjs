import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const docs = path.join(root, "docs")
const languages = (await fs.readdir(docs, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
const files = ["README.md", "README.ru.md", "docs/README.md", "plugins/opencodebot-artifacts/README.md", "assets/topic-words.LICENSE.md"]
const errors = []
let reference
for (const language of languages) {
  const topics = (await fs.readdir(path.join(docs, language))).filter((name) => name.endsWith(".md")).sort()
  reference ||= topics
  if (JSON.stringify(topics) !== JSON.stringify(reference)) errors.push(`${language}: topic filenames differ from ${languages[0]}`)
  files.push(...topics.map((topic) => `docs/${language}/${topic}`))
}
const scripts = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).scripts
const texts = new Map()
for (const file of files) texts.set(file, await fs.readFile(path.join(root, file), "utf8"))
for (const [file, text] of texts) {
  for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (/^[a-z]+:|^\/\//i.test(target)) continue
    const [relative, fragment] = target.split("#")
    const resolved = path.resolve(root, path.dirname(file), relative || path.basename(file))
    try { await fs.access(resolved) } catch { errors.push(`${file}: missing ${target}`); continue }
    if (fragment && resolved.endsWith(".md")) {
      const body = await fs.readFile(resolved, "utf8")
      const anchors = new Set([...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replaceAll(" ", "-")))
      for (const [, id] of body.matchAll(/\bid=["']([^"']+)["']/g)) anchors.add(id)
      if (!anchors.has(decodeURIComponent(fragment))) errors.push(`${file}: missing anchor ${target}`)
    }
  }
  for (const [, command] of text.matchAll(/npm run ([\w:-]+)/g)) if (!scripts[command]) errors.push(`${file}: unknown npm command ${command}`)
  for (const [, json] of text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
    try { JSON.parse(json) } catch { errors.push(`${file}: invalid JSON example`) }
  }
}
if (errors.length) throw new Error(errors.join("\n"))
console.log(`Documentation valid: ${languages.join(", ")}; ${files.length} documents, local links, anchors, npm commands and JSON examples.`)
