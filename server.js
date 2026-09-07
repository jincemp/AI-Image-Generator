import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

function buildServer() {
  const server = new McpServer({ name: "openai-image-gen", version: "1.0.0" });

  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image from a text prompt using OpenAI's gpt-image-2, its current flagship image model. " +
          "Use the quality parameter as the cost/fidelity lever: 'low' for cheap drafts and placeholders, " +
          "'high' for polished final assets. Returns the image directly.",
      inputSchema: {
        prompt: z.string().describe("Description of the image to generate"),
        size: z
          .enum(["1024x1024", "1536x1024", "1024x1536"])
          .optional()
          .describe("Image dimensions. Defaults to 1024x1024."),
        quality: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe(
            "Rendering quality/cost tradeoff, roughly $0.006 (low), $0.05 (medium), $0.21 (high) per image at 1024x1024. Defaults to medium."
          ),
      },
    },
    async ({ prompt, size, quality }) => {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt,
          size: size || "1024x1024",
          quality: quality || "medium",
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          content: [{ type: "text", text: `OpenAI API error (${res.status}): ${errText}` }],
          isError: true,
        };
      }

      const data = await res.json();
      const b64 = data.data[0].b64_json;
      const usedSize = size || "1024x1024";
      const usedQuality = quality || "medium";

      return {
        content: [
          {
            type: "text",
            text: `Generated with gpt-image-2, ${usedSize}, ${usedQuality} quality.`,
          },
          { type: "image", data: b64, mimeType: "image/png" },
        ],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// The random secret in the path is the only access control here.
app.post(`/mcp/${MCP_SECRET}`, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: one transport per request
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: randomUUID(),
      });
    }
  }
});

app.get("/", (_req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`MCP server listening on port ${port}`));
