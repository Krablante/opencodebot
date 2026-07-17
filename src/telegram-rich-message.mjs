export function normalizeTelegramRichMessage(richMessage) {
  if (!richMessage || !Array.isArray(richMessage.blocks)) return emptyRichMessage()

  const context = {
    blockTypes: new Set(),
    media: [],
    unsupportedTypes: new Set(),
  }
  const text = renderBlocks(richMessage.blocks, context).trim()
  return {
    text,
    media: context.media,
    blockTypes: [...context.blockTypes].sort(),
    unsupportedTypes: [...context.unsupportedTypes].sort(),
  }
}

function renderBlocks(blocks, context) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block) => renderBlock(block, context))
    .filter(Boolean)
    .join("\n\n")
}

function renderBlock(block, context) {
  if (!block || typeof block !== "object") return ""
  const type = String(block.type || "unknown")
  context.blockTypes.add(type)

  switch (type) {
    case "paragraph":
    case "footer":
    case "thinking":
      return renderRichText(block.text)
    case "heading": {
      const text = renderRichText(block.text)
      const level = Math.min(6, Math.max(1, Number(block.size) || 1))
      return text ? `${"#".repeat(level)} ${text}` : ""
    }
    case "pre": {
      const text = renderRichText(block.text)
      if (!text) return ""
      const language = String(block.language || "").trim()
      return `\`\`\`${language}\n${text}\n\`\`\``
    }
    case "divider":
      return "---"
    case "mathematical_expression":
      return String(block.expression || "")
    case "anchor":
      return ""
    case "list":
      return renderList(block.items, context)
    case "blockquote": {
      const body = renderBlocks(block.blocks, context)
      const credit = renderRichText(block.credit)
      return quoteText([body, credit && `— ${credit}`].filter(Boolean).join("\n"))
    }
    case "pullquote":
      return quoteText(renderRichText(block.text))
    case "collage":
    case "slideshow":
      return renderBlocks(block.items, context)
    case "table": {
      const caption = renderRichText(block.caption)
      const body = renderTable(block.cells)
      return [caption, body].filter(Boolean).join("\n")
    }
    case "details": {
      const header = renderRichText(block.summary)
      const body = renderBlocks(block.blocks, context)
      return [header, body].filter(Boolean).join("\n\n")
    }
    case "map": {
      const caption = renderCaption(block.caption)
      const latitude = Number(block.location?.latitude)
      const longitude = Number(block.location?.longitude)
      const location = Number.isFinite(latitude) && Number.isFinite(longitude) ? `Location: ${latitude}, ${longitude}` : ""
      return [caption, location].filter(Boolean).join("\n")
    }
    case "photo": {
      const photo = largestPhoto(block.photo)
      if (photo?.file_id) context.media.push({ kind: "photo", file: photo })
      return renderCaption(block.caption)
    }
    case "animation":
    case "audio":
    case "video":
    case "voice_note":
      context.unsupportedTypes.add(type)
      return renderCaption(block.caption)
    default: {
      context.unsupportedTypes.add(type)
      const ownText = renderRichText(block.text || block.header || block.caption?.text)
      const childText = renderBlocks(block.blocks || block.items, context)
      return [ownText, childText].filter(Boolean).join("\n\n")
    }
  }
}

function renderRichText(value) {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return ""
  if (value.type === "concat") return (value.texts || []).map(renderRichText).join("")

  const visible = renderRichText(value.text)
  if (value.type === "url") return withTarget(visible, value.url)
  if (value.type === "email_address") return withTarget(visible, value.email_address)
  if (value.type === "phone_number") return withTarget(visible, value.phone_number)
  if (visible) return visible
  if (typeof value.text === "string") return value.text
  if (Array.isArray(value.texts)) return value.texts.map(renderRichText).join("")
  return ""
}

function renderList(items, context) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const label = String(item?.label || (item?.value != null ? `${item.value}.` : `${index + 1}.`))
      const checkbox = item?.has_checkbox ? (item.is_checked ? "[x] " : "[ ] ") : ""
      const body = renderBlocks(item?.blocks, context)
      if (!body) return ""
      const lines = body.split("\n")
      return `${label} ${checkbox}${lines[0]}${lines.slice(1).map((line) => `\n  ${line}`).join("")}`
    })
    .filter(Boolean)
    .join("\n")
}

function renderTable(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => (Array.isArray(row) ? row : []).map((cell) => renderRichText(cell?.text).replaceAll("\n", " ")).join(" | "))
    .filter(Boolean)
    .join("\n")
}

function renderCaption(caption) {
  return renderRichText(caption?.text)
}

function largestPhoto(photo) {
  if (!Array.isArray(photo) || !photo.length) return null
  return photo.reduce((largest, item) => {
    const largestArea = Number(largest?.width || 0) * Number(largest?.height || 0)
    const itemArea = Number(item?.width || 0) * Number(item?.height || 0)
    return itemArea >= largestArea ? item : largest
  }, photo[0])
}

function withTarget(visible, target) {
  const label = String(visible || "")
  const value = String(target || "")
  if (!value || label.includes(value)) return label || value
  return label ? `${label} (${value})` : value
}

function quoteText(text) {
  const value = String(text || "")
  if (!value.trim()) return ""
  return value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
}

function emptyRichMessage() {
  return { text: "", media: [], blockTypes: [], unsupportedTypes: [] }
}
