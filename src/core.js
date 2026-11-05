import { z } from "zod";
import { currentToken } from "./context.js";

// ---------------------------------------------------------------- shared config
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
export const GITHUB_API_URL = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
export const GITHUB_WEB_URL = (process.env.GITHUB_WEB_URL || "https://github.com").replace(/\/$/, "");
// Comma separated: "Zohaib8090/*" or "Zohaib8090/KodrixIDE,Zohaib8090/Zohara-OS"
export const ALLOWED_REPOS = (process.env.ALLOWED_REPOS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// FULL_CONTROL (default ON): no allowlist, no read-only, no confirmations. Set FULL_CONTROL=false to
// bring the guardrails back (ALLOWED_REPOS, READ_ONLY, ENABLE_DESTRUCTIVE + confirm strings).
export const FULL_CONTROL = process.env.FULL_CONTROL !== "false";
export const READ_ONLY = !FULL_CONTROL && process.env.READ_ONLY === "true";
export const ENABLE_DESTRUCTIVE = FULL_CONTROL || process.env.ENABLE_DESTRUCTIVE === "true";

// ---------------------------------------------------------------- guardrails (skipped in FULL_CONTROL)
export function repoAllowed(owner, repo) {
  if (FULL_CONTROL) return true;
  const full = `${owner}/${repo}`.toLowerCase();
  return ALLOWED_REPOS.some((p) => p === full || (p.endsWith("/*") && full.startsWith(p.slice(0, -1))));
}
export function assertRepo(owner, repo) {
  if (!repoAllowed(owner, repo)) throw new Error(`Repo ${owner}/${repo} is not in ALLOWED_REPOS`);
}
export function assertWritable() {
  if (READ_ONLY) throw new Error("Server is in READ_ONLY mode");
}
export function assertDestructive(confirm, expected) {
  if (FULL_CONTROL) return;
  assertWritable();
  if (!ENABLE_DESTRUCTIVE) throw new Error("Destructive actions are disabled (set ENABLE_DESTRUCTIVE=true)");
  if (confirm !== expected) throw new Error(`Confirmation required: pass confirm="${expected}"`);
}
export function audit(action, detail) {
  console.log(JSON.stringify({ t: new Date().toISOString(), action, ...detail }));
}

// ---------------------------------------------------------------- GitHub client
export async function gh(method, path, { body, query, raw, headers } = {}) {
  const token = currentToken() || GITHUB_TOKEN;
  if (!token) throw new Error("Not authenticated with GitHub");
  const url = new URL(path.startsWith("http") ? path : `${GITHUB_API_URL}${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    redirect: raw ? "manual" : "follow",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "zohaib-github-mcp",
      ...(body && !(body instanceof Buffer) ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? (body instanceof Buffer ? body : JSON.stringify(body)) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}
export const ok = (data) => ({
  content: [{ type: "text", text: data === null || data === undefined ? "OK" : typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
export const wrap = (fn) => async (args) => {
  try { return ok(await fn(args)); }
  catch (e) { return { isError: true, content: [{ type: "text", text: String(e.message || e) }] }; }
};
export const R = { owner: z.string(), repo: z.string() };
