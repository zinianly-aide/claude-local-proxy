// server.mjs - Mac Control Hub
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====== Config ======
const PORT = parseInt(process.env.PORT || "8787", 10);
const API_KEY = process.env.API_KEY || "";
const REPO_ROOT = (process.env.REPO_ROOT || path.join(os.homedir(), "code")).replace(/^~\//, os.homedir() + "/");

// 允许的客户端 IP（可多个，逗号分隔）；为空则不启用 IP 白名单（不建议）
const ALLOW_IPS = (process.env.ALLOW_IPS || "").split(",").map(s => s.trim()).filter(Boolean);

// 允许跨域（Termux curl 不需要；若你以后做网页面板可以用）
app.use(cors());

// ====== In-memory run store ======
/** @type {Map<string, { id:string, status:'running'|'exit'|'error', startedAt:number, endedAt?:number, code?:number, signal?:string, cmd:string, cwd:string, out:string[], err:string[], exitMessage?:string, stopSignal?:string, stopRequestedAt?:number, process?:any, subscribers:Set<any> }>} */
const runs = new Map();
const MAX_LINES = 4000;

function pushLine(run, which, line) {
  const arr = which === "stderr" ? run.err : run.out;
  arr.push(line);
  if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES);

  // fanout to SSE subscribers
  for (const res of run.subscribers) {
    res.write(`event: ${which}\n`);
    res.write(`data: ${JSON.stringify({ id: run.id, line })}\n\n`);
  }
}

// ====== Security middlewares ======
function getClientIP(req) {
  // 在纯局域网直连时，req.socket.remoteAddress 就够用
  // 可能是 ::ffff:192.168.x.x
  const ra = req.socket.remoteAddress || "";
  return ra.startsWith("::ffff:") ? ra.slice(7) : ra;
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ error: "Server API_KEY not set" });
  const k = req.header("x-api-key");
  if (!k || k !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function requireIPAllowed(req, res, next) {
  if (ALLOW_IPS.length === 0) return next(); // 不启用白名单（不建议）
  const ip = getClientIP(req);
  if (!ALLOW_IPS.includes(ip)) {
    return res.status(403).json({ error: `Forbidden IP: ${ip}` });
  }
  next();
}

app.use(requireIPAllowed);
app.use(requireApiKey);

// ====== Helpers ======
function assertSafeRepo(repo) {
  if (typeof repo !== "string" || repo.length < 1) throw new Error("Invalid repo");
  if (repo.includes("..") || repo.includes("/") || repo.includes("\\")) {
    throw new Error("Repo must be a simple folder name under REPO_ROOT");
  }
  const full = path.join(REPO_ROOT, repo);
  if (!full.startsWith(REPO_ROOT)) throw new Error("Repo path escape detected");
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new Error(`Repo not found: ${repo}`);
  return full;
}

function assertSafePathInRepo(repoFull, relPath) {
  if (typeof relPath !== "string" || relPath.length < 1) throw new Error("Invalid file path");
  if (relPath.includes("..")) throw new Error("Path traversal not allowed");
  const full = path.join(repoFull, relPath);
  if (!full.startsWith(repoFull)) throw new Error("Path escape detected");
  return full;
}

function assertSafeCwd(repoFull, relPath) {
  const full = assertSafePathInRepo(repoFull, relPath);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
    throw new Error(`cwd not found or not a directory: ${relPath}`);
  }
  return full;
}

// 命令白名单：只允许这些"可执行文件名"
const ALLOWED_CMDS = new Set([
  "gemini",
  "git",
  "npm",
  "pnpm",
  "yarn",
  "node",
  "python3",
  "pip3",
  "make",
  "mvn",
  "gradle",
  "bash",
  "sh",
  "rg",
  "sed",
  "awk",
  "jq"
]);

function assertAllowedCmd(cmd) {
  if (!ALLOWED_CMDS.has(cmd)) {
    throw new Error(`Command not allowed: ${cmd}`);
  }
}

const ALLOWED_SIGNALS = new Set(["SIGTERM", "SIGINT", "SIGKILL"]);

// 参数长度限制，避免滥用
function sanitizeArgs(args) {
  if (!Array.isArray(args)) throw new Error("args must be array");
  if (args.length > 60) throw new Error("too many args");
  for (const a of args) {
    if (typeof a !== "string") throw new Error("args must be strings");
    if (a.length > 4000) throw new Error("arg too long");
  }
  return args;
}

function newRunId() {
  return crypto.randomBytes(8).toString("hex");
}

// ====== APIs ======

// 1) VS Code: open repo (and optionally open file at line/col)
app.post("/vscode/open", (req, res) => {
  try {
    const { repo, file, line, col } = req.body || {};
    const repoFull = assertSafeRepo(repo);

    let openTarget = repoFull;
    let openArgs = [repoFull];

    if (file) {
      const fileFull = assertSafePathInRepo(repoFull, file);
      const l = Number.isFinite(line) ? line : undefined;
      const c = Number.isFinite(col) ? col : undefined;
      if (l != null) {
        openTarget = `${fileFull}:${l}${c != null ? ":" + c : ""}`;
        openArgs = ["-g", openTarget];
      } else {
        openArgs = [fileFull];
      }
    }

    const child = spawn("code", openArgs, { stdio: "ignore", detached: true });
    child.unref();

    res.json({ ok: true, opened: openTarget });
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

// 2) cmd.run: run allowed command in repo (stream logs via SSE)
app.post("/cmd/run", (req, res) => {
  try {
    const { repo, cmd, args = [], env = {}, cwd } = req.body || {};
    const repoFull = assertSafeRepo(repo);
    const safeCwd = typeof cwd === "string" && cwd.length > 0
      ? assertSafeCwd(repoFull, cwd)
      : repoFull;
    if (typeof cmd !== "string") throw new Error("cmd required");
    assertAllowedCmd(cmd);
    const safeArgs = sanitizeArgs(args);

    // 只允许少量自定义 env，避免注入（你可以按需扩展）
    const safeEnv = {};
    const ALLOWED_ENV_KEYS = new Set(["OPENAI_BASE_URL", "OPENAI_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]);
    if (env && typeof env === "object") {
      for (const [k, v] of Object.entries(env)) {
        if (ALLOWED_ENV_KEYS.has(k) && typeof v === "string" && v.length < 2000) {
          safeEnv[k] = v;
        }
      }
    }

    const id = newRunId();
    const run = {
      id,
      status: "running",
      startedAt: Date.now(),
      cmd: `${cmd} ${safeArgs.join(" ")}`,
      cwd: safeCwd,
      out: [],
      err: [],
      subscribers: new Set()
    };
    runs.set(id, run);

    const child = spawn(cmd, safeArgs, {
      cwd: safeCwd,
      env: { ...process.env, ...safeEnv }
    });
    run.process = child;

    child.stdout.on("data", (buf) => {
      const s = buf.toString("utf8");
      s.split(/\r?\n/).filter(Boolean).forEach(line => pushLine(run, "stdout", line));
    });

    child.stderr.on("data", (buf) => {
      const s = buf.toString("utf8");
      s.split(/\r?\n/).filter(Boolean).forEach(line => pushLine(run, "stderr", line));
    });

    child.on("error", (err) => {
      run.status = "error";
      run.endedAt = Date.now();
      run.exitMessage = err.message || String(err);
      run.process = null;
      for (const sub of run.subscribers) {
        sub.write(`event: end\n`);
        sub.write(`data: ${JSON.stringify({ id, status: run.status, message: run.exitMessage })}\n\n`);
        sub.end();
      }
      run.subscribers.clear();
    });

    child.on("close", (code, signal) => {
      run.status = "exit";
      run.endedAt = Date.now();
      run.code = code ?? undefined;
      run.signal = signal ?? undefined;
      run.process = null;

      for (const sub of run.subscribers) {
        sub.write(`event: end\n`);
        sub.write(`data: ${JSON.stringify({ id, status: run.status, code: run.code, signal: run.signal })}\n\n`);
        sub.end();
      }
      run.subscribers.clear();
    });

    res.json({ ok: true, id, status: run.status });
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

app.post("/runs/:id/stop", (req, res) => {
  const id = req.params.id;
  const run = runs.get(id);
  if (!run) return res.status(404).json({ error: "not found" });
  if (run.status !== "running" || !run.process) {
    return res.json({ ok: false, id, status: run.status, message: "not running" });
  }
  const signal = typeof req.body?.signal === "string" ? req.body.signal : "SIGTERM";
  if (!ALLOWED_SIGNALS.has(signal)) {
    return res.status(400).json({ error: `Signal not allowed: ${signal}` });
  }
  const ok = run.process.kill(signal);
  run.stopSignal = signal;
  run.stopRequestedAt = Date.now();
  res.json({ ok, id, status: run.status, signal });
});

// 3) stream logs: Server-Sent Events (SSE)
app.get("/stream/:id", (req, res) => {
  const id = req.params.id;
  const run = runs.get(id);
  if (!run) return res.status(404).end("not found");

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // 先把已有日志补发一遍
  for (const line of run.out) {
    res.write(`event: stdout\n`);
    res.write(`data: ${JSON.stringify({ id, line })}\n\n`);
  }
  for (const line of run.err) {
    res.write(`event: stderr\n`);
    res.write(`data: ${JSON.stringify({ id, line })}\n\n`);
  }

  // 如果已经结束，直接发 end
  if (run.status !== "running") {
    res.write(`event: end\n`);
    res.write(`data: ${JSON.stringify({ id, status: run.status, code: run.code, signal: run.signal, message: run.exitMessage })}\n\n`);
    return res.end();
  }

  run.subscribers.add(res);

  req.on("close", () => {
    run.subscribers.delete(res);
  });
});

// 4) get result (pull)
app.get("/runs", (req, res) => {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  if (status && !["running", "exit", "error"].includes(status)) {
    return res.status(400).json({ error: `Invalid status: ${status}` });
  }
  const runsList = Array.from(runs.values())
    .filter((run) => (status ? run.status === status : true))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      code: run.code,
      signal: run.signal,
      cmd: run.cmd,
      cwd: run.cwd
    }));
  res.json({ runs: runsList });
});

app.get("/runs/:id", (req, res) => {
  const id = req.params.id;
  const run = runs.get(id);
  if (!run) return res.status(404).json({ error: "not found" });
  res.json({
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    code: run.code,
    signal: run.signal,
    stopSignal: run.stopSignal,
    stopRequestedAt: run.stopRequestedAt,
    cmd: run.cmd,
    cwd: run.cwd,
    out: run.out.slice(-500),
    err: run.err.slice(-500),
    exitMessage: run.exitMessage
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[mac-control-hub] listening on :${PORT}`);
  console.log(`[mac-control-hub] REPO_ROOT=${REPO_ROOT}`);
  console.log(`[mac-control-hub] ALLOW_IPS=${ALLOW_IPS.join(",") || "(disabled)"}`);
});
