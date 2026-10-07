import fs from "node:fs/promises"
import path from "node:path"
import { loadConfig } from "../src/config.mjs"
import { StateStore } from "../src/state.mjs"
import { UserSettings } from "../src/user-settings.mjs"
import { OpenCodeClient, OpenCodeHttpError } from "../src/opencode.mjs"
import { createTelegramCommandHandlers } from "../src/commands.mjs"
import { ControlMenu } from "../src/control-menu.mjs"
import { LaunchMenu } from "../src/launch-menu.mjs"
import { FinalVoiceModule } from "../src/final-voice.mjs"
import { configureI18n } from "../src/i18n/index.mjs"
import { richView } from "../src/menu-format.mjs"
import { guideDocument, guidePage } from "../src/user-guide.mjs"
import { renderQuestionCard } from "../src/questions.mjs"

const output = path.resolve(process.argv[2] || "/tmp/opencodez/opencodebot-ui")
await fs.mkdir(output, { recursive: true })
const config = loadConfig(path.resolve("config.example.json"))
for (const id of ["workstation", "laptop", "lab", "backup"]) config.opencode.servers.push({ ...config.opencode.servers[0], id, label: id })
const state = new StateStore(path.join(output, "preview-state.json"))
const opencode = new OpenCodeClient(config)
const settings = new UserSettings({ config, state, opencode })
await settings.initialize()
state.data.telegram.chatId = -1001000000000
state.data.answerStats = { startedAt: Date.now() - 24 * 60 * 60_000, answers: Array.from({ length: 12 }, (_, i) => ({ key: `local:preview:answer-${i}`, at: Date.now() })) }
await state.initializeAnswerStats(config.ui.timeZone)
const queue = { status: () => [], isBusy: () => false }
const voice = new FinalVoiceModule({ config: config.finalVoice, state, telegram: {} })
const menu = new ControlMenu({ config, state, opencode, promptQueue: queue, finalVoice: voice })
menu.serverConnections = new Map(config.opencode.servers.map((server) => [server.id, server.id === "backup" ? "unavailable" : "available"]))
const launch = new LaunchMenu({ config, state, opencode, settings })
const catalog = { entries: [], models: Object.values(config.promptProfiles).map((p) => ({ id: p.model.modelID, name: p.model.providerID === "openai" ? "GPT-6.1 Sol" : "DeepSeek V4.1 Flash", providerID: p.model.providerID, providerName: p.model.providerID, family: p.model.providerID === "openai" ? "Sol" : "DeepSeek", variants: p.model.providerID === "openai" ? ["medium", "high", "xhigh"] : ["low", "high", "max"] })).filter((m, i, list) => list.findIndex((other) => other.id === m.id) === i) }
settings.catalog = async () => catalog
catalog.entries = [
  { id: "builtin:codex_gpt_6_1_sol", name: "Codex · GPT-6.1 Sol" },
  { id: "builtin:default", name: "OpenCode" },
]

const font = await fs.readFile(process.env.OPENCODEBOT_PREVIEW_FONT || "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf").catch(() => null)
const boldFont = await fs.readFile(process.env.OPENCODEBOT_PREVIEW_BOLD_FONT || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf").catch(() => null)
const fontCss = `${font ? `@font-face{font-family:GuideSans;src:url(data:font/ttf;base64,${font.toString("base64")})}` : ""}${boldFont ? `@font-face{font-family:GuideSans;font-weight:600 900;src:url(data:font/ttf;base64,${boldFont.toString("base64")})}` : ""}body{font-family:GuideSans,system-ui,sans-serif}.illustration main{width:310px}.illustration main summary{color:#9bc5e9}.illustration td:first-child{width:38%}@media print{.illustration main{zoom:.85}section:nth-of-type(3){font-size:14px;line-height:1.4}section pre{background:#eef5fa;color:#152b3e;margin:10px 0;padding:10px 14px;break-inside:avoid}}`

const css = `*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#0e1621;color:#f1f4f8}main{max-width:430px;margin:20px auto;background:#182533;border-radius:18px;padding:22px}h2{font-size:24px;font-weight:650;line-height:1.25;margin:0 0 14px}h1{font-size:30px}p{margin:12px 0}table{border-collapse:collapse;width:100%;font-size:13px;margin:15px 0}td,th{text-align:left;vertical-align:top;padding:9px 10px;overflow-wrap:anywhere}tr:nth-child(even){background:#203243}th{color:#92b8dc;font-weight:600}td:first-child{width:35%;color:#9eb7ca}code{font:12px/1.5 ui-monospace,monospace;overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#101c28;padding:14px;border-radius:10px}blockquote{margin:14px 0;padding:12px 14px;background:#203448;border-left:3px solid #6ab2f2;border-radius:5px}details{margin:14px 0}summary{color:#9bc5e9;cursor:pointer}footer{font-size:11px;color:#8197ad;margin:18px 0 0}tg-button-row{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}tg-button{display:inline-block;flex:1;text-align:center;padding:10px 12px;color:#b6dcfa;background:#263f54;border-radius:9px;font-weight:600;font-size:13px;line-height:1.3;min-height:40px;overflow-wrap:anywhere}tg-button[style=primary]{background:#2a79ba;color:white}tg-button[style=success]{background:#2e775b;color:white}tg-button[style=danger]{color:#ffb9bb;background:#65323d}tg-button[style=link]{background:transparent;padding:0;text-align:left;min-height:0;font-weight:500}a{color:#74b7f1}.caption{color:#8dabc3;font-size:12px;text-align:center}section{break-after:page;max-width:670px;margin:0 auto;padding:35px}section:last-child{break-after:auto}.illustration{display:flex;gap:20px;align-items:flex-start;margin-top:24px}.illustration main{width:290px;flex-shrink:0;margin:0;padding:20px}.illustration .annotation{color:#658097;font-size:14px;padding:15px 0} @media print{body{background:white;color:#152b3e;font-size:16px}section{padding:12px 6px}blockquote{background:#eef5fa}td:first-child{color:#456a86}th,summary{color:#315f80}tr:nth-child(even){background:#eef5fa}footer{color:#60829b}.illustration main{color:#f1f4f8;background:#182533}.illustration tr:nth-child(even){background:#203243}.illustration td:first-child{color:#9eb7ca}.illustration footer{color:#8197ad}h1{margin:12px 0 24px} }`
for (const language of ["ru", "en"]) {
  state.data.ui = { language }
  configureI18n({ state, defaultLanguage: language })
  const home = menu.renderHome({ failedServers: new Set(), statuses: new Map() })
  const settingsView = menu.renderSettings()
  state.data.telegram.chatId = -1001000000000
  state.data.bindings = (language === "ru"
    ? ["Обновление проекта", "Проверка сохранения контекста после автоматической компакции", "Фотографии и карта мест", "Исправление интерфейса", "Подготовка следующего релиза", "Планирование задач", "Старая тема"]
    : ["Project update", "Verify context retention after automatic compaction", "Photos and location map", "Interface fixes", "Prepare the next release", "Task planning", "Older topic"])
    .map((title, index) => ({ chatId: state.chatId, topicId: 100 + index, title, topicBaseTitle: title, serverID: "local", sessionID: `preview-${index}`, createdAt: new Date(Date.now() - index * 60_000).toISOString() }))
  const recent = menu.renderSessions({ failedServers: new Set(), statuses: new Map([["local:preview-0", { type: "busy" }]]) })
  const draft = { id: "preview", rev: 0, page: "new", name: "Храмина", serverID: "local", directory: "/home/operator/project", profileName: "sol" }
  const topic = await launch.render(draft)
  const created = await launch.render({ ...draft, page: "created", topicLink: "https://t.me/c/1000000000/100" })
  const input = await launch.render({ ...draft, userId: 42, name: "", inputRequest: { field: "title", prompt: language === "ru" ? "Как назвать новую тему?" : "What should the new topic be called?" } })
  const servers = await launch.render({ ...draft, page: "servers" })
  const modelDraft = { ...draft, page: "models", editing: true, catalog, query: "", profile: config.promptProfiles.sol }
  const models = await launch.render(modelDraft)
  for (const [name, html] of [["home", richView(home.text, home.replyMarkup)], ["settings", richView(settingsView.text, settingsView.replyMarkup)], ["recent", richView(recent.text, recent.replyMarkup)], ["new", topic], ["created", created], ["input", input], ["servers", servers], ["models", models]]) await fs.writeFile(path.join(output, `${name}-${language}.html`), shell(`${name === "home" ? "<style>main>table td:first-child{width:68%}main>table td:last-child{text-align:right}</style>" : ""}<main>${html}</main>`))
  const questionCard = { requestID: "que_preview", status: "pending", revision: 1,
    questions: language === "ru" ? [
      { header: "Жест", question: "Под «тапами для движения» ты имеешь в виду протяжку пальцем по самому холсту или нажатия на кнопки?", options: [
        { label: "Протяжка по холсту", description: "Перемещаю холст жестом пальца" }, { label: "Нажатия на кнопки", description: "Использую кнопки управления" }] },
      { header: "Браузер", question: "В каких браузерах это происходит?", multiple: true, options: [
        { label: "Firefox на Android", description: "Мобильный Firefox" }, { label: "Chrome на Android", description: "Мобильный Chrome" }, { label: "Safari на iPhone", description: "Мобильный Safari" }] },
    ] : [
      { header: "Gesture", question: "By taps to move, do you mean dragging a finger across the canvas or tapping the controls?", options: [
        { label: "Drag across the canvas", description: "Move the canvas with a finger gesture" }, { label: "Tap the controls", description: "Use the movement buttons" }] },
      { header: "Browser", question: "Which browsers does this happen in?", multiple: true, options: [
        { label: "Firefox on Android", description: "Mobile Firefox" }, { label: "Chrome on Android", description: "Mobile Chrome" }, { label: "Safari on iPhone", description: "Mobile Safari" }] },
    ] }
  const selectedQuestion = { ...questionCard, step: 1, selections: [[0], [0]], customAnswers: ["", language === "ru" ? "Ещё в Firefox на планшете" : "Also Firefox on my tablet"] }
  const questionStates = [["first", questionCard], ["multiple", selectedQuestion],
    ["input", { ...selectedQuestion, input: { messageId: 1 } }], ["review", { ...selectedQuestion, step: 2 }],
    ["done", { ...selectedQuestion, status: "answered", answers: [[questionCard.questions[0].options[0].label], [questionCard.questions[1].options[0].label, selectedQuestion.customAnswers[1]]] }]]
  for (const [name, record] of questionStates) await fs.writeFile(path.join(output, `question-${name}-${language}.html`), shell(`<style>.question footer{margin:4px 0 12px;font-size:12px}.question h3{margin:20px 0 6px}.question tg-button[disabled]{opacity:.45}</style><main class="question">${renderQuestionCard(record)}</main>`))
  for (let index = 0; index < guidePage(0, language).total; index += 1) {
    const page = menu.renderHelp(index)
    await fs.writeFile(path.join(output, `help-${index + 1}-${language}.html`), shell(`<main>${richView(page.text, page.replyMarkup)}</main>`))
  }
  const guide = guideDocument(language).replace(/<h1>[^\p{L}]+/gu, "<h1>").replace(/🎙/g, "").replace(/<details>/g, "<details open>").replace("</section>", `<div class="illustration"><main>${topic.replace(/🎲 /g, "")}</main><div class="annotation">${language === "ru" ? "Пример создания темы: модель видна целиком, основные действия расположены рядом. Рабочий топик после создания остаётся чистым чатом." : "Topic creation example: the full model ID is visible and actions stay close together. The working topic remains a clean conversation."}</div></div></section>`)
  await fs.writeFile(path.join(output, `guide-${language}.html`), shell(guide))
  // Render the real /session handler for its distinct user-facing states.
  const snapshot = structuredClone(state.data)
  state.data.telegram.artifactsTopic = { chatId: state.chatId, topicId: 200, title: "FILES" }
  state.data.telegram.soundsTopic = { chatId: state.chatId, topicId: 201, title: "AUDIO" }
  const binding = { ...state.data.bindings[0], topicTitle: language === "ru" ? "Обновление проекта (local)" : "Project update (local)",
    sessionID: "ses_0123456789abcdefghijklmnopq", directory: "/home/operator/project", promptProfileName: "sol", promptProfile: config.promptProfiles.sol }
  for (const scenario of ["active", "pending", "disabled", "offline", "deleted", "files", "audio", "empty", "unknown-name"]) {
    state.data.bindings = [{ ...binding, disabled: ["pending", "disabled", "files", "audio"].includes(scenario),
      disabledReason: scenario === "disabled" ? "Telegram topic closed" : "topic-reset", topicId: scenario === "files" ? 200 : scenario === "audio" ? 201 : 100 }]
    if (!state.data.bindings[0].disabled) delete state.data.bindings[0].disabledReason
    state.data.pendingTopics = scenario === "pending" ? { 100: { ...binding, sessionID: undefined } } : {}
    const targetTopicId = scenario === "files" ? 200 : scenario === "audio" ? 201 : scenario === "empty" ? 0 : 100
    const knownFilesName = state.data.telegram.artifactsTopic.title
    if (scenario === "unknown-name") state.data.telegram.artifactsTopic.title = null
    const handlers = createTelegramCommandHandlers({ config, state, promptQueue: queue, multipartPrompts: { flushKey: async () => {} },
      opencode: {
        getSession: async () => {
          if (scenario === "offline") throw new Error("Server unavailable")
          if (scenario === "deleted") throw new OpenCodeHttpError({ serverID: "local", pathname: `/session/${binding.sessionID}`, status: 404 })
          return { directory: binding.directory, title: language === "ru" ? "Обновить проект" : "Update the project" }
        },
        sessionStatus: async () => { if (scenario === "offline") throw new Error("Server unavailable"); return { type: "idle" } },
      },
      telegram: { sendRichMessage: async ({ html }) => {
        await fs.writeFile(path.join(output, `session-${scenario}-${language}.html`), shell(`<main>${html}</main>`))
        await fs.writeFile(path.join(output, `session-${scenario}-expanded-${language}.html`), shell(`<main>${html.replace("<details>", "<details open>")}</main>`))
      } },
    })
    await handlers.handle({ chat: { id: state.chatId }, message_thread_id: targetTopicId, message_id: 42 }, { name: "session", args: "" })
    state.data.telegram.artifactsTopic.title = knownFilesName
  }
  state.data = snapshot
}
console.log(`UI previews generated in ${output}`)
function shell(body) { return `<!doctype html><html><head><meta charset="utf-8"><title>OpenCodeBot · Guide</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}${fontCss}@page{size:A4;margin:12mm}@media print{section:nth-of-type(5){font-size:15px;line-height:1.4}section blockquote{break-inside:avoid}}</style></head><body>${body}</body></html>` }
