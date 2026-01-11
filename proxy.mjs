import express from "express";
import fetch from "node-fetch";
import { pathToFileURL } from "url";
import { Queue } from "./src/queue.js";

// 简单的请求速率限制实现
const rateLimit = {
  windowMs: 60 * 1000, // 1 minute
  max: 100, // max requests per window
  requests: new Map(),
  
  check(ip) {
    const now = Date.now();
    const window = Math.floor(now / this.windowMs);
    const key = `${ip}:${window}`;
    
    const count = this.requests.get(key) || 0;
    if (count >= this.max) {
      return false;
    }
    
    this.requests.set(key, count + 1);
    return true;
  }
};

const app = express();
app.use(express.json({ limit: "30mb" }));

const OLLAMA_CHAT = "http://127.0.0.1:11434/v1/chat/completions";
const BEARER = process.env.PROXY_BEARER || "local";

// coder 在手机上可能很慢：给足时间
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 600000); // 10min

const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || 1);
const queue = new Queue(MAX_INFLIGHT);

function runQueued(fn) {
  return queue.enqueue(fn);
}

/**
 * 检查请求的认证信息是否有效
 * @param {express.Request} req - Express 请求对象
 * @returns {boolean} - 认证是否通过
 */
function authOk(req) {
  return (req.headers.authorization || "") === `Bearer ${BEARER}`;
}

/**
 * 将 Anthropic 格式的请求转换为 OpenAI 格式
 * @param {Object} anth - Anthropic 格式的请求对象
 * @param {string|Array<Object>} [anth.system] - 系统提示
 * @param {Array<Object>} anth.messages - 消息数组
 * @returns {Array<Object>} - OpenAI 格式的消息数组
 */
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

// 你机器上的实际可用模型：qwen3:0.6b / qwen2.5:7b / deepseek-coder:6.7b / llama3.2:latest
// 优化后的模型选择逻辑：合并正则表达式，减少执行次数，提高性能
const CODE_PATTERN = /(代码|code|class|import|docker|sql|bash|python|java|js|ts|bug|报错|编译|运行)/i;
const REASONING_PATTERN = /(证明|推导|为什么|一步一步|严谨|推理)/i;

/**
 * 根据请求内容选择合适的模型
 * @param {string} text - 请求文本内容
 * @returns {string} - 选择的模型名称
 */
function pickModel(text) {
  const textLength = text.length;
  const isShortText = textLength < 160;
  const hasCode = CODE_PATTERN.test(text);
  const isReasoning = REASONING_PATTERN.test(text);
  
  // 代码/工程 → deepseek-coder (使用实际可用的模型)
  if (hasCode) {
    return "deepseek-coder:6.7b";
  }
  
  // 需要“推理/证明/一步一步” → qwen2.5:7b (使用实际可用的模型)
  if (isReasoning) {
    return "qwen2.5:7b";
  }
  
  // 超短非代码 → 用 0.6b 更快更稳 (已安装)
  if (isShortText) {
    return "qwen3:0.6b";
  }
  
  // 默认使用 llama3.2:latest (已安装)
  return "llama3.2:latest";
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
      // 包含详细的错误信息在错误消息中
      let errorMsg = `ollama_http_${r.status}`;
      if (data?.error?.message) {
        errorMsg += `: ${data.error.message}`;
      } else if (txt) {
        errorMsg += `: ${txt}`;
      }
      const err = new Error(errorMsg);
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
      // 直接返回错误，让上层错误处理逻辑处理
      throw new Error(`ollama_stream_http_${r.status}: ${txt}`);
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
    inflight: queue.inflightCount,
    queued: queue.size,
    maxInflight: MAX_INFLIGHT,
    timeoutMs: OLLAMA_TIMEOUT_MS
  });
});

app.post("/v1/messages", async (req, res) => {
  // 速率限制检查
  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  if (!rateLimit.check(clientIp)) {
    return res.status(429).json({
      error: {
        type: "rate_limit_exceeded",
        message: "Rate limit exceeded. Please try again later."
      }
    });
  }
  
  if (!authOk(req)) {
    return res.status(401).json({
      error: {
        type: "authentication_error",
        message: "Invalid authentication credentials"
      }
    });
  }

  // 输入验证
  const anth = req.body || {};
  if (!anth.messages || !Array.isArray(anth.messages)) {
    return res.status(400).json({
      error: {
        type: "invalid_request_error",
        message: "messages field is required and must be an array"
      }
    });
  }

  const wantStream = !!anth.stream;
  
  try {
    const msgs = anthropicToOpenAI(anth);
    const text = msgs.map(m => m.content).join("\n");
    const model = pickModel(text);

    console.log("ROUTE →", model, "| stream:", wantStream, "| queued:", queue.size, "| inflight:", queue.inflightCount);

    const payload = {
      model,
      messages: msgs,
      temperature: anth.temperature ?? 0.2
    };

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
    let msg = e.message;
    let friendlyMsg = "";
    
    // 处理模型未找到错误 - 使用正则表达式进行不区分大小写的匹配
    if (/model.*not found/i.test(msg)) {
      // 直接生成友好的错误信息，不依赖于模型名称提取
      friendlyMsg = `本地模型调用失败：模型未找到。\n\n请先使用以下命令拉取所需模型：\nollama pull qwen3:0.6b\nollama pull qwen2.5-coder\nollama pull deepseek-r1:7b\nollama pull qwen3:8b\n\n或者检查模型名称是否正确，然后再重试。`;
    }
    // 处理超时错误
    else if (e.name === "AbortError") {
      friendlyMsg = `本地模型推理超时（>${OLLAMA_TIMEOUT_MS/1000}s）。建议换小模型/缩短上下文/提高超时时间。`;
    }
    // 处理其他错误
    else {
      // 简化错误信息，移除 ollama_http_ 或 ollama_stream_http_ 前缀
      let errorMessage = msg;
      if (msg.startsWith("ollama_http_") || msg.startsWith("ollama_stream_http_")) {
        errorMessage = msg.replace(/^ollama_(stream_)?http_\d+:\s*/, "");
      }
      
      friendlyMsg = `本地模型调用失败：${errorMessage}`;
    }

    if (wantStream) {
      // 流式错误也用 SSE 结束掉，避免 Claude Code卡死重试
      setSSE(res);
      sseSend(res, {
        type: "message_start",
        message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: anth.model || "sonnet-4.5", content: [], stop_reason: null }
      });
      sseSend(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      sseSend(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: friendlyMsg } });
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
      content: [{ type: "text", text: friendlyMsg }],
      stop_reason: "end_turn"
    });
  } finally {
    // 清理资源（如果需要）
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
