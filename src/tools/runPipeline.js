import { RunPipelineInputSchema } from "../types.js";
import { assertSafeTestCommand } from "../security/commandGuard.js";
import { resolveRepo } from "../repo/resolveRepo.js";
import { queue } from "../queue.js";

const fetchFn =
  typeof fetch === "function"
    ? fetch
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const DEFAULT_BASE_URL = process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096";

function buildUrl(pathname) {
  return new URL(pathname, DEFAULT_BASE_URL).toString();
}

function now() {
  return Date.now();
}

function tailLines(lines, max) {
  if (!Array.isArray(lines)) {
    if (typeof lines === "string") {
      lines = lines.split(/\r?\n/);
    } else {
      return "";
    }
  }
  if (lines.length <= max) return lines.join("\n");
  return lines.slice(-max).join("\n");
}

function countAddRemove(lines) {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (!line || line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function parseUnifiedDiff(patch, limits) {
  const segments = patch.split(/^diff --git /m).filter(Boolean);
  const changed_files = [];
  const snippets = [];
  let truncatedFiles = false;
  let fileCount = 0;
  for (const seg of segments) {
    if (fileCount >= limits.maxFiles) {
      truncatedFiles = true;
      break;
    }
    const segText = "diff --git " + seg;
    const lines = segText.split(/\r?\n/);
    const header = lines[0] || "";
    const pathMatch = header.match(/a\/(.+)\s+b\/(.+)/);
    const path = pathMatch ? pathMatch[2] : header.replace("diff --git ", "").trim();
    const sliced = lines.slice(0, limits.maxLines);
    const counts = countAddRemove(lines);
    changed_files.push({ path, added: counts.added, removed: counts.removed });
    snippets.push({ path, patch_excerpt: sliced.join("\n") });
    fileCount++;
  }
  return { changed_files, snippets, truncatedFiles };
}

function normalizeDiff(diffData, limits, notes) {
  if (!diffData) return { changed_files: [], snippets: [] };
  if (typeof diffData === "string") {
    return parseUnifiedDiff(diffData, limits);
  }
  if (typeof diffData.diff === "string") {
    return parseUnifiedDiff(diffData.diff, limits);
  }
  if (Array.isArray(diffData.files)) {
    const changed_files = [];
    const snippets = [];
    let truncatedFiles = false;
    for (let i = 0; i < diffData.files.length; i++) {
      if (i >= limits.maxFiles) {
        truncatedFiles = true;
        break;
      }
      const f = diffData.files[i];
      const added = Number.isFinite(f.added) ? f.added : countAddRemove((f.patch || "").split(/\r?\n/)).added;
      const removed = Number.isFinite(f.removed) ? f.removed : countAddRemove((f.patch || "").split(/\r?\n/)).removed;
      changed_files.push({ path: f.path || f.file || `file-${i + 1}`, added, removed });
      const patchLines = typeof f.patch === "string" ? f.patch.split(/\r?\n/) : [];
      const sliced = patchLines.slice(0, limits.maxLines);
      snippets.push({
        path: f.path || f.file || `file-${i + 1}`,
        patch_excerpt: sliced.join("\n")
      });
    }
    if (truncatedFiles) notes.push("diff truncated to max_diff_files");
    return { changed_files, snippets, truncatedFiles };
  }
  notes.push("diff format unknown; returning raw");
  return {
    changed_files: [],
    snippets: [
      {
        path: "diff.txt",
        patch_excerpt: JSON.stringify(diffData, null, 2).slice(0, limits.maxLines * 120)
      }
    ]
  };
}

async function fetchJson(pathname, options, remainingMs) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), remainingMs);
  try {
    const resp = await fetchFn(buildUrl(pathname), {
      method: options.method || "GET",
      headers: { "content-type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const txt = await resp.text();
    let data;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = txt;
    }
    if (!resp.ok) {
      const err = new Error(`http_${resp.status}`);
      err.detail = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(to);
  }
}

async function runPipelineInternal(rawInput) {
  const parsed = RunPipelineInputSchema.parse(rawInput);
  const repoPath = resolveRepo(parsed.repo);
  const testCommand = assertSafeTestCommand(parsed.test_command);
  const timeoutMs = (parsed.timeout_sec ?? 1800) * 1000;
  const maxLogLines = parsed.max_log_lines ?? 200;
  const maxDiffFiles = parsed.max_diff_files ?? 20;
  const maxDiffLines = parsed.max_diff_lines_per_file ?? 400;
  const notes = [];
  const start = now();

  const limits = {
    maxFiles: maxDiffFiles,
    maxLines: maxDiffLines
  };

  let sessionId = null;
  let initOk = false;
  let testsResult = {
    ok: false,
    exit_code: null,
    command: testCommand,
    tail_log: ""
  };
  let diffResult = { changed_files: [], snippets: [] };
  let errorMessage = null;

  async function abortSession(reason) {
    if (!sessionId) return;
    try {
      await fetchJson(`/session/${sessionId}/abort`, { method: "POST" }, Math.max(5000, timeoutMs - (now() - start)));
      notes.push(reason);
    } catch (err) {
      notes.push(`failed to abort session: ${err.message || err}`);
    }
  }

  const remaining = () => timeoutMs - (now() - start);

  try {
    if (remaining() <= 0) throw new Error("timeout");

    await fetchJson("/global/health", { method: "GET" }, remaining());

    const sessionResp = await fetchJson(
      "/session",
      { method: "POST", body: { repoPath } },
      remaining()
    );
    sessionId = sessionResp?.sessionId || sessionResp?.id || sessionResp?.session_id;
    if (!sessionId) throw new Error("session_id missing from /session response");

    if (parsed.init !== false) {
      const initResp = await fetchJson(
        `/session/${sessionId}/init`,
        { method: "POST", body: { repoPath } },
        remaining()
      );
      initOk = initResp?.ok !== false;
    } else {
      initOk = true;
    }

    const shellResp = await fetchJson(
      `/session/${sessionId}/shell`,
      { method: "POST", body: { command: testCommand, cwd: repoPath } },
      remaining()
    );
    const exitCode = Number.isFinite(shellResp?.exitCode) ? shellResp.exitCode : shellResp?.code;
    const stdout = Array.isArray(shellResp?.stdout) ? shellResp.stdout : typeof shellResp?.stdout === "string" ? shellResp.stdout.split(/\r?\n/) : [];
    const stderr = Array.isArray(shellResp?.stderr) ? shellResp.stderr : typeof shellResp?.stderr === "string" ? shellResp.stderr.split(/\r?\n/) : [];
    const combined = [...stdout, ...stderr].filter(Boolean);
    const tail = tailLines(combined, maxLogLines);
    if (combined.length > maxLogLines) notes.push("logs truncated to max_log_lines");
    testsResult = {
      ok: exitCode === 0 || shellResp?.ok === true,
      exit_code: Number.isFinite(exitCode) ? exitCode : null,
      command: testCommand,
      tail_log: tail
    };

    const diffResp = await fetchJson(`/session/${sessionId}/diff`, { method: "GET" }, remaining());
    const diffParsed = normalizeDiff(diffResp, limits, notes);
    diffResult = {
      changed_files: diffParsed.changed_files,
      snippets: diffParsed.snippets
    };

    if (diffParsed.truncatedFiles) notes.push("diff files truncated");
    if (diffResult.snippets.some(s => s.patch_excerpt.split(/\r?\n/).length >= maxDiffLines)) {
      notes.push("diff lines truncated per file");
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    if (errorMessage === "timeout" || err?.name === "AbortError" || remaining() <= 0) {
      await abortSession("timeout aborted");
    }
  }

  return {
    output: {
      session_id: sessionId,
      init: { ok: initOk },
      tests: testsResult,
      diff: diffResult,
      notes: notes
    },
    errorMessage
  };
}

async function runPipeline(rawInput) {
  return queue.enqueue(() => runPipelineInternal(rawInput));
}

export { runPipeline };
