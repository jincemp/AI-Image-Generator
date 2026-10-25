import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MCP_SECRET = process.env.MCP_SECRET; // random path segment, acts as a shared secret

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable.");
  process.exit(1);
}
if (!MCP_SECRET) {
  console.error("Missing MCP_SECRET environment variable.");
  process.exit(1);
}

// US dollars per 1M tokens, from https://developers.openai.com/api/docs/pricing
// (checked 25 October 2026). Update this table when OpenAI changes its prices.
const PRICES = {
  "gpt-image-2": { textIn: 5, imageIn: 8, imageOut: 30 },
  "gpt-image-2.5-flare": { textIn: 5, imageIn: 8, imageOut: 30 },
  "gpt-image-2.5-sunburst": { textIn: 5, imageIn: 8, imageOut: 30 },
  "gpt-image-1.5": { textIn: 5, imageIn: 8, imageOut: 32, textOut: 10 },
  "gpt-image-1-mini": { textIn: 2, imageIn: 2.5, imageOut: 8 },
  "chatgpt-image-latest": { textIn: 5, imageIn: 8, imageOut: 32, textOut: 10 },
};

const DEFAULTS = { model: "gpt-image-2", size: "1024x1024", quality: "medium" };
const MIME_TYPES = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
const OPENAI_TIMEOUT_MS = 5 * 60_000; // OpenAI says complex prompts can take up to 2 minutes
const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024; // OpenAI's limit per input image

// Images this server made recently, so edit_image can take them by ID. They
// live in memory only, so IDs stop working after a restart. The oldest are
// dropped once the total size passes IMAGE_CACHE_MB.
const imageStore = new Map(); // id -> { buffer, format }
const IMAGE_CACHE_BYTES = (Number(process.env.IMAGE_CACHE_MB) || 100) * 1024 * 1024;
let imageStoreBytes = 0;

function storeImage(buffer, format) {
  const id = `img_${randomBytes(6).toString("hex")}`;
  imageStore.set(id, { buffer, format });
  imageStoreBytes += buffer.length;
  for (const [oldId, old] of imageStore) {
    if (imageStoreBytes <= IMAGE_CACHE_BYTES) break;
    imageStore.delete(oldId);
    imageStoreBytes -= old.buffer.length;
  }
  return id;
}

// Checks the file's first bytes rather than trusting a URL or header.
function detectFormat(buffer) {
  if (buffer.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

// Turns an image reference into bytes. A reference is an image ID from this
// server, an http(s) URL, a data: URL, or plain base64.
async function loadImage(ref) {
  const name = /^(img_|https?:)/i.test(ref) ? ref : "The base64 image";
  let buffer;
  if (imageStore.has(ref)) {
    buffer = imageStore.get(ref).buffer;
  } else if (/^img_[0-9a-f]+$/.test(ref)) {
    throw new Error(
      `Image ID ${ref} was not found. IDs are kept in memory only, so they stop working ` +
        "after the server restarts or once newer images push them out."
    );
  } else if (/^https?:\/\//i.test(ref)) {
    const res = await fetch(ref, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Could not download ${ref}: HTTP ${res.status}`);
    if (Number(res.headers.get("content-length")) > MAX_INPUT_IMAGE_BYTES) {
      throw new Error(`${ref} is larger than 50 MB.`);
    }
    buffer = Buffer.from(await res.arrayBuffer());
  } else {
    buffer = Buffer.from(ref.replace(/^data:[^,]*,/, ""), "base64");
  }
  if (buffer.length > MAX_INPUT_IMAGE_BYTES) throw new Error(`${name} is larger than 50 MB.`);
  const format = detectFormat(buffer);
  if (!format) throw new Error(`${name} is not a PNG, JPEG or WebP image.`);
  return { buffer, format };
}

function describeCost(model, usage) {
  if (!usage) return "Cost: unknown, because OpenAI did not report token usage.";
  const price = PRICES[model];
  const imageIn = usage.input_tokens_details?.image_tokens ?? 0;
  const textIn = usage.input_tokens - imageIn;
  const textOut = usage.output_tokens_details?.text_tokens ?? 0;
  const imageOut = usage.output_tokens - textOut;
  const dollars =
    (textIn * price.textIn + imageIn * price.imageIn + imageOut * price.imageOut + textOut * (price.textOut ?? 0)) /
    1e6;
  const tokens = [
    [textIn, "text input"],
    [imageIn, "image input"],
    [imageOut, "image output"],
    [textOut, "text output"],
  ]
    .filter(([count]) => count > 0)
    .map(([count, kind]) => `${count} ${kind}`);
  return `Cost: $${dollars.toFixed(4)} (${tokens.join(", ")} tokens).`;
}

// Images can take minutes. A client that asks for progress updates gets one
// every 15 seconds, which also keeps clients that allow it from timing out.
function startProgressUpdates(extra) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return () => {};
  let progress = 0;
  const timer = setInterval(() => {
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: ++progress, message: "Still working on the image..." },
      })
      .catch(() => {});
  }, 15_000);
  return () => clearInterval(timer);
}

async function callOpenAI(endpoint, { headers, body }, extra) {
  const stopProgressUpdates = startProgressUpdates(extra);
  try {
    const res = await fetch(`https://api.openai.com/v1/images/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...headers },
      body,
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`OpenAI API error (${res.status}): ${await res.text()}`);
    return await res.json();
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`OpenAI did not answer within ${OPENAI_TIMEOUT_MS / 60_000} minutes.`);
    }
    throw err;
  } finally {
    stopProgressUpdates();
  }
}

function imageResult(verb, data, params) {
  if (!data.data?.length) throw new Error("OpenAI returned no image.");
  const format = data.output_format ?? params.output_format ?? "png";
  const ids = data.data.map((image) => storeImage(Buffer.from(image.b64_json, "base64"), format));
  const count = ids.length === 1 ? "1 image" : `${ids.length} images`;
  return {
    content: [
      {
        type: "text",
        text: [
          `${verb} ${count} with ${params.model}, ${data.size ?? params.size}, ` +
            `${data.quality ?? params.quality} quality, ${format}.`,
          `Image ID${ids.length > 1 ? "s" : ""}: ${ids.join(", ")} (pass to edit_image to change or reuse).`,
          describeCost(params.model, data.usage),
        ].join("\n"),
      },
      ...data.data.map((image) => ({ type: "image", data: image.b64_json, mimeType: MIME_TYPES[format] })),
    ],
  };
}

const sharedOptions = {
  model: z
    .enum(Object.keys(PRICES))
    .optional()
    .describe(
      "Image model. Defaults to gpt-image-2. OpenAI suggests gpt-image-2.5-flare for fast, high-quality " +
        "everyday images and gpt-image-2.5-sunburst where editing precision matters most. " +
        "gpt-image-1-mini is the cheapest."
    ),
  quality: z
    .enum(["low", "medium", "high", "xhigh", "max", "auto"])
    .optional()
    .describe(
      "The main cost lever. Defaults to medium. Use 'low' for cheap drafts and 'high' for final assets. " +
        "'xhigh' and 'max' only work with the gpt-image-2.5 models. 'auto' lets the model choose. " +
        "With gpt-image-2 at 1024x1024 an image costs about $0.006 (low), $0.053 (medium) or $0.211 (high)."
    ),
  size: z
    .string()
    .regex(/^(auto|\d+x\d+)$/, "Use 'auto' or WIDTHxHEIGHT, for example 1536x864.")
    .optional()
    .describe(
      "WIDTHxHEIGHT. Defaults to 1024x1024. All models take 1024x1024, 1536x1024 (landscape) and " +
        "1024x1536 (portrait). gpt-image-2 and the gpt-image-2.5 models also take custom sizes: both sides " +
        "divisible by 16, aspect ratio between 1:3 and 3:1, up to 3840x2160 (above 2560x1440 is " +
        "experimental). 'auto' lets the model choose."
    ),
  n: z.number().int().min(1).max(10).optional().describe("How many images to make, 1 to 10. Defaults to 1. Each one is charged."),
  background: z
    .enum(["auto", "opaque", "transparent"])
    .optional()
    .describe("Defaults to auto. 'transparent' needs output_format png or webp, and is a preview feature on gpt-image-2."),
  output_format: z.enum(["png", "jpeg", "webp"]).optional().describe("Defaults to png. jpeg and webp give smaller files."),
  output_compression: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Compression level from 0 to 100, for jpeg and webp only. Defaults to 100."),
};

function buildServer() {
  const server = new McpServer({ name: "openai-image-gen", version: "1.1.0" });

  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate images from a text prompt with OpenAI's image models. Returns the images, an ID for " +
        "each one (to pass to edit_image), and the exact cost of the request.",
      inputSchema: {
        prompt: z.string().max(32000).describe("Description of the image to generate"),
        ...sharedOptions,
        moderation: z
          .enum(["auto", "low"])
          .optional()
          .describe("Content filtering. Defaults to auto. 'low' filters less strictly."),
      },
    },
    async ({ prompt, ...options }, extra) => {
      const params = { ...DEFAULTS, ...options };
      const data = await callOpenAI(
        "generations",
        { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, ...params }) },
        extra
      );
      return imageResult("Generated", data, params);
    }
  );

  server.registerTool(
    "edit_image",
    {
      title: "Edit Image",
      description:
        "Edit images, or use them as references for a new image, with OpenAI's image models. Give the " +
        "images and a prompt saying what to change or make. Returns the new images, an ID for each one, " +
        "and the exact cost of the request.",
      inputSchema: {
        prompt: z.string().max(32000).describe("What to change, or what to make from the reference images"),
        images: z
          .array(z.string())
          .min(1)
          .max(16)
          .describe(
            "1 to 16 PNG, JPEG or WebP images, each under 50 MB. Each entry is an image ID from " +
              "generate_image or edit_image (for example img_1a2b3c4d5e6f), a public http(s) URL, " +
              "or base64 data (plain or as a data: URL)."
          ),
        mask: z
          .string()
          .optional()
          .describe(
            "Optional PNG, given the same way as images, with the same size as the first image. Its fully " +
              "transparent areas mark where to edit. The model treats it as a guide, not an exact boundary."
          ),
        input_fidelity: z
          .enum(["low", "high"])
          .optional()
          .describe(
            "How closely to keep the style and features, especially faces, of the input images. Only for " +
              "gpt-image-1.5 (low or high) and gpt-image-1-mini (low only). Leave out for other models."
          ),
        ...sharedOptions,
      },
    },
    async ({ prompt, images, mask, ...options }, extra) => {
      const params = { ...DEFAULTS, ...options };
      const form = new FormData();
      form.append("prompt", prompt);
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) form.append(key, String(value));
      }
      for (const image of await Promise.all(images.map(loadImage))) {
        form.append("image[]", new Blob([image.buffer], { type: MIME_TYPES[image.format] }), `image.${image.format}`);
      }
      if (mask) {
        const maskImage = await loadImage(mask);
        form.append("mask", new Blob([maskImage.buffer], { type: MIME_TYPES[maskImage.format] }), `mask.${maskImage.format}`);
      }
      const data = await callOpenAI("edits", { body: form }, extra);
      return imageResult("Made", data, params);
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// sessionId -> { transport, lastSeen }, so follow-up requests in the same MCP
// session (tools/list, tools/call, etc.) reach the same transport that was
// created at initialize time. This is the standard pattern real MCP clients expect.
const sessions = {};

// Clients often disconnect without ending their session, so sessions idle
// for longer than this are closed to stop them piling up in memory.
const SESSION_IDLE_MS = (Number(process.env.SESSION_IDLE_MINUTES) || 30) * 60_000;

setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const session of Object.values(sessions)) {
    if (session.lastSeen < cutoff) {
      session.transport.close().catch((err) => console.error("Closing idle session failed:", err));
    }
  }
}, Math.min(SESSION_IDLE_MS, 60_000)).unref();

// Sessions only live in memory, so a restart or redeploy forgets them all.
// The MCP spec tells clients to start a new session when they get a 404 for
// their session ID, which is what lets them recover without a manual reconnect.
function sendSessionNotFound(res) {
  res.status(404).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Session not found" },
    id: null,
  });
}

const MCP_PATH = `/mcp/${MCP_SECRET}`; // the secret in the path is the only access control here

app.post(MCP_PATH, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;

  if (sessionId) {
    const session = sessions[sessionId];
    if (!session) {
      sendSessionNotFound(res);
      return;
    }
    session.lastSeen = Date.now();
    transport = session.transport;
  } else if (isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions[newSessionId] = { transport, lastSeen: Date.now() };
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) delete sessions[transport.sessionId];
    };

    const server = buildServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
    return;
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET is used by clients to open a server-to-client notification stream;
// DELETE is used to explicitly end a session. Both need the session ID
// from the initialize response.
async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId) {
    res.status(400).send("Missing session ID");
    return;
  }
  const session = sessions[sessionId];
  if (!session) {
    sendSessionNotFound(res);
    return;
  }
  session.lastSeen = Date.now();
  await session.transport.handleRequest(req, res);
}

app.get(MCP_PATH, handleSessionRequest);
app.delete(MCP_PATH, handleSessionRequest);

app.get("/", (_req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`MCP server listening on port ${port}`));
