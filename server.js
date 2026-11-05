import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------- config
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MCP_SECRET = process.env.MCP_SECRET; // long random string, part of the URL
const PORT = process.env.PORT || 3000;
// Comma separated: "Zohaib8090/*" or "Zohaib8090/KodrixIDE,Zohaib8090/Zohara-OS"
const ALLOWED_REPOS = (process.env.ALLOWED_REPOS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const READ_ONLY = process.env.READ_ONLY === "true";
const ENABLE_DESTRUCTIVE = process.env.ENABLE_DESTRUCTIVE === "true";
const SELF_URL = process.env.RENDER_EXTERNAL_URL; // set automatically on Render

if (!GITHUB_TOKEN) { console.error("GITHUB_TOKEN is required"); process.exit(1); }
if (!MCP_SECRET || MCP_SECRET.length < 24) { console.error("MCP_SECRET (24+ chars) is required"); process.exit(1); }
if (!ALLOWED_REPOS.length) { console.error("ALLOWED_REPOS is required, e.g. Zohaib8090/*"); process.exit(1); }

// ---------------------------------------------------------------- guardrails
function repoAllowed(owner, repo) {
  const full = `${owner}/${repo}`.toLowerCase();
  return ALLOWED_REPOS.some((p) => p === full || (p.endsWith("/*") && full.startsWith(p.slice(0, -1))));
}
function assertRepo(owner, repo) {
  if (!repoAllowed(owner, repo)) throw new Error(`Repo ${owner}/${repo} is not in ALLOWED_REPOS`);
}
function assertWritable() {
  if (READ_ONLY) throw new Error("Server is in READ_ONLY mode");
}
function assertDestructive(confirm, expected) {
  assertWritable();
  if (!ENABLE_DESTRUCTIVE) throw new Error("Destructive actions are disabled (set ENABLE_DESTRUCTIVE=true)");
  if (confirm !== expected) throw new Error(`Confirmation required: pass confirm="${expected}"`);
}
function audit(action, detail) {
  console.log(JSON.stringify({ t: new Date().toISOString(), action, ...detail }));
}

// ---------------------------------------------------------------- GitHub client
async function gh(method, path, { body, query, raw, headers } = {}) {
  const url = new URL(path.startsWith("http") ? path : `https://api.github.com${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    redirect: raw ? "manual" : "follow",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
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
const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const wrap = (fn) => async (args) => {
  try { return ok(await fn(args)); }
  catch (e) { return { isError: true, content: [{ type: "text", text: String(e.message || e) }] }; }
};
const R = { owner: z.string(), repo: z.string() };

// ---------------------------------------------------------------- tools
function buildServer() {
  const s = new McpServer({ name: "github-custom", version: "1.0.0" });

  s.tool("gh_whoami", "Show the GitHub user the token belongs to, plus active guardrail settings.", {},
    wrap(async () => {
      const me = await gh("GET", "/user");
      return { login: me.login, allowed_repos: ALLOWED_REPOS, read_only: READ_ONLY, destructive_enabled: ENABLE_DESTRUCTIVE };
    }));

  s.tool("gh_list_repos", "List repositories you own that are inside the allowlist.",
    { per_page: z.number().max(100).default(50), page: z.number().default(1) },
    wrap(async ({ per_page, page }) => {
      const repos = await gh("GET", "/user/repos", { query: { per_page, page, sort: "updated", affiliation: "owner,collaborator" } });
      return repos.filter((r) => repoAllowed(r.owner.login, r.name)).map((r) => ({
        full_name: r.full_name, private: r.private, default_branch: r.default_branch, updated_at: r.updated_at, archived: r.archived,
      }));
    }));

  s.tool("gh_get_repo", "Get repository details and settings.", R,
    wrap(async ({ owner, repo }) => { assertRepo(owner, repo); return gh("GET", `/repos/${owner}/${repo}`); }));

  s.tool("gh_update_repo", "Update repo settings (description, homepage, visibility, default_branch, topics, features, archived).",
    { ...R, settings: z.record(z.any()).describe("Fields for PATCH /repos/{owner}/{repo}"), topics: z.array(z.string()).optional() },
    wrap(async ({ owner, repo, settings, topics }) => {
      assertRepo(owner, repo); assertWritable(); audit("update_repo", { owner, repo, keys: Object.keys(settings) });
      if (settings.visibility || settings.archived === true) assertDestructive(settings.confirm, `${owner}/${repo}`);
      delete settings.confirm;
      const out = await gh("PATCH", `/repos/${owner}/${repo}`, { body: settings });
      if (topics) await gh("PUT", `/repos/${owner}/${repo}/topics`, { body: { names: topics } });
      return { updated: out.full_name };
    }));

  // ---- Actions
  s.tool("gh_list_workflows", "List GitHub Actions workflows in a repo.", R,
    wrap(async ({ owner, repo }) => { assertRepo(owner, repo); return (await gh("GET", `/repos/${owner}/${repo}/actions/workflows`)).workflows.map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state })); }));

  s.tool("gh_list_runs", "List recent workflow runs, optionally filtered by branch/status/workflow.",
    { ...R, workflow: z.string().optional().describe("workflow id or filename"), branch: z.string().optional(), status: z.string().optional(), per_page: z.number().max(50).default(10) },
    wrap(async ({ owner, repo, workflow, branch, status, per_page }) => {
      assertRepo(owner, repo);
      const p = workflow ? `/repos/${owner}/${repo}/actions/workflows/${workflow}/runs` : `/repos/${owner}/${repo}/actions/runs`;
      const d = await gh("GET", p, { query: { branch, status, per_page } });
      return d.workflow_runs.map((r) => ({ id: r.id, name: r.name, branch: r.head_branch, status: r.status, conclusion: r.conclusion, event: r.event, created_at: r.created_at, url: r.html_url }));
    }));

  s.tool("gh_get_run_jobs", "Get jobs and steps for a workflow run (find which step failed).",
    { ...R, run_id: z.number() },
    wrap(async ({ owner, repo, run_id }) => {
      assertRepo(owner, repo);
      const d = await gh("GET", `/repos/${owner}/${repo}/actions/runs/${run_id}/jobs`);
      return d.jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, steps: j.steps.map((st) => ({ n: st.number, name: st.name, conclusion: st.conclusion })) }));
    }));

  s.tool("gh_get_job_logs", "Get the log text of one job (tail by default to save context).",
    { ...R, job_id: z.number(), tail_lines: z.number().default(200) },
    wrap(async ({ owner, repo, job_id, tail_lines }) => {
      assertRepo(owner, repo);
      const r = await gh("GET", `/repos/${owner}/${repo}/actions/jobs/${job_id}/logs`, { raw: true });
      const loc = r.headers.get("location"); if (!loc) throw new Error(`No log redirect (status ${r.status})`);
      const text = await (await fetch(loc)).text();
      return text.split("\n").slice(-tail_lines).join("\n");
    }));

  s.tool("gh_dispatch_workflow", "Trigger a workflow_dispatch run.",
    { ...R, workflow: z.string().describe("id or filename"), ref: z.string().default("main"), inputs: z.record(z.string()).optional() },
    wrap(async ({ owner, repo, workflow, ref, inputs }) => {
      assertRepo(owner, repo); assertWritable(); audit("dispatch", { owner, repo, workflow, ref });
      await gh("POST", `/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, { body: { ref, inputs } });
      return "Dispatched";
    }));

  s.tool("gh_rerun_run", "Re-run a workflow run (failed jobs only by default).",
    { ...R, run_id: z.number(), failed_only: z.boolean().default(true) },
    wrap(async ({ owner, repo, run_id, failed_only }) => {
      assertRepo(owner, repo); assertWritable(); audit("rerun", { owner, repo, run_id });
      await gh("POST", `/repos/${owner}/${repo}/actions/runs/${run_id}/${failed_only ? "rerun-failed-jobs" : "rerun"}`);
      return "Re-run requested";
    }));

  s.tool("gh_cancel_run", "Cancel an in-progress workflow run.", { ...R, run_id: z.number() },
    wrap(async ({ owner, repo, run_id }) => {
      assertRepo(owner, repo); assertWritable(); audit("cancel_run", { owner, repo, run_id });
      await gh("POST", `/repos/${owner}/${repo}/actions/runs/${run_id}/cancel`); return "Cancel requested";
    }));

  s.tool("gh_list_secret_names", "List Actions secret NAMES (values are never readable).", R,
    wrap(async ({ owner, repo }) => { assertRepo(owner, repo); return (await gh("GET", `/repos/${owner}/${repo}/actions/secrets`)).secrets.map((x) => x.name); }));

  // ---- Releases
  s.tool("gh_create_release", "Create a tag + release (can auto-generate notes). Returns release id and upload info.",
    { ...R, tag: z.string(), target: z.string().default("main"), name: z.string().optional(), body: z.string().optional(), draft: z.boolean().default(false), prerelease: z.boolean().default(false), generate_notes: z.boolean().default(true) },
    wrap(async ({ owner, repo, tag, target, name, body, draft, prerelease, generate_notes }) => {
      assertRepo(owner, repo); assertWritable(); audit("create_release", { owner, repo, tag });
      const r = await gh("POST", `/repos/${owner}/${repo}/releases`, { body: { tag_name: tag, target_commitish: target, name: name || tag, body, draft, prerelease, generate_release_notes: generate_notes } });
      return { id: r.id, url: r.html_url, tag: r.tag_name };
    }));

  s.tool("gh_upload_release_asset", "Upload a file to a release. Provide content_base64 OR source_url (https). Max 25 MB through this connector.",
    { ...R, release_id: z.number(), filename: z.string(), content_base64: z.string().optional(), source_url: z.string().url().optional(), content_type: z.string().default("application/octet-stream") },
    wrap(async ({ owner, repo, release_id, filename, content_base64, source_url, content_type }) => {
      assertRepo(owner, repo); assertWritable(); audit("upload_asset", { owner, repo, release_id, filename });
      let buf;
      if (content_base64) buf = Buffer.from(content_base64, "base64");
      else if (source_url) buf = Buffer.from(await (await fetch(source_url)).arrayBuffer());
      else throw new Error("Provide content_base64 or source_url");
      if (buf.length > 25 * 1024 * 1024) throw new Error("File too large for this connector (25 MB)");
      const a = await gh("POST", `https://uploads.github.com/repos/${owner}/${repo}/releases/${release_id}/assets`, { query: { name: filename }, body: buf, headers: { "Content-Type": content_type } });
      return { name: a.name, size: a.size, url: a.browser_download_url };
    }));

  // ---- Branch protection
  s.tool("gh_get_branch_protection", "Read branch protection rules.", { ...R, branch: z.string().default("main") },
    wrap(async ({ owner, repo, branch }) => { assertRepo(owner, repo); return gh("GET", `/repos/${owner}/${repo}/branches/${branch}/protection`); }));

  s.tool("gh_set_branch_protection", "Set branch protection. Provide the full GitHub protection payload.",
    { ...R, branch: z.string().default("main"), rules: z.record(z.any()) },
    wrap(async ({ owner, repo, branch, rules }) => {
      assertRepo(owner, repo); assertWritable(); audit("set_protection", { owner, repo, branch });
      await gh("PUT", `/repos/${owner}/${repo}/branches/${branch}/protection`, { body: rules }); return "Protection updated";
    }));

  // ---- Webhooks
  s.tool("gh_list_webhooks", "List repo webhooks.", R,
    wrap(async ({ owner, repo }) => { assertRepo(owner, repo); return (await gh("GET", `/repos/${owner}/${repo}/hooks`)).map((h) => ({ id: h.id, url: h.config.url, events: h.events, active: h.active })); }));

  s.tool("gh_create_webhook", "Create a webhook.", { ...R, url: z.string().url(), events: z.array(z.string()).default(["push"]), secret: z.string().optional() },
    wrap(async ({ owner, repo, url, events, secret }) => {
      assertRepo(owner, repo); assertWritable(); audit("create_webhook", { owner, repo, url });
      const h = await gh("POST", `/repos/${owner}/${repo}/hooks`, { body: { name: "web", active: true, events, config: { url, content_type: "json", secret } } });
      return { id: h.id };
    }));

  s.tool("gh_delete_webhook", "Delete a webhook (needs confirm = \"owner/repo#hook_id\").", { ...R, hook_id: z.number(), confirm: z.string() },
    wrap(async ({ owner, repo, hook_id, confirm }) => {
      assertRepo(owner, repo); assertDestructive(confirm, `${owner}/${repo}#${hook_id}`); audit("delete_webhook", { owner, repo, hook_id });
      await gh("DELETE", `/repos/${owner}/${repo}/hooks/${hook_id}`); return "Deleted";
    }));

  // ---- Pages
  s.tool("gh_get_pages", "Get GitHub Pages config.", R,
    wrap(async ({ owner, repo }) => { assertRepo(owner, repo); return gh("GET", `/repos/${owner}/${repo}/pages`); }));

  s.tool("gh_enable_pages", "Enable GitHub Pages from a branch/folder.", { ...R, branch: z.string().default("main"), path: z.enum(["/", "/docs"]).default("/") },
    wrap(async ({ owner, repo, branch, path }) => {
      assertRepo(owner, repo); assertWritable(); audit("enable_pages", { owner, repo });
      return gh("POST", `/repos/${owner}/${repo}/pages`, { body: { source: { branch, path } } });
    }));

  // ---- Deploy keys / collaborators (read)
  s.tool("gh_list_deploy_keys", "List deploy keys.", R,
    wrap(async ({ owner, repo }) => { assertRepo(owner, repo); return (await gh("GET", `/repos/${owner}/${repo}/keys`)).map((k) => ({ id: k.id, title: k.title, read_only: k.read_only })); }));

  // ---- Destructive
  s.tool("gh_delete_repo", "PERMANENTLY delete a repository. Needs ENABLE_DESTRUCTIVE=true and confirm = \"owner/repo\". Token must have Administration permission.",
    { ...R, confirm: z.string() },
    wrap(async ({ owner, repo, confirm }) => {
      assertRepo(owner, repo); assertDestructive(confirm, `${owner}/${repo}`); audit("DELETE_REPO", { owner, repo });
      await gh("DELETE", `/repos/${owner}/${repo}`); return `Deleted ${owner}/${repo}`;
    }));

  // ---- Escape hatch for "full control"
  s.tool("gh_api", "Call any GitHub REST endpoint. Repo paths must be inside the allowlist. DELETE needs ENABLE_DESTRUCTIVE and confirm = the exact path. Non-repo paths are GET only.",
    { method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().describe("e.g. /repos/Zohaib8090/KodrixIDE/issues"), query: z.record(z.string()).optional(), body: z.record(z.any()).optional(), confirm: z.string().optional() },
    wrap(async ({ method, path, query, body, confirm }) => {
      if (!path.startsWith("/") || path.includes("..")) throw new Error("Invalid path");
      const m = path.match(/^\/repos\/([^/]+)\/([^/?]+)/);
      if (m) assertRepo(m[1], m[2]);
      else if (method !== "GET") throw new Error("Only GET is allowed outside /repos/{owner}/{repo}");
      if (method !== "GET") audit("api", { method, path });
      if (method === "DELETE") assertDestructive(confirm, path);
      else if (method !== "GET") assertWritable();
      return gh(method, path, { query, body });
    }));

  return s;
}

// ---------------------------------------------------------------- HTTP
const app = express();
app.use(express.json({ limit: "35mb" }));

app.get("/", (_req, res) => res.send("ok"));
app.get("/healthz", (_req, res) => res.send("ok"));

const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function handleMcp(req, res) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const provided = req.params.secret || bearer;
  if (!provided || !safeEq(provided, MCP_SECRET)) return res.status(401).json({ error: "unauthorized" });
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
app.post("/mcp/:secret", handleMcp);
app.post("/mcp", handleMcp);
const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get("/mcp/:secret", notAllowed); app.get("/mcp", notAllowed);
app.delete("/mcp/:secret", notAllowed); app.delete("/mcp", notAllowed);

app.listen(PORT, () => console.log(`github-mcp listening on :${PORT} (read_only=${READ_ONLY}, destructive=${ENABLE_DESTRUCTIVE})`));

// keep the free Render instance awake
if (SELF_URL) setInterval(() => fetch(`${SELF_URL}/healthz`).catch(() => {}), 10 * 60 * 1000);
