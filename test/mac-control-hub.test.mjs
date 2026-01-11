import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, apiKey) {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { "x-api-key": apiKey }
      });
      if (res.ok) return;
    } catch {
      // retry until server is up
    }
    await delay(100);
  }
  throw new Error("mac-control-hub did not start");
}

async function waitForRunExit(baseUrl, apiKey, id) {
  for (let i = 0; i < 50; i += 1) {
    const res = await fetch(`${baseUrl}/runs/${id}`, {
      headers: { "x-api-key": apiKey }
    });
    const data = await res.json();
    if (data.status !== "running") return data;
    await delay(100);
  }
  throw new Error(`run ${id} did not exit`);
}

async function startServer() {
  const port = await getAvailablePort();
  const apiKey = "test-key";
  const repoRoot = mkdtempSync(join(tmpdir(), "mac-control-hub-"));
  const repoName = "sample-repo";
  const repoPath = join(repoRoot, repoName);
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(join(repoPath, "subdir"), { recursive: true });

  const serverPath = fileURLToPath(
    new URL("../mac-control-hub/server.mjs", import.meta.url)
  );
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      API_KEY: apiKey,
      REPO_ROOT: repoRoot,
      ALLOW_IPS: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.resume();
  child.stderr?.resume();

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, apiKey);

  async function waitForExit(timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await Promise.race([
      once(child, "exit").then(() => true),
      delay(timeoutMs).then(() => false)
    ]);
  }

  async function close() {
    const termSent = child.kill("SIGTERM");
    const exited = termSent ? await waitForExit(2000) : false;
    if (!exited) {
      const killSent = child.kill("SIGKILL");
      const killed = killSent ? await waitForExit(2000) : false;
      if (!killed) {
        child.unref();
      }
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    rmSync(repoRoot, { recursive: true, force: true });
  }

  return { baseUrl, apiKey, repoName, repoPath, close };
}

test("mac-control-hub run, list, and stop", async (t) => {
  const server = await startServer();
  let lastRunId = "";

  try {
    await t.test("runs command with cwd", async () => {
      const runRes = await fetch(`${server.baseUrl}/cmd/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": server.apiKey
        },
        body: JSON.stringify({
          repo: server.repoName,
          cmd: "node",
          args: ["-e", "console.log(process.cwd())"],
          cwd: "subdir"
        })
      });
      assert.equal(runRes.status, 200);
      const runData = await runRes.json();
      lastRunId = runData.id;
      const result = await waitForRunExit(server.baseUrl, server.apiKey, runData.id);
      assert.equal(result.status, "exit");
      const expectedCwd = join(server.repoPath, "subdir");
      assert.ok(result.out.some((line) => line.endsWith(expectedCwd)));
    });

    await t.test("lists recent runs", async () => {
      const res = await fetch(`${server.baseUrl}/runs?limit=1`, {
        headers: { "x-api-key": server.apiKey }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.runs));
      assert.ok(data.runs.length >= 1);
      assert.equal(data.runs[0].id, lastRunId);
    });

    await t.test("stops a running command", async () => {
      const runRes = await fetch(`${server.baseUrl}/cmd/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": server.apiKey
        },
        body: JSON.stringify({
          repo: server.repoName,
          cmd: "node",
          args: ["-e", "setInterval(() => {}, 1000)"]
        })
      });
      assert.equal(runRes.status, 200);
      const runData = await runRes.json();

      const stopRes = await fetch(`${server.baseUrl}/runs/${runData.id}/stop`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": server.apiKey
        },
        body: JSON.stringify({ signal: "SIGKILL" })
      });
      assert.equal(stopRes.status, 200);
      const stopData = await stopRes.json();
      assert.equal(stopData.ok, true);

      const result = await waitForRunExit(server.baseUrl, server.apiKey, runData.id);
      assert.equal(result.status, "exit");
      assert.equal(result.signal, "SIGKILL");
    });
  } finally {
    await server.close();
  }
});
