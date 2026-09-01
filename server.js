"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const MULTIPLIER_LABEL = "0805";
const MULTIPLIER = 805;
const CHUNK_SIZE = 5;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PADDING_VALUE = 64;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DIGIT_PATTERN = /^\d+$/;
const INDEX_FILE = path.join(__dirname, "index.html");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = parsePort(process.env.PORT || "3000");
const MAX_BODY_BYTES = positiveInteger(process.env.MAX_BODY_BYTES, 8 * 1024 * 1024);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePort(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 3000;
}

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function valueFromBase64Char(character) {
  if (character === "=") {
    return PADDING_VALUE;
  }
  const index = BASE64_ALPHABET.indexOf(character);
  if (index === -1) {
    throw new ValidationError("Érvénytelen Base64 karakter.");
  }
  return index;
}

function base64CharFromValue(value) {
  if (value === PADDING_VALUE) {
    return "=";
  }
  if (Number.isInteger(value) && value >= 0 && value < BASE64_ALPHABET.length) {
    return BASE64_ALPHABET.charAt(value);
  }
  throw new ValidationError("Érvénytelen Base64 érték: " + String(value) + ".");
}

function validateBase64(base64) {
  if (base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) {
    throw new ValidationError("Érvénytelen Base64 padding.");
  }
}

function encodeText(text) {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  let encoded = "";
  for (let i = 0; i < base64.length; i += 1) {
    const product = valueFromBase64Char(base64.charAt(i)) * MULTIPLIER;
    encoded += String(product).padStart(CHUNK_SIZE, "0");
  }
  return {
    encoded,
    base64
  };
}

function decodeData(input) {
  const clean = String(input).replace(/\s+/g, "");
  if (clean.length === 0) {
    return {
      text: "",
      base64: ""
    };
  }
  if (!DIGIT_PATTERN.test(clean)) {
    throw new ValidationError("Csak számjegyek, szóközök és sortörések lehetnek benne.");
  }
  if (clean.length % CHUNK_SIZE !== 0) {
    throw new ValidationError("A kód hossza nem osztható 5-tel.");
  }
  let base64 = "";
  for (let i = 0; i < clean.length; i += CHUNK_SIZE) {
    const block = clean.slice(i, i + CHUNK_SIZE);
    const product = Number(block);
    const blockIndex = i / CHUNK_SIZE + 1;
    if (!Number.isInteger(product) || product % MULTIPLIER !== 0) {
      throw new ValidationError("Érvénytelen 0805 blokk a(z) " + String(blockIndex) + ". helyen.");
    }
    const base64Value = product / MULTIPLIER;
    base64 += base64CharFromValue(base64Value);
  }
  validateBase64(base64);
  let text;
  try {
    text = UTF8_DECODER.decode(Buffer.from(base64, "base64"));
  } catch (error) {
    throw new ValidationError("A visszafejtett adat nem érvényes UTF-8 szöveg.");
  }
  return {
    text,
    base64
  };
}

function commonHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; object-src 'none'; form-action 'none'"
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function mergeHeaders() {
  const merged = {};
  for (let i = 0; i < arguments.length; i += 1) {
    const source = arguments[i] || {};
    Object.keys(source).forEach((key) => {
      merged[key] = source[key];
    });
  }
  return merged;
}

function sendJson(res, statusCode, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  const headers = mergeHeaders(commonHeaders(), corsHeaders(), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  }, extraHeaders);
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendText(res, statusCode, text) {
  const body = Buffer.from(text, "utf8");
  const headers = mergeHeaders(commonHeaders(), {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length
  });
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendNoContent(res, statusCode, extraHeaders) {
  const headers = mergeHeaders(commonHeaders(), extraHeaders);
  res.writeHead(statusCode, headers);
  res.end();
}

function sendApiNoContent(res, statusCode) {
  const headers = mergeHeaders(commonHeaders(), corsHeaders(), {
    "Cache-Control": "no-store"
  });
  res.writeHead(statusCode, headers);
  res.end();
}

function ensureJsonContentType(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType.indexOf("application/json") === -1) {
    throw createHttpError("A Content-Type application/json kell legyen.", 415);
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) {
        return;
      }
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        settled = true;
        req.resume();
        reject(createHttpError("A kérés túl nagy.", 413));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      const body = Buffer.concat(chunks).toString("utf8");
      if (body.trim().length === 0) {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        reject(new ValidationError("Érvénytelen JSON törzs."));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        reject(new ValidationError("A JSON törzs objektum kell legyen."));
        return;
      }
      resolve(parsed);
    });

    req.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

async function serveIndex(req, res) {
  let content;
  try {
    content = await fs.promises.readFile(INDEX_FILE);
  } catch (error) {
    sendText(res, 500, "index.html nem olvasható.");
    return;
  }
  const headers = mergeHeaders(commonHeaders(), {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": content.length
  });
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(content);
  }
}

async function handleEncode(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, {
      ok: false,
      error: "A metódus nem engedélyezett."
    }, {
      "Allow": "POST, OPTIONS"
    });
    return;
  }
  ensureJsonContentType(req);
  const body = await readJsonBody(req);
  if (typeof body.text !== "string") {
    throw new ValidationError("A text mező szöveg kell legyen.");
  }
  const result = encodeText(body.text);
  sendJson(res, 200, {
    ok: true,
    encoded: result.encoded,
    base64: result.base64,
    factor: MULTIPLIER_LABEL,
    chunkSize: CHUNK_SIZE
  });
}

async function handleDecode(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, {
      ok: false,
      error: "A metódus nem engedélyezett."
    }, {
      "Allow": "POST, OPTIONS"
    });
    return;
  }
  ensureJsonContentType(req);
  const body = await readJsonBody(req);
  const input = typeof body.data === "string" ? body.data : typeof body.encoded === "string" ? body.encoded : null;
  if (input === null) {
    throw new ValidationError("A data mező szöveg kell legyen.");
  }
  const result = decodeData(input);
  sendJson(res, 200, {
    ok: true,
    text: result.text,
    base64: result.base64,
    factor: MULTIPLIER_LABEL,
    chunkSize: CHUNK_SIZE
  });
}

async function handleApi(req, res, requestUrl) {
  if (req.method === "OPTIONS") {
    sendApiNoContent(res, 204);
    return;
  }
  if (requestUrl.pathname === "/api/health") {
    if (req.method !== "GET") {
      sendJson(res, 405, {
        ok: false,
        error: "A metódus nem engedélyezett."
      }, {
        "Allow": "GET, OPTIONS"
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      name: "0805-base64",
      factor: MULTIPLIER_LABEL,
      chunkSize: CHUNK_SIZE
    });
    return;
  }
  if (requestUrl.pathname === "/api/encode") {
    await handleEncode(req, res);
    return;
  }
  if (requestUrl.pathname === "/api/decode") {
    await handleDecode(req, res);
    return;
  }
  sendJson(res, 404, {
    ok: false,
    error: "API útvonal nem található."
  });
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  if (requestUrl.pathname === "/api" || requestUrl.pathname.startsWith("/api/")) {
    await handleApi(req, res, requestUrl);
    return;
  }
  if (requestUrl.pathname === "/favicon.ico") {
    sendNoContent(res, 204, {
      "Cache-Control": "public, max-age=86400"
    });
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    await serveIndex(req, res);
    return;
  }
  sendJson(res, 405, {
    ok: false,
    error: "A metódus nem engedélyezett."
  }, {
    "Allow": "GET, HEAD"
  });
}

function statusCodeFromError(error) {
  const statusCode = Number(error && error.statusCode);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
    return statusCode;
  }
  return error instanceof ValidationError ? 400 : 500;
}

function sendError(res, error) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const statusCode = statusCodeFromError(error);
  const message = statusCode >= 500 ? "Szerverhiba." : error.message || "Hiba.";
  if (statusCode >= 500) {
    console.error(error);
  }
  sendJson(res, statusCode, {
    ok: false,
    error: message
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendError(res, error);
  });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 30000;

server.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

function shutdown() {
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exit(1);
      return;
    }
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(1);
  }, 8000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, HOST, () => {
  console.log("0805 Base64 server listening on http://" + HOST + ":" + String(PORT));
});
