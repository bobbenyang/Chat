import { createServer } from "node:http";
import { createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const charactersDir = path.join(__dirname, "Characters");
const backgroundsDir = path.join(__dirname, "Background");
const storiesDir = path.join(__dirname, "Stories");
const minigameDir = path.join(__dirname, "Minigame");
const iconsDir = path.join(__dirname, "Icons");
const accountsPath = path.join(__dirname, "Accounts", "users.json");

loadLocalEnv();

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const GLM_CHAT_ENDPOINT = process.env.GLM_CHAT_ENDPOINT || "https://openrouter.ai/api/v1/chat/completions";
const GLM_DEFAULT_MODEL = process.env.GLM_MODEL || "nousresearch/hermes-2-pro-llama-3-8b";
const DEFAULT_MODEL_LIST = [
  "nousresearch/hermes-2-pro-llama-3-8b",
  "deepseek/deepseek-v3.2",
  "deepseek/deepseek-v4-flash"
];
const GLM_MODELS = parseConfiguredModels(process.env.GLM_MODELS, GLM_DEFAULT_MODEL);
const GLM_REQUEST_TIMEOUT_MS = Number(process.env.GLM_REQUEST_TIMEOUT_MS || 55000);
const GLM_STREAM_CONNECT_TIMEOUT_MS = Number(process.env.GLM_STREAM_CONNECT_TIMEOUT_MS || 60000);
const SESSION_COOKIE_NAME = "chat_session";
const SESSION_MAX_AGE_SECONDS = Number(process.env.SESSION_MAX_AGE_SECONDS || 60 * 60 * 24 * 7);
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === "true" ||
  process.env.NODE_ENV === "production" ||
  Boolean(process.env.RENDER);
const LOG_CHAT_MESSAGE_MAX_CHARS = Number(process.env.LOG_CHAT_MESSAGE_MAX_CHARS || 4000);
const ACCOUNTS = loadAccounts();

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const isHead = req.method === "HEAD";

    if (url.pathname === "/api/auth/status" && req.method === "GET") {
      const session = getAuthSession(req);
      return sendJson(res, 200, {
        authEnabled: isAuthEnabled(),
        authenticated: Boolean(session),
        username: session?.username || ""
      });
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const body = await readJsonBody(req);
      const account = verifyAccount(body.username, body.password);
      if (!account) {
        logRequest(req, "auth failed", { username: sanitizeLogValue(body.username) });
        return sendJson(res, 401, { error: "Invalid username or password." });
      }

      setSessionCookie(res, account.username);
      logRequest(req, "auth login", { username: account.username });
      return sendJson(res, 200, { ok: true, username: account.username });
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      clearSessionCookie(res);
      logRequest(req, "auth logout");
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/models" && req.method === "POST") {
      requireAuth(req);
      const models = await fetchModels();
      return sendJson(res, 200, { models });
    }

    if (url.pathname === "/api/test" && req.method === "POST") {
      requireAuth(req);
      const models = await fetchModels();
      return sendJson(res, 200, {
        ok: true,
        message: `Connected. ${models.length} model${models.length === 1 ? "" : "s"} available.`,
        models
      });
    }

    if (url.pathname === "/api/status" && req.method === "GET") {
      requireAuth(req);
      return sendJson(res, 200, {
        hasGlmKey: Boolean(getGlmApiKey({ throwIfMissing: false }))
      });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const session = requireAuth(req);
      const body = await readJsonBody(req);
      validateChatRequest(body);
      logRequest(req, "chat", {
        username: session.username,
        ua: req.headers["user-agent"] || "",
        message: getLatestUserMessage(body)
      });
      await streamChatReply(body, res);
      return;
    }

    if (url.pathname === "/api/characters" && req.method === "GET") {
      const characters = await listCharacters();
      return sendJson(res, 200, { characters });
    }

    if (url.pathname === "/api/backgrounds" && req.method === "GET") {
      const backgrounds = await listBackgrounds();
      return sendJson(res, 200, { backgrounds });
    }

    if (req.method !== "GET" && !isHead) {
      return sendJson(res, 405, { error: "Method not allowed." });
    }

    await serveStatic(url.pathname, res, isHead);
    return;
  } catch (error) {
    const status = error.statusCode || 500;
    console.error(
      `[${new Date().toISOString()}] ${req.method} ${req.url} failed with ${status}: ${error.stack || error.message || error}`
    );
    return sendJson(res, status, {
      error: error.message || "Unexpected server error."
    });
  }
}).listen(PORT, HOST, () => {
  console.log(`GLM chat app running on http://${HOST}:${PORT}`);
});

async function generateChatReply(body) {
  const {
    messages,
    model,
    systemPrompt = "",
    maxTokens = 300,
    temperature = 0.9,
    topP = 0.9
  } = body;
  const apiKey = getGlmApiKey();

  const chatMessages = [];
  if (systemPrompt.trim()) {
    chatMessages.push({ role: "system", content: systemPrompt.trim() });
  }
  chatMessages.push(...messages);

  const response = await fetchWithTimeout(GLM_CHAT_ENDPOINT, {
    method: "POST",
    headers: createGlmHeaders(apiKey),
    body: JSON.stringify(createChatRequestBody({
      model,
      messages: chatMessages,
      maxTokens,
      temperature,
      topP,
      stream: false
    }))
  });

  const payload = await parseResponseBody(response);
  if (!response.ok) {
    throw createHttpError(response.status, describeApiError(payload, "GLM chat completion failed."));
  }

  const text = extractAssistantText(payload);
  if (text) {
    return {
      reply: text,
      endpoint: "glm-chat-completions"
    };
  }

  throw createHttpError(
    502,
    `GLM returned a chat response without assistant text. Raw shape: ${summarizePayload(payload)}`
  );
}

async function streamChatReply(body, res) {
  const {
    messages,
    model,
    systemPrompt = "",
    maxTokens = 300,
    temperature = 0.9,
    topP = 0.9
  } = body;
  const apiKey = getGlmApiKey();

  const chatMessages = [];
  if (systemPrompt.trim()) {
    chatMessages.push({ role: "system", content: systemPrompt.trim() });
  }
  chatMessages.push(...messages);

  const response = await fetchStreamWithConnectTimeout(GLM_CHAT_ENDPOINT, {
    method: "POST",
    headers: createGlmHeaders(apiKey),
    body: JSON.stringify(createChatRequestBody({
      model,
      messages: chatMessages,
      maxTokens,
      temperature,
      topP,
      stream: true
    }))
  });

  if (!response.ok) {
    const payload = await parseResponseBody(response);
    if (response.status === 429) {
      throw createHttpError(429, "Server is busy. Please wait 60 seconds and try again.");
    }
    throw createHttpError(response.status, describeApiError(payload, "GLM chat completion failed."));
  }

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no"
  });

  if (!response.body) {
    const payload = await parseResponseBody(response);
    res.end(extractAssistantText(payload));
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      buffer = writeSseTextEvents(buffer, res);
    }

    buffer += decoder.decode();
    writeSseTextEvents(`${buffer}\n\n`, res);
    res.end();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] GLM stream failed: ${error.stack || error.message || error}`);
    res.destroy(error);
  }
}

async function fetchModels() {
  getGlmApiKey();
  return GLM_MODELS.map((id) => ({
    id,
    object: "model",
    owned_by: "glm"
  }));
}

function parseConfiguredModels(rawModels, defaultModel) {
  const configuredModels = typeof rawModels === "string"
    ? rawModels.split(",").map((model) => model.trim()).filter(Boolean)
    : [];
  const fallbackModels = configuredModels.length > 0 ? configuredModels : DEFAULT_MODEL_LIST;
  const modelIds = [defaultModel, ...fallbackModels].filter(Boolean);

  return [...new Set(modelIds)];
}

async function listCharacters() {
  const entries = await readdir(charactersDir, { withFileTypes: true });
  const globalRelationshipPresets = await readRelationshipPresets(charactersDir, "global relationship presets");
  const characters = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const characterPath = path.join(charactersDir, entry.name);
    const metadata = await readCharacterMetadata(characterPath, entry.name);
    const expressions = await listCharacterExpressions(characterPath, entry.name);
    if (expressions.length === 0) {
      continue;
    }

    const avatarExpression =
      expressions.find((expression) => expression.name.toLowerCase() === "normal") ||
      expressions[0];
    const avatarPath = path.join(characterPath, "Avatar.png");
    let avatar = avatarExpression.image;

    try {
      const avatarStat = await stat(avatarPath);
      if (avatarStat.isFile()) {
        avatar = `/Characters/${encodeURIComponent(entry.name)}/Avatar.png`;
      }
    } catch {
      // Fall back to the normal expression image.
    }

    characters.push({
      id: entry.name.toLowerCase(),
      name: metadata.names.english || entry.name,
      names: metadata.names,
      prompts: metadata.prompts,
      firstLines: metadata.firstLines,
      relationshipPresets: [
        ...(await readRelationshipPresets(characterPath, entry.name)),
        ...globalRelationshipPresets
      ],
      avatar,
      expressions
    });
  }

  return characters.sort((a, b) => a.name.localeCompare(b.name));
}

async function readCharacterMetadata(characterPath, folderName) {
  const fallback = {
    names: {
      english: folderName,
      chinese: folderName
    },
    prompts: {
      english: "",
      chinese: ""
    },
    firstLines: {
      english: "",
      chinese: ""
    }
  };

  try {
    const raw = await readFile(path.join(characterPath, "character.json"), "utf8");
    const parsed = JSON.parse(raw);
    return {
      names: {
        english: readMetadataText(parsed, "english", "name") || fallback.names.english,
        chinese: readMetadataText(parsed, "chinese", "name") || fallback.names.chinese
      },
      prompts: {
        english: readMetadataText(parsed, "english", "prompt"),
        chinese: readMetadataText(parsed, "chinese", "prompt")
      },
      firstLines: {
        english: readMetadataText(parsed, "english", "first_line"),
        chinese: readMetadataText(parsed, "chinese", "first_line")
      }
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read character metadata for ${folderName}: ${error.message}`);
    }
    return fallback;
  }
}

function readMetadataText(metadata, language, key) {
  const value = metadata?.[language]?.[key];
  return typeof value === "string" ? value.trim() : "";
}

async function readRelationshipPresets(characterPath, folderName) {
  try {
    const raw = await readFile(path.join(characterPath, "relationship_presets.json"), "utf8");
    const parsed = JSON.parse(raw);
    const presets = Array.isArray(parsed?.presets) ? parsed.presets : [];

    return presets
      .map((preset, index) => ({
        id: typeof preset.id === "string" && preset.id.trim() ? preset.id.trim() : `preset-${index + 1}`,
        english: readRelationshipPresetLanguage(preset, "english"),
        chinese: readRelationshipPresetLanguage(preset, "chinese")
      }))
      .filter((preset) => preset.english.label || preset.chinese.label);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read relationship presets for ${folderName}: ${error.message}`);
    }
    return [];
  }
}

function readRelationshipPresetLanguage(preset, language) {
  return {
    label: readMetadataText(preset, language, "label"),
    relationship: readMetadataText(preset, language, "relationship"),
    firstLine: readMetadataText(preset, language, "first_line")
  };
}

async function listCharacterExpressions(characterPath, characterName) {
  const expressionOrder = [
    "Normal",
    "Smile",
    "Thinking",
    "Blush",
    "Sad",
    "Angry",
    "Disgust",
    "Seductive",
    "Moaning",
    "Ahegao"
  ];
  const expressionFiles = [];
  const expressionDirs = [characterPath, path.join(characterPath, "Expressions")];

  for (const expressionDir of expressionDirs) {
    let entries;
    try {
      entries = await readdir(expressionDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".png" || entry.name === "Avatar.png") {
        continue;
      }

      const name = path.basename(entry.name, ".png");
      if (expressionFiles.some((expression) => expression.name.toLowerCase() === name.toLowerCase())) {
        continue;
      }

      const relativeDir = path.relative(charactersDir, expressionDir).split(path.sep).map(encodeURIComponent).join("/");
      expressionFiles.push({
        id: name.toLowerCase(),
        name,
        image: `/Characters/${relativeDir}/${encodeURIComponent(entry.name)}`
      });
    }
  }

  return expressionFiles.sort((a, b) => {
    const aIndex = expressionOrder.findIndex((name) => name.toLowerCase() === a.name.toLowerCase());
    const bIndex = expressionOrder.findIndex((name) => name.toLowerCase() === b.name.toLowerCase());
    if (aIndex !== -1 || bIndex !== -1) {
      return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) -
        (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex);
    }
    return a.name.localeCompare(b.name);
  });
}

async function listBackgrounds() {
  const entries = await readdir(backgroundsDir, { withFileTypes: true });
  const backgrounds = [];

  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".png") {
      continue;
    }

    const name = path.basename(entry.name, ".png").replace(/_/g, " ");
    backgrounds.push({
      id: path.basename(entry.name, ".png").toLowerCase(),
      name,
      image: `/Background/${encodeURIComponent(entry.name)}`
    });
  }

  return backgrounds.sort((a, b) => a.name.localeCompare(b.name));
}

async function serveStatic(requestPath, res, isHead = false) {
  const decodedPath = decodeURIComponent(requestPath === "/" ? "/index.html" : requestPath);
  let absolutePath;

  if (decodedPath === "/index.html") {
    absolutePath = path.join(publicDir, "index.html");
  } else if (decodedPath.startsWith("/public/")) {
    absolutePath = path.join(publicDir, decodedPath.slice("/public/".length));
  } else if (decodedPath.startsWith("/Characters/")) {
    absolutePath = path.join(__dirname, decodedPath);
  } else if (decodedPath.startsWith("/Background/")) {
    absolutePath = path.join(__dirname, decodedPath);
  } else if (decodedPath.startsWith("/Stories/")) {
    absolutePath = path.join(__dirname, decodedPath);
  } else if (decodedPath.startsWith("/Minigame/")) {
    absolutePath = path.join(__dirname, decodedPath);
  } else if (decodedPath.startsWith("/Icons/")) {
    absolutePath = path.join(__dirname, decodedPath);
  } else {
    return sendJson(res, 404, { error: "Not found." });
  }

  const normalizedPath = path.normalize(absolutePath);
  const allowedRoots = [publicDir, charactersDir, backgroundsDir, storiesDir, minigameDir, iconsDir];
  if (!allowedRoots.some((root) => normalizedPath.startsWith(root))) {
    return sendJson(res, 403, { error: "Forbidden." });
  }

  try {
    const file = await readFile(normalizedPath);
    const ext = path.extname(normalizedPath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(isHead ? undefined : file);
  } catch (error) {
    if (error.code === "ENOENT") {
      return sendJson(res, 404, { error: "Not found." });
    }
    throw error;
  }
}

function createGlmHeaders(apiKey) {
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };

  if (isOpenRouterEndpoint()) {
    if (process.env.OPENROUTER_SITE_URL) {
      headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
    }
    if (process.env.OPENROUTER_APP_NAME) {
      headers["X-OpenRouter-Title"] = process.env.OPENROUTER_APP_NAME;
    }
  }

  return headers;
}

function getGlmApiKey({ throwIfMissing = true } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.GLM_API_KEY || process.env.GLM_API;
  if (!apiKey && throwIfMissing) {
    throw createHttpError(500, "API key is not set. OPENROUTER_API_KEY, GLM_API_KEY, or GLM_API is required.");
  }

  return apiKey;
}

function createChatRequestBody({ model, messages, maxTokens, temperature, topP, stream }) {
  const payload = {
    model: model || GLM_DEFAULT_MODEL,
    messages,
    max_tokens: maxTokens,
    temperature,
    top_p: topP,
    stream
  };

  if (!isOpenRouterEndpoint()) {
    payload.thinking = {
      type: "disabled"
    };
  }

  return payload;
}

function isOpenRouterEndpoint() {
  return GLM_CHAT_ENDPOINT.includes("openrouter.ai");
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, GLM_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw createHttpError(504, `GLM request timed out after ${GLM_REQUEST_TIMEOUT_MS} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchStreamWithConnectTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, GLM_STREAM_CONNECT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === "AbortError") {
      throw createHttpError(
        504,
        `GLM stream connection timed out after ${GLM_STREAM_CONNECT_TIMEOUT_MS} ms.`
      );
    }
    throw error;
  }
}

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env.local");

  try {
    const envFile = readFileSync(envPath, "utf8");
    for (const line of envFile.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function validateChatRequest(body) {
  if (!body.model || typeof body.model !== "string") {
    throw createHttpError(400, "Model is required.");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw createHttpError(400, "At least one message is required.");
  }
}

function getLatestUserMessage(body) {
  if (!Array.isArray(body?.messages)) {
    return "";
  }

  for (const message of [...body.messages].reverse()) {
    if (message?.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }

  return "";
}

function extractAssistantText(payload) {
  if (!payload) {
    return "";
  }

  if (Array.isArray(payload)) {
    return payload
      .map(extractAssistantText)
      .join("")
      .trim();
  }

  if (typeof payload === "string") {
    return payload.trim();
  }

  if (Array.isArray(payload.output)) {
    return payload.output.join("").trim();
  }

  if (typeof payload.output === "string") {
    return payload.output.trim();
  }

  if (typeof payload.text === "string") {
    return payload.text.trim();
  }

  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const choice = payload.choices[0];
    if (typeof choice.text === "string") {
      return choice.text.trim();
    }

    if (typeof choice.content === "string") {
      return choice.content.trim();
    }

    if (typeof choice.delta?.content === "string") {
      return choice.delta.content.trim();
    }

    if (Array.isArray(choice.delta?.content)) {
      return choice.delta.content
        .map(extractContentPartText)
        .join("")
        .trim();
    }

    if (choice.message && typeof choice.message.content === "string") {
      return choice.message.content.trim();
    }

    if (Array.isArray(choice.message?.content)) {
      return choice.message.content
        .map(extractContentPartText)
        .join("")
        .trim();
    }

    if (Array.isArray(choice.content)) {
      return choice.content
        .map(extractContentPartText)
        .join("")
        .trim();
    }
  }

  return "";
}

function extractAssistantChunkText(payload) {
  if (!payload) {
    return "";
  }

  if (Array.isArray(payload)) {
    return payload.map(extractAssistantChunkText).join("");
  }

  if (typeof payload === "string") {
    return payload;
  }

  if (typeof payload.output === "string") {
    return payload.output;
  }

  if (Array.isArray(payload.output)) {
    return payload.output.join("");
  }

  if (typeof payload.text === "string") {
    return payload.text;
  }

  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const choice = payload.choices[0];
    if (typeof choice.delta?.content === "string") {
      return choice.delta.content;
    }

    if (Array.isArray(choice.delta?.content)) {
      return choice.delta.content.map(extractContentPartText).join("");
    }

    if (typeof choice.message?.content === "string") {
      return choice.message.content;
    }

    if (Array.isArray(choice.message?.content)) {
      return choice.message.content.map(extractContentPartText).join("");
    }

    if (typeof choice.text === "string") {
      return choice.text;
    }
  }

  return "";
}

function extractContentPartText(part) {
  if (typeof part === "string") {
    return part;
  }

  if (typeof part?.text === "string") {
    return part.text;
  }

  if (typeof part?.content === "string") {
    return part.content;
  }

  return "";
}

function writeSseTextEvents(buffer, res) {
  let rest = buffer;

  while (rest) {
    const separator = rest.match(/\r?\n\r?\n/);
    if (!separator) {
      return rest;
    }

    const rawEvent = rest.slice(0, separator.index);
    rest = rest.slice(separator.index + separator[0].length);
    const data = readSseEventData(rawEvent);
    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      const event = JSON.parse(data);
      const text = extractAssistantChunkText(event);
      if (text) {
        res.write(text);
      }
    } catch {
      res.write(data);
    }
  }

  return rest;
}

function readSseEventData(rawEvent) {
  return rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trimEnd();
}

function describeApiError(payload, fallbackMessage) {
  if (!payload) {
    return fallbackMessage;
  }

  if (typeof payload === "string") {
    return payload;
  }

  if (typeof payload.message === "string") {
    return payload.message;
  }

  if (typeof payload.error === "string") {
    return payload.error;
  }

  if (payload.error && typeof payload.error.message === "string") {
    return payload.error.message;
  }

  return fallbackMessage;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(createHttpError(413, "Request body too large."));
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(createHttpError(400, "Request body must be valid JSON."));
      }
    });

    req.on("error", () => {
      reject(createHttpError(400, "Could not read request body."));
    });
  });
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream") || text.includes("\ndata:") || text.startsWith("data:")) {
    return parseSsePayload(text);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseSsePayload(text) {
  const events = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      events.push(JSON.parse(data));
    } catch {
      events.push(data);
    }
  }

  if (events.length === 1) {
    return events[0];
  }

  return events;
}

function summarizePayload(payload) {
  if (!payload) {
    return "null";
  }

  if (typeof payload === "string") {
    return payload.slice(0, 300);
  }

  try {
    return JSON.stringify(payload).slice(0, 300);
  } catch {
    return "[unserializable payload]";
  }
}

function isAuthEnabled() {
  return AUTH_REQUIRED || ACCOUNTS.length > 0;
}

function requireAuth(req) {
  if (!isAuthEnabled()) {
    return { username: "local" };
  }

  const session = getAuthSession(req);
  if (!session) {
    throw createHttpError(401, "Login required.");
  }

  return session;
}

function loadAccounts() {
  const raw = process.env.CHAT_USERS_JSON || readOptionalFile(accountsPath);
  if (!raw) {
    console.warn("No chat accounts configured. API routes are unprotected until CHAT_USERS_JSON or Accounts/users.json is added.");
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    const users = Array.isArray(parsed?.users) ? parsed.users : [];
    return users
      .map(normalizeAccount)
      .filter(Boolean);
  } catch (error) {
    console.warn(`Could not parse chat accounts: ${error.message}`);
    return [];
  }
}

function readOptionalFile(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read ${filePath}: ${error.message}`);
    }
    return "";
  }
}

function normalizeAccount(account) {
  const username = typeof account?.username === "string" ? account.username.trim() : "";
  const salt = typeof account?.salt === "string" ? account.salt.trim() : "";
  const passwordHash = typeof account?.passwordHash === "string" ? account.passwordHash.trim() : "";
  const iterations = Number(account?.iterations || 210000);
  if (!username || !salt || !passwordHash || !Number.isFinite(iterations)) {
    return null;
  }

  return { username, salt, passwordHash, iterations };
}

function verifyAccount(username, password) {
  const normalizedUsername = typeof username === "string" ? username.trim() : "";
  const rawPassword = typeof password === "string" ? password : "";
  if (!normalizedUsername || !rawPassword) {
    return null;
  }

  const account = ACCOUNTS.find((entry) => entry.username === normalizedUsername);
  if (!account) {
    return null;
  }

  const derived = pbkdf2Sync(rawPassword, account.salt, account.iterations, 32, "sha256").toString("base64");
  if (!safeEqual(derived, account.passwordHash)) {
    return null;
  }

  return account;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function getAuthSession(req) {
  if (!isAuthEnabled()) {
    return { username: "local" };
  }

  const token = readCookie(req, SESSION_COOKIE_NAME);
  if (!token) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signSessionPayload(encodedPayload);
  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!payload.username || Number(payload.expiresAt) < Date.now()) {
      return null;
    }

    if (!ACCOUNTS.some((account) => account.username === payload.username)) {
      return null;
    }

    return { username: payload.username };
  } catch {
    return null;
  }
}

function setSessionCookie(res, username) {
  const payload = Buffer.from(JSON.stringify({
    username,
    expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000
  })).toString("base64url");
  const token = `${payload}.${signSessionPayload(payload)}`;
  res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS
  }));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  }));
}

function signSessionPayload(payload) {
  return createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
}

function getSessionSecret() {
  return process.env.SESSION_SECRET || process.env.OPENROUTER_API_KEY || process.env.GLM_API_KEY || process.env.GLM_API || "development-session-secret";
}

function readCookie(req, name) {
  const rawCookie = req.headers.cookie || "";
  for (const part of rawCookie.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    }
  }

  return "";
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.path) {
    parts.push(`Path=${options.path}`);
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  return parts.join("; ");
}

function sanitizeLogValue(value) {
  return String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
}

function formatLogValue(key, value) {
  const maxLength = key === "message" ? LOG_CHAT_MESSAGE_MAX_CHARS : 240;
  const text = sanitizeLogValue(value).slice(0, maxLength);
  const suffix = sanitizeLogValue(value).length > maxLength ? "...[truncated]" : "";
  return JSON.stringify(`${text}${suffix}`);
}

function logRequest(req, action, extra = {}) {
  const extraText = Object.entries(extra)
    .map(([key, value]) => `${key}=${formatLogValue(key, value)}`)
    .join(" ");
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.url} ${action}${extraText ? ` ${extraText}` : ""}`
  );
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function createHttpError(statusCode, message) {
  const error = new Error(summarizeErrorMessage(message));
  error.statusCode = statusCode;
  return error;
}

function summarizeErrorMessage(message) {
  const text = String(message || "Unexpected server error.");
  const title = text.match(/<title>([^<]+)<\/title>/i)?.[1];
  if (title) {
    return title.trim().slice(0, 500);
  }

  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}
