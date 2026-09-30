import { escapeHtml } from "./telegram.mjs"

export function richButton(button) {
  const attribute = (value) => escapeHtml(value).replaceAll('"', "&quot;")
  const style = button.style ? ` style="${escapeHtml(button.style)}"` : ""
  const type = button.url ? "url" : button.copy_text ? "copy_text" : button.disabled ? "disabled" : "callback_data"
  const value = button.url ? ` url="${attribute(button.url)}"` : button.copy_text ? ` text="${attribute(button.copy_text.text)}"` : button.disabled ? "" : ` data="${attribute(button.callback_data)}"`
  return `<tg-button type="${type}"${style}${value}>${escapeHtml(button.text)}</tg-button>`
}

export function buttonRows(rows = []) {
  return rows.filter((row) => row.length).map((row) => `<tg-button-row>${row.map(richButton).join("")}</tg-button-row>`).join("\n")
}

export function richView(text, replyMarkup) {
  return `${text}\n${buttonRows(replyMarkup?.inline_keyboard)}`
}

export function menuTable(rows, headings = []) {
  return `<table striped compact>${headings.length ? `<tr>${headings.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>` : ""}${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</table>`
}

export function localText(ru, en, language) {
  return language === "ru" ? ru : en
}
