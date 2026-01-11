import express from "express";
import fetch from "node-fetch";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation, localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const MCP_HOST = process.env.OPENCODE_MCP_HOST || "0.0.0.0";
const MCP_PORT = parseInt(process.env.OPENCODE_MCP_PORT || "8800", 10);
const MCP_PATH = process.env.OPENCODE_MCP_PATH || "/mcp";
const MCP_API_KEY = process.env.OPENCODE_MCP_KEY || process.env.OPENCODE_MCP_TOKEN || "";
const MCP_ALLOWED_HOSTS = (process.env.OPENCODE_MCP_ALLOWED_HOSTS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL || "http://127.0.0.1:8787";
const OPENCODE_BEARER = process.env.OPENCODE_BEARER || process.env.PROXY_BEARER || "local";
const OPENCODE_TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS || 600000);

const app = express();
app.use(express.json({ limit: "2mb" }));

if (MCP_ALLOWED_HOSTS.length) {
  app.use(hostHeaderValidation(MCP_ALLOWED_HOSTS));
} else {
  const localhostHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (localhostHosts.has(MCP_HOST)) {
    app.use(localhostHostValidation());
  } else if (MCP_HOST === "0.0.0.0" || MCP_HOST === "::") {
    console.warn("[opencode-mcp] Binding to all interfaces without allowed host list; set OPENCODE_MCP_ALLOWED_HOSTS.");
  }
}

if (MCP_API_KEY) {
  app.use((req, res, next) => {
    const k = req.headers["x-api-key"];
    if (!k || k !== MCP_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return next();
  });
} else {
  console.warn("[opencode-mcp] No OPENCODE_MCP_KEY provided; anyone who can reach this port can talk to the MCP server.");
}

/** @type {Map<string, { server: McpServer, transport: StreamableHTTPServerTransport }>} */
const sessions = new Map();

function buildOpencodeUrl(pathname) {
  return new URL(pathname, OPENCODE_BASE_URL).toString();
}

function authHeaders() {
  const headers = {};
  if (OPENCODE_BEARER) headers.authorization = `Bearer ${OPENCODE_BEARER}`;
  return headers;
}

async function callOpencode(path, { method = "GET", body } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), OPENCODE_TIMEOUT_MS);
  try {
    const resp = await fetch(buildOpencodeUrl(path), {
      method,
      headers: { "content-type": "application/json", ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal
    });
    const txt = await resp.text();
    let data;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = txt;
    }
    if (!resp.ok) {
      const err = new Error(`opencode_http_${resp.status}`);
      err.detail = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function opencodeText(data) {
  if (Array.isArray(data?.content)) {
    return data.content
      .map(part => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return typeof data === "string" ? data : "";
}

function buildServer() {
  const server = new McpServer(
    {
      name: "opencode-mcp",
      version: "1.0.0"
    },
    {
      capabilities: { logging: {} }
    }
  );

  server.registerResource(
    "opencode-health",
    "opencode://health",
    { mimeType: "application/json" },
    async () => {
      const health = await callOpencode("/health").catch(err => {
        throw new Error(`Failed to fetch /health: ${err.message}`);
      });
      return {
        contents: [
          {
            uri: "opencode://health",
            mimeType: "application/json",
            text: JSON.stringify(health, null, 2)
          }
        ]
      };
    }
  );

  server.registerResource(
    "opencode-models",
    "opencode://models",
    { mimeType: "application/json" },
    async () => {
      const models = await callOpencode("/v1/models").catch(err => {
        throw new Error(`Failed to fetch /v1/models: ${err.message}`);
      });
      return {
        contents: [
          {
            uri: "opencode://models",
            mimeType: "application/json",
            text: JSON.stringify(models, null, 2)
          }
        ]
      };
    }
  );

  server.registerTool(
    "opencode.chat",
    {
      title: "Send prompt to local OpenCode",
      description: "Send a prompt to the local OpenCode /v1/messages endpoint (non-streaming).",
      inputSchema: {
        prompt: z.string().min(1).describe("User message to send to OpenCode"),
        system: z.string().optional().describe("Optional system message"),
        model: z.string().optional().describe("Model name (leave empty to let OpenCode auto-pick)"),
        temperature: z.number().min(0).max(1).optional().describe("Temperature override")
      }
    },
    async ({ prompt, system, model, temperature }) => {
      try {
        const payload = {
          model,
          system,
          temperature,
          messages: [{ role: "user", content: prompt }],
          stream: false
        };
        const data = await callOpencode("/v1/messages", { method: "POST", body: payload });
        const text = opencodeText(data);
        return {
          content: [
            {
              type: "text",
              text: text || "OpenCode returned an empty response"
            }
          ],
          structuredContent: data
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `opencode.chat failed: ${msg}` }],
          structuredContent: error?.detail ? { error: error.detail } : undefined,
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "opencode.listModels",
    {
      title: "List OpenCode models",
      description: "List models visible to the local OpenCode proxy (/v1/models)."
    },
    async () => {
      try {
        const data = await callOpencode("/v1/models");
        const ids = Array.isArray(data?.data) ? data.data.map(m => m?.id).filter(Boolean) : [];
        const text = ids.length ? ids.join(", ") : JSON.stringify(data, null, 2);
        return {
          content: [{ type: "text", text }],
          structuredContent: data
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to list models: ${msg}` }],
          isError: true
        };
      }
    }
  );

  return server;
}

function getSession(sessionId) {
  return sessionId ? sessions.get(sessionId) : undefined;
}

app.post(MCP_PATH, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    const existing = getSession(sessionId);
    if (existing) {
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Missing MCP initialize request" },
        id: null
      });
      return;
    }

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => sessions.set(id, { server, transport })
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
      server.close();
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[opencode-mcp] POST /mcp error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
});

app.get(MCP_PATH, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    const session = getSession(sessionId);
    if (!session) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await session.transport.handleRequest(req, res);
  } catch (error) {
    console.error("[opencode-mcp] GET /mcp error:", error);
    if (!res.headersSent) res.status(500).send("Internal server error");
  }
});

app.delete(MCP_PATH, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    const session = getSession(sessionId);
    if (!session) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await session.transport.handleRequest(req, res);
    const sid = session.transport.sessionId;
    if (sid) sessions.delete(sid);
    await session.server.close();
  } catch (error) {
    console.error("[opencode-mcp] DELETE /mcp error:", error);
    if (!res.headersSent) res.status(500).send("Internal server error");
  }
});

app.listen(MCP_PORT, MCP_HOST, () => {
  console.log(`[opencode-mcp] listening on http://${MCP_HOST}:${MCP_PORT}${MCP_PATH}`);
  console.log(`[opencode-mcp] OPENCODE_BASE_URL=${OPENCODE_BASE_URL}`);
  if (MCP_API_KEY) console.log("[opencode-mcp] x-api-key required");
});

process.on("SIGINT", async () => {
  console.log("[opencode-mcp] shutting down...");
  for (const [sid, { server, transport }] of sessions.entries()) {
    try {
      await transport.close();
      await server.close();
    } catch (err) {
      console.error(`[opencode-mcp] error closing session ${sid}:`, err);
    }
    sessions.delete(sid);
  }
  process.exit(0);
});
