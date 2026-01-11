import express from "express";
import fetch from "node-fetch";
import { pathToFileURL } from "url";

const app = express();
app.use(express.json({ limit: "30mb" }));

const OLLAMA_CHAT = "http://127.0.0.1:11434/v1/chat/completions";
const BEARER = process.env.PROXY_BEARER || "local";

// coder 在手机上可能很慢：给足时间
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 600000); // 10min
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || 1);

let inflight = 0;
const queue = [];

function runQueued(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  if (inflight >= MAX_INFLIGHT) return;
  const job = queue.shift();
  if (!job) return;
  inflight++;
  job.fn()
    .then(job.resolve, job.reject)
    .finally(() => {
      inflight--;
      pump();
    });
}

function authOk(req) {
  return (req.headers.authorization || "") === `Bearer ${BEARER}`;
}

function anthropicToOpenAI(anth) {
  const msgs = [];
  if (anth.system) {
    const s = Array.isArray(anth.system)
      ? anth.system.map(x => x.text || "").join("\n")
      : String(anth.system);
    msgs.push({ role: "system", content: s });
  }
  for (const m of anth.messages || []) {
    let text = "";
    if (Array.isArray(m.content)) {
      text = m.content
        .filter(x => x.type === "text")
        .map(x => x.text)
        .join("\n");
    } else if (typeof m.content === "string") {
      text = m.content;
    }
    msgs.push({ role: m.role, content: text });
  }
  return msgs;
}

// 你机器上的模型：qwen2.5-coder / qwen3:8b / qwen3:0.6b / deepseek-r1:7b/14b ...
function pickModel(text) {
  // 超短非代码 → 用 0.6b 更快更稳
  if (
    text.length < 160 &&
    !/(代码|code|class|import|docker|sql|bash|python|java|js|ts|bug|报错|编译|运行)/i.test(text)
  ) return "qwen3:0.6b";

  // 需要“推理/证明/一步一步” → deepseek-r1
  if (/(证明|推导|为什么|一步一步|严谨|推理)/i.test(text)) return "deepseek-r1:7b";

  // 代码/工程 → coder
  if (/(代码|code|class|import|docker|sql|bash|python|java|js|ts|bug|报错|编译|运行)/i.test(text))
    return "qwen2.5-coder";

  return "qwen3:8b";
}

function setSSE(res) {
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
}

function sseSend(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// 解析 OpenAI SSE：形如 "data: {...}\n\n"
async function* openAISSEToJSON(bodyStream) {
  let buf = "";
  for await (const chunk of bodyStream) {
    buf += chunk.toString("utf8");
    // OpenAI SSE 以 \n\n 分隔
    while (true) {
      const idx = buf.indexOf("\n\n");
      if (idx < 0) break;
      const part = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      const line = part.split("\n").find(l => l.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === "[DONE]") return;

      try {
        yield JSON.parse(payload);
      } catch {
        // 忽略无法解析的片段
      }
    }
  }
}

async function callOllamaJSON(payload) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const r = await fetch(OLLAMA_CHAT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, stream: false }),
      signal: ac.signal
    });
    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
    if (!r.ok) {
      const err = new Error(`ollama_http_${r.status}`);
      err.detail = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function streamOllamaToAnthropic(res, payload, anthModelName) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const r = await fetch(OLLAMA_CHAT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: ac.signal
    });

    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`ollama_stream_http_${r.status}: ${txt.slice(0, 400)}`);
    }

    // Anthropic SSE 开场
    setSSE(res);
    sseSend(res, {
      type: "message_start",
      message: {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: anthModelName || "sonnet-4.5",
        content: [],
        stop_reason: null
      }
    });
    sseSend(res, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    });

    // 从 OpenAI SSE 取 delta.content，转成 Anthropic text_delta
    for await (const evt of openAISSEToJSON(r.body)) {
      const delta = evt?.choices?.[0]?.delta;
      const txt = delta?.content;
      if (typeof txt === "string" && txt.length) {
        sseSend(res, {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: txt }
        });
      }
      const finish = evt?.choices?.[0]?.finish_reason;
      if (finish) break;
    }

    sseSend(res, { type: "content_block_stop", index: 0 });
    sseSend(res, { type: "message_stop" });
    res.end();
  } finally {
    clearTimeout(t);
  }
}

/* ---------- endpoints ---------- */

app.get("/v1/models", (req, res) => {
  if (!authOk(req)) return res.sendStatus(401);
  res.json({
    data: [
      { id: "sonnet-4.5", type: "model" },
      { id: "haiku-4.5", type: "model" },
      { id: "opus-4.5", type: "model" }
    ]
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    inflight,
    queued: queue.length,
    maxInflight: MAX_INFLIGHT,
    timeoutMs: OLLAMA_TIMEOUT_MS
  });
});

app.post("/v1/messages", async (req, res) => {
  if (!authOk(req)) return res.sendStatus(401);

  const anth = req.body || {};
  const wantStream = !!anth.stream;

  const msgs = anthropicToOpenAI(anth);
  const text = msgs.map(m => m.content).join("\n");
  const model = pickModel(text);

  console.log("ROUTE →", model, "| stream:", wantStream, "| queued:", queue.length, "| inflight:", inflight);

  const payload = {
    model,
    messages: msgs,
    temperature: anth.temperature ?? 0.2
  };

  try {
    if (wantStream) {
      // 流式时：排队后再真正开始推理并持续写回 SSE
      await runQueued(() => streamOllamaToAnthropic(res, payload, anth.model));
      return;
    }

    // 非流式：正常 JSON 返回
    const data = await runQueued(() => callOllamaJSON(payload));
    const out = data?.choices?.[0]?.message?.content ?? "";
    res.json({
      id: "msg-local",
      type: "message",
      role: "assistant",
      model: anth.model || "sonnet-4.5",
      content: [{ type: "text", text: out }],
      stop_reason: "end_turn"
    });
  } catch (e) {
    const msg =
      e.name === "AbortError"
        ? `本地模型推理超时（>${OLLAMA_TIMEOUT_MS/1000}s）。建议换小模型/缩短上下文/提高超时。`
        : `本地模型调用失败：${e.message}`;

    if (wantStream) {
      // 流式错误也用 SSE 结束掉，避免 Claude Code卡死重试
      setSSE(res);
      sseSend(res, {
        type: "message_start",
        message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: anth.model || "sonnet-4.5", content: [], stop_reason: null }
      });
      sseSend(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      sseSend(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: msg } });
      sseSend(res, { type: "content_block_stop", index: 0 });
      sseSend(res, { type: "message_stop" });
      res.end();
      return;
    }

    res.status(502).json({
      id: "msg-local",
      type: "message",
      role: "assistant",
      model: anth.model || "sonnet-4.5",
      content: [{ type: "text", text: msg }],
      stop_reason: "end_turn"
    });
  }
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  app.listen(8787, "127.0.0.1", () => {
    console.log("✅ Claude-local proxy (streaming) listening on http://127.0.0.1:8787");
    console.log("   timeout:", OLLAMA_TIMEOUT_MS, "ms | max_inflight:", MAX_INFLIGHT);
  });
}

export { anthropicToOpenAI, pickModel };
