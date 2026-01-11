import fs from "node:fs";
import path from "node:path";

let cachedMap = null;

function loadRepoMap() {
  if (cachedMap) return cachedMap;
  const raw = process.env.REPO_MAP_JSON;
  if (!raw) {
    throw new Error("REPO_MAP_JSON not set");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`REPO_MAP_JSON invalid JSON: ${e.message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("REPO_MAP_JSON must be an object");
  }
  cachedMap = parsed;
  return cachedMap;
}

function resolveRepo(alias) {
  if (typeof alias !== "string" || alias.length === 0) {
    throw new Error("repo alias required");
  }
  if (alias.includes("..") || alias.includes("/") || alias.includes("\\")) {
    throw new Error("repo alias must not contain path separators");
  }
  const map = loadRepoMap();
  const repoPath = map[alias];
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new Error(`repo alias not found: ${alias}`);
  }
  if (!path.isAbsolute(repoPath)) {
    throw new Error(`repo path must be absolute for alias ${alias}`);
  }
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new Error(`repo path missing: ${repoPath}`);
  }
  return repoPath;
}

export { resolveRepo, loadRepoMap };
