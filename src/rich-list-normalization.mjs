import { fromMarkdown } from "mdast-util-from-markdown"
import { toMarkdown } from "mdast-util-to-markdown"

const VISUAL_INDENT = "\u2003"
const ORDERED_MARKER_GUARD = "\u2060"
const VISUAL_LIST_NODE = "visualList"

export function normalizeNestedRichLists(markdown) {
  const source = String(markdown ?? "")
  if (!source) return source

  try {
    const tree = fromMarkdown(source)
    const replacements = []
    for (const child of tree.children || []) {
      if (!containsNestedList(child) || child.position?.start?.offset === undefined || child.position?.end?.offset === undefined) continue
      replacements.push({
        start: child.position.start.offset,
        end: child.position.end.offset,
        value: serializeBlock(transformNestedLists(child)).trimEnd(),
      })
    }
    if (!replacements.length) return source

    let result = source
    for (const replacement of replacements.reverse()) {
      result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`
    }
    return result
  } catch {
    return source
  }
}

function transformNestedLists(node) {
  if (node.type === "list" && listContainsList(node)) {
    return { type: VISUAL_LIST_NODE, value: renderVisualList(node) }
  }
  if (!Array.isArray(node.children)) return node
  return { ...node, children: node.children.map(transformNestedLists) }
}

function containsNestedList(node, listDepth = 0) {
  const nextDepth = node.type === "list" ? listDepth + 1 : listDepth
  if (nextDepth > 1) return true
  return Array.isArray(node.children) && node.children.some((child) => containsNestedList(child, nextDepth))
}

function listContainsList(list) {
  return (list.children || []).some((child) => containsNodeType(child, "list"))
}

function containsNodeType(node, type) {
  if (node.type === type) return true
  return Array.isArray(node.children) && node.children.some((child) => containsNodeType(child, type))
}

function renderVisualList(list) {
  const writer = createVisualWriter()
  writeList(list, 0, writer)
  return writer.finish()
}

function writeList(list, depth, writer) {
  const start = Number.isInteger(list.start) ? list.start : 1
  for (let index = 0; index < (list.children || []).length; index += 1) {
    const item = list.children[index]
    const marker = list.ordered ? `${start + index}${ORDERED_MARKER_GUARD}.` : "•"
    const indent = VISUAL_INDENT.repeat(depth)
    let wroteItemLine = false

    for (const child of item.children || []) {
      if (child.type === "paragraph") {
        const lines = serializeBlock(child)
          .trimEnd()
          .split("\n")
          .map(stripSerializedHardBreak)
        for (const line of lines) {
          const prefix = wroteItemLine ? `${indent}${VISUAL_INDENT}` : `${indent}${marker} `
          writer.line(`${prefix}${line}`.trimEnd())
          wroteItemLine = true
        }
        continue
      }

      if (child.type === "list") {
        if (!wroteItemLine) {
          writer.line(`${indent}${marker}`)
          wroteItemLine = true
        }
        writeList(child, depth + 1, writer)
        continue
      }

      if (!wroteItemLine) {
        writer.line(`${indent}${marker}`)
        wroteItemLine = true
      }
      writer.block(serializeBlock(transformNestedLists(child)).trimEnd())
    }

    if (!wroteItemLine) writer.line(`${indent}${marker}`)
  }
}

function createVisualWriter() {
  const chunks = []
  let lines = []
  const flushLines = () => {
    if (!lines.length) return
    chunks.push(lines.join("  \n"))
    lines = []
  }
  return {
    line(value) {
      lines.push(value)
    },
    block(value) {
      flushLines()
      if (value) chunks.push(value)
    },
    finish() {
      flushLines()
      return chunks.join("\n\n")
    },
  }
}

function serializeBlock(node) {
  return toMarkdown(
    { type: "root", children: [node] },
    { handlers: { [VISUAL_LIST_NODE]: (visualList) => visualList.value } },
  )
}

function stripSerializedHardBreak(line) {
  let backslashes = 0
  for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index -= 1) backslashes += 1
  return backslashes % 2 === 1 ? line.slice(0, -1) : line
}
