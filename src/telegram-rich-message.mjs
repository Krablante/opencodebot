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
    case "heading":
    case "section_heading": {
      const text = renderRichText(block.text)
      const level = Math.min(6, Math.max(1, Number(block.size) || 1))
      return text ? `${"#".repeat(level)} ${text}` : ""
    }
    case "pre":
    case "preformatted": {
      const text = renderRichText(block.text)
      const language = String(block.language || "").trim()
      const body = text ? `\`\`\`${language}\n${text}\n\`\`\`` : ""
      return joinSections(body, renderCaption(block.caption))
    }
    case "divider":
      return "---"
    case "mathematical_expression":
      return joinSections(String(block.expression || ""), renderCaption(block.caption))
    case "anchor":
      return ""
    case "list":
      return joinSections(renderList(block.items, context), renderCaption(block.caption))
    case "blockquote": {
      const body = renderBlocks(block.blocks, context)
      return joinSections(quoteText(body), renderCredit(block.credit), renderCaption(block.caption))
    }
    case "pullquote":
      return joinSections(quoteText(renderRichText(block.text)), renderCredit(block.credit), renderCaption(block.caption))
    case "collage":
    case "slideshow":
      return joinSections(renderBlocks(block.blocks || block.items, context), renderCaption(block.caption))
    case "table": {
      const body = renderTable(block.rows || block.cells)
      return joinSections(body, renderCaption(block.caption))
    }
    case "details": {
      const header = renderRichText(block.header || block.summary)
      const body = renderBlocks(block.blocks, context)
      return joinSections(header, body)
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
      const ownText = renderRichText(block.text || block.header)
      const expression = String(block.expression || "")
      const childText = renderBlocks(block.blocks || block.items, context)
      return joinSections(ownText, expression, childText, renderCaption(block.caption), renderCredit(block.credit))
    }
  }
}

function renderRichText(value) {
  if (Array.isArray(value)) return value.map(renderRichText).join("")
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return ""
  if (value.type === "concat") return (value.texts || []).map(renderRichText).join("")

  const visible = renderRichText(value.text)
  if (value.type === "url") return withTarget(visible, value.url)
  if (value.type === "email_address") return withTarget(visible, value.email_address)
  if (value.type === "phone_number") return withTarget(visible, value.phone_number)
  if (value.type === "custom_emoji") return String(value.alternative_text || "")
  if (value.type === "mathematical_expression") return String(value.expression || "")
  if (value.type === "anchor") return ""
  if (visible) return visible
  if (typeof value.text === "string") return value.text
  if (Array.isArray(value.texts)) return value.texts.map(renderRichText).join("")
  return ""
}

function renderList(items, context) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const label = renderRichText(item?.label) || String(item?.value != null ? `${item.value}.` : `${index + 1}.`)
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
  if (!caption) return ""
  if (typeof caption === "object" && ("text" in caption || "credit" in caption)) {
    return joinSections(renderRichText(caption.text), renderCredit(caption.credit))
  }
  return renderRichText(caption)
}

function renderCredit(credit) {
  const value = renderRichText(credit)
  return value ? `— ${value}` : ""
}

function joinSections(...values) {
  return values.map((value) => String(value || "").trim()).filter(Boolean).join("\n\n")
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
