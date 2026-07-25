import { normalizeStringList, numberAtLeast, trimTrailingSlash } from "./common.mjs"

export const DEFAULT_FINAL_VOICE_PROMPT = `Ты готовишь текст для последующей озвучки. На основе предоставленного финального ответа сделай краткое, конкретное и понятное суммари, которое позволит на слух быстро понять всю ситуацию.

Передавай только самое главное: основную суть, ключевые факты, принятые решения, выводы, важные ограничения, проблемы и итоговые рекомендации. Добавляй небольшую долю конкретики только там, где без неё теряется смысл. Не пытайся последовательно пересказать или отзеркалить весь исходный ответ. Не превращай текст в сокращённую версию технической документации. Озвучка должна давать человеку целостное понимание ситуации, а не перечислять все детали работы нейросети.

Без сожаления убирай второстепенные подробности, промежуточные рассуждения, повторы, длинные объяснения, примеры, служебные замечания, несущественные технические детали и всё, что не влияет на понимание общего результата. При этом не пропускай информацию, которая меняет вывод, объясняет причину проблемы, ограничивает возможное решение или необходима для дальнейших действий.

Ничего не выдумывай, не дополняй ответ собственными знаниями и не добавляй сведения, которых нет в исходном тексте. Не меняй смысл, степень уверенности и причинно-следственные связи. Если в исходном ответе что-то не установлено точно, не представляй это как подтверждённый факт.

Пиши полностью на русском языке, естественно, связно и понятно для восприятия на слух. Используй простые человеческие формулировки. Избегай канцелярита, перегруженных предложений, чрезмерной терминологии и сухого технического стиля. Текст должен звучать как спокойное и содержательное объяснение ситуации человеку, который хочет быстро понять, что произошло, почему это важно и к какому результату пришли.

Все цифры, числа, даты, проценты, версии, размеры, единицы измерения и порядковые номера пиши русскими словами с правильными склонениями. Не используй цифровые обозначения.

Все английские слова, названия, сокращения, имена сервисов, программ, моделей, компаний, технологий и команд обязательно записывай кириллицей так, как они произносятся по-русски. Например, «GitHub» нужно писать как «Гитхаб», «Docker» как «Докер», «OpenAI» как «Оупенэйай», а «API» как «эй-пи-ай». Не оставляй латиницу даже в собственных названиях. Если для названия нет общепринятого русского варианта, передай его приблизительное произношение кириллицей. Главная цель — чтобы система озвучки правильно и естественно прочитала текст.

По возможности заменяй англицизмы обычными русскими словами. Однако не заменяй название продукта, программы, модели или технологии на другое понятие. В таких случаях сохраняй само название, но записывай его кириллицей.

Не вставляй исходный код, команды, пути к файлам, интернет-ссылки, адреса сайтов, названия файлов и другие конструкции, которые плохо воспринимаются на слух. Если такая информация критически важна, кратко передай её смысл обычными словами. Технические обозначения сохраняй только тогда, когда без них невозможно понять, о чём идёт речь, и обязательно записывай их в форме, пригодной для русской озвучки.

Ответ должен состоять исключительно из нескольких связных абзацев прозы. Не используй заголовки, списки, маркеры, нумерацию, таблицы, разметку, скобочные примечания, смайлики или эмодзи. Не описывай свои действия, не обращайся к пользователю, не упоминай исходный ответ и не говори, что создаёшь суммари.

Сжимай текст настолько сильно, насколько это возможно без потери основной сути. Итог должен быть заметно короче исходного ответа. Приоритет — общее понимание ситуации, а не полнота перечисления деталей.

СРАЗУ ВЫДАВАЙ ТОЛЬКО ГОТОВЫЙ ТЕКСТ ДЛЯ ОЗВУЧИВАНИЯ.`

const DEFAULT_DEEPSEEK_BODY = {
  max_tokens: 393_216,
  thinking: { type: "enabled" },
  reasoning_effort: "max",
  response_format: { type: "text" },
}

const DEFAULT_INTRO = "Пришло новое сообщение из топика, {topicname}, на сервере, {server}."

export function normalizeFinalVoiceConfig(input = {}, env = process.env) {
  const summaryInput = isObject(input.summary) ? input.summary : {}
  const ttsInput = isObject(input.tts) ? input.tts : {}
  const defaultsInput = isObject(input.defaults)
    ? input.defaults
    : isObject(input.topicDefaults)
      ? input.topicDefaults
      : {}
  const profiles = normalizeProfiles(ttsInput.profiles, env)
  const defaultProfile = profiles[ttsInput.defaultProfile]
    ? String(ttsInput.defaultProfile)
    : Object.keys(profiles)[0] || "silero"
  const summaryKeyEnv = cleanString(summaryInput.apiKeyEnv, "DEEPSEEK_API_KEY")

  return {
    enabled: input.enabled === true,
    summary: {
      baseURL: trimTrailingSlash(summaryInput.baseURL || "https://api.deepseek.com"),
      apiKeyEnv: summaryKeyEnv,
      apiKey: String(env[summaryKeyEnv] || "").trim(),
      model: cleanString(summaryInput.model, "deepseek-v4-flash"),
      defaultPrompt: cleanString(summaryInput.defaultPrompt, DEFAULT_FINAL_VOICE_PROMPT),
      timeoutMs: numberAtLeast(summaryInput.timeoutMs, 900_000, 1_000),
      maxInputChars: numberAtLeast(summaryInput.maxInputChars, 120_000, 1_000),
      maxOutputChars: numberAtLeast(summaryInput.maxOutputChars, 3_000, 100),
      maxResponseBytes: numberAtLeast(summaryInput.maxResponseBytes, 4 * 1024 * 1024, 1_024),
      requestBody: isObject(summaryInput.requestBody)
        ? structuredClone(summaryInput.requestBody)
        : structuredClone(DEFAULT_DEEPSEEK_BODY),
    },
    tts: {
      defaultProfile,
      profiles,
    },
    queue: {
      concurrency: Math.min(numberAtLeast(input.queue?.concurrency, 1, 1), 4),
      maxPending: Math.min(numberAtLeast(input.queue?.maxPending, 8, 1), 100),
    },
    defaults: {
      enabled: defaultsInput.enabled === true,
      minFinalChars: Math.min(numberAtLeast(defaultsInput.minFinalChars, 300, 0), 100_000),
      introTemplate: typeof defaultsInput.introTemplate === "string"
        ? defaultsInput.introTemplate.trim()
        : DEFAULT_INTRO,
    },
  }
}

function normalizeProfiles(value, env) {
  const source = isObject(value) && Object.keys(value).length > 0
    ? value
    : {
        silero: {
          label: "Silero TTS v5.5 RU",
          baseURL: "http://silero-tts-bridge:8000/v1",
          apiKeyEnv: "SILERO_TTS_API_KEY",
          model: "silero-ru-v5.5",
          voices: ["xenia", "eugene"],
          defaultVoice: "xenia",
          responseFormat: "opus",
          speed: 1,
          timeoutMs: 900_000,
          maxResponseBytes: 20 * 1024 * 1024,
        },
      }
  const profiles = {}
  for (const [rawID, rawProfile] of Object.entries(source)) {
    const id = String(rawID).trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) || !isObject(rawProfile)) continue
    const voices = normalizeStringList(rawProfile.voices, [rawProfile.defaultVoice || "alloy"])
    const defaultVoice = voices.includes(String(rawProfile.defaultVoice || ""))
      ? String(rawProfile.defaultVoice)
      : voices[0]
    const apiKeyEnv = cleanString(rawProfile.apiKeyEnv, "")
    profiles[id] = {
      id,
      label: cleanString(rawProfile.label, id),
      baseURL: trimTrailingSlash(rawProfile.baseURL || ""),
      apiKeyEnv,
      apiKey: apiKeyEnv ? String(env[apiKeyEnv] || "").trim() : "",
      model: cleanString(rawProfile.model, ""),
      voices,
      defaultVoice,
      responseFormat: cleanString(rawProfile.responseFormat, "opus").toLowerCase(),
      speed: finiteNumber(rawProfile.speed, 1),
      timeoutMs: numberAtLeast(rawProfile.timeoutMs, 900_000, 1_000),
      maxResponseBytes: numberAtLeast(rawProfile.maxResponseBytes, 20 * 1024 * 1024, 1_024),
    }
  }
  return profiles
}

function cleanString(value, fallback) {
  const clean = typeof value === "string" ? value.trim() : ""
  return clean || fallback
}

function finiteNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
