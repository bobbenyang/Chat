import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const charactersDir = path.join(__dirname, "Characters");
const backgroundsDir = path.join(__dirname, "Background");

loadLocalEnv();

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const GLM_CHAT_ENDPOINT = process.env.GLM_CHAT_ENDPOINT || "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const GLM_DEFAULT_MODEL = process.env.GLM_MODEL || "glm-4.7-flash";
const GLM_REQUEST_TIMEOUT_MS = Number(process.env.GLM_REQUEST_TIMEOUT_MS || 30000);

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

    if (url.pathname === "/api/models" && req.method === "POST") {
      const models = await fetchModels();
      return sendJson(res, 200, { models });
    }

    if (url.pathname === "/api/test" && req.method === "POST") {
      const models = await fetchModels();
      return sendJson(res, 200, {
        ok: true,
        message: `Connected. ${models.length} model${models.length === 1 ? "" : "s"} available.`,
        models
      });
    }

    if (url.pathname === "/api/status" && req.method === "GET") {
      return sendJson(res, 200, {
        hasGlmKey: Boolean(getGlmApiKey({ throwIfMissing: false }))
      });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      console.log(`[${new Date().toISOString()}] POST /api/chat`);
      const body = await readJsonBody(req);
      validateChatRequest(body);
      const reply = await generateChatReply(body);
      return sendJson(res, 200, reply);
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

    return serveStatic(url.pathname, res, isHead);
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
    body: JSON.stringify({
      model: model || GLM_DEFAULT_MODEL,
      messages: chatMessages,
      thinking: {
        type: "disabled"
      },
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      stream: false
    })
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

async function fetchModels() {
  getGlmApiKey();
  return [
    {
      id: GLM_DEFAULT_MODEL,
      object: "model",
      owned_by: "glm"
    }
  ];
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
  } else {
    return sendJson(res, 404, { error: "Not found." });
  }

  const normalizedPath = path.normalize(absolutePath);
  const allowedRoots = [publicDir, charactersDir, backgroundsDir];
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
  return {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

function getGlmApiKey({ throwIfMissing = true } = {}) {
  const apiKey = process.env.GLM_API_KEY || process.env.GLM_API;
  if (!apiKey && throwIfMissing) {
    throw createHttpError(500, "GLM_API_KEY is not set on the local server. GLM_API is also accepted.");
  }

  return apiKey;
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
