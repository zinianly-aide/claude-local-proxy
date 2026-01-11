const express = require("express");
const { randomUUID } = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");
const { RunPipelineInputSchema } = require("./types");
const { runPipeline } = require("./tools/runPipeline");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 7777);
const MCP_BEARER = process.env.MCP_BEARER || process.env.MCP_TOKEN || "";

function buildServer() {
  const server = new McpServer(
    {
      name: "opencode-pipeline-mcp",
      version: "1.0.0"
    },
    { capabilities: { logging: {} } }
  );

  server.registerTool(
    "opencode.run_pipeline",
    {
      title: "Run OpenCode init + tests + diff",
      description: "Runs OpenCode pipeline: init repo, run tests, fetch diff",
      inputSchema: RunPipelineInputSchema
    },
    async (args) => {
      try {
        const { output, errorMessage } = await runPipeline(args);
        const summaryLines = [
          `session: ${output.session_id || "n/a"}`,
          `init: ${output.init?.ok ? "ok" : "failed"}`,
          `tests: ${output.tests?.ok ? "ok" : "failed"} (exit ${output.tests?.exit_code ?? "?"})`,
          `diff files: ${output.diff?.changed_files?.length ?? 0}`
        ];
        if (errorMessage) summaryLines.push(`error: ${errorMessage}`);
        return {
          content: [{ type: "text", text: summaryLines.join("\n") }],
          structuredContent: output,
          isError: Boolean(errorMessage)
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `opencode.run_pipeline failed: ${msg}` }],
          isError: true
        };
      }
    }
  );

  return server;
}

const app = createMcpExpressApp({ host: HOST });
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  if (!MCP_BEARER) {
    return res.status(500).json({ error: "MCP_BEARER not set" });
  }
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${MCP_BEARER}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

const transports = new Map();

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && transports.has(sessionId)) {
      const t = transports.get(sessionId);
      await t.transport.handleRequest(req, res, req.body);
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
      onsessioninitialized: (id) => transports.set(id, { transport, server })
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
      server.close();
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const t = transports.get(sessionId);
    await t.transport.handleRequest(req, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).send("Internal server error");
  }
});

app.delete("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const t = transports.get(sessionId);
    await t.transport.handleRequest(req, res);
    const sid = t.transport.sessionId;
    if (sid) transports.delete(sid);
    await t.server.close();
  } catch (err) {
    if (!res.headersSent) res.status(500).send("Internal server error");
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[opencode-mcp] listening on http://${HOST}:${PORT}/mcp`);
});
