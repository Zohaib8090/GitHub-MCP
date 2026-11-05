import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { als, currentToken } from "./src/context.js";
import { makeSealer } from "./src/crypto.js";
import { createOAuth } from "./src/oauth.js";
import { GITHUB_TOKEN, GITHUB_API_URL, GITHUB_WEB_URL, ALLOWED_REPOS, FULL_CONTROL, READ_ONLY, ENABLE_DESTRUCTIVE,
  repoAllowed, assertRepo, assertWritable, assertDestructive, audit, gh, ok, wrap, R } from "./src/core.js";
import { registerAllTools, activeToolsets, toolCount } from "./src/tools/index.js";

// ---------------------------------------------------------------- config
// AUTH_MODE=oauth  (default when GITHUB_CLIENT_ID is set): sign in with GitHub, per-user encrypted tokens.
// AUTH_MODE=static: one GITHUB_TOKEN (PAT) + secret URL. Handy for local dev only.
const AUTH_MODE = process.env.AUTH_MODE || (process.env.GITHUB_CLIENT_ID ? "oauth" : "static");
const MCP_SECRET = process.env.MCP_SECRET; // static mode only: long random string, part of the URL
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL; // set automatically on Render

function die(msg) { console.error(msg); process.exit(1); }
let oauth = null;
if (AUTH_MODE === "oauth") {
  for (const k of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "ENCRYPTION_KEY", "ALLOWED_GITHUB_USERS"]) {
    if (!process.env[k]) die(`${k} is required in oauth mode`);
  }
  const baseUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  if (!baseUrl) die("PUBLIC_URL is required in oauth mode (your https URL, no trailing slash)");
  let sealer; try { sealer = makeSealer(process.env.ENCRYPTION_KEY); } catch (e) { die(e.message); }
  const list = (v) => (v || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  oauth = createOAuth({
    baseUrl,
    githubClientId: process.env.GITHUB_CLIENT_ID,
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
    githubWeb: GITHUB_WEB_URL,
    githubApi: GITHUB_API_URL,
    scopes: process.env.GITHUB_SCOPES || "repo workflow delete_repo admin:repo_hook admin:org gist notifications user project codespace write:packages delete:packages admin:public_key admin:gpg_key write:discussion",
    allowedUsers: list(process.env.ALLOWED_GITHUB_USERS),
    allowedRedirectHosts: list(process.env.ALLOWED_REDIRECT_HOSTS || "claude.ai,claude.com"),
    allowLocalhost: process.env.ALLOW_LOCALHOST_REDIRECTS === "true",
    accessTtl: Number(process.env.ACCESS_TOKEN_TTL || 3600),
    refreshTtl: Number(process.env.REFRESH_TOKEN_TTL || 30 * 24 * 3600),
  }, sealer, (e) => console.log(JSON.stringify({ t: new Date().toISOString(), ...e })));
} else {
  if (!GITHUB_TOKEN) {
    die("No auth configured. OAuth mode: set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ENCRYPTION_KEY and " +
        "ALLOWED_GITHUB_USERS (or AUTH_MODE=oauth). Static mode: set GITHUB_TOKEN and MCP_SECRET.");
  }
  if (!MCP_SECRET || MCP_SECRET.length < 24) die("MCP_SECRET (24+ chars) is required in static mode");
}
if (!FULL_CONTROL && !ALLOWED_REPOS.length) { console.error("ALLOWED_REPOS is required when FULL_CONTROL=false"); process.exit(1); }

// ---------------------------------------------------------------- tools
function buildServer() {
  const s = new McpServer({ name: "github-custom", version: "2.0.0" });

  s.tool("gh_whoami", "Show the GitHub user the token belongs to, plus active guardrail settings.", {},
    wrap(async () => {
      const me = await gh("GET", "/user");
      return { login: me.login, auth_mode: AUTH_MODE, full_control: FULL_CONTROL, allowed_repos: FULL_CONTROL ? "all" : ALLOWED_REPOS, read_only: READ_ONLY, destructive_enabled: ENABLE_DESTRUCTIVE, toolsets: activeToolsets(), tool_count: toolCount() };
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
    { ...R, settings: z.record(z.string(), z.any()).describe("Fields for PATCH /repos/{owner}/{repo}"), topics: z.array(z.string()).optional() },
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
    { ...R, workflow: z.string().describe("id or filename"), ref: z.string().default("main"), inputs: z.record(z.string(), z.string()).optional() },
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

  s.tool("gh_set_actions_secret", "Create or update a repo Actions secret (value is encrypted client-side before sending).",
    { ...R, name: z.string(), value: z.string() },
    wrap(async ({ owner, repo, name, value }) => {
      assertRepo(owner, repo); assertWritable(); audit("set_secret", { owner, repo, name });
      const sodium = (await import("libsodium-wrappers")).default; await sodium.ready;
      const pk = await gh("GET", `/repos/${owner}/${repo}/actions/secrets/public-key`);
      const key = sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL);
      const enc = sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(value), key), sodium.base64_variants.ORIGINAL);
      await gh("PUT", `/repos/${owner}/${repo}/actions/secrets/${name}`, { body: { encrypted_value: enc, key_id: pk.key_id } });
      return `Secret ${name} set`;
    }));

  s.tool("gh_list_secret_names","List Actions secret NAMES (values are never readable).", R,
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
    { ...R, branch: z.string().default("main"), rules: z.record(z.string(), z.any()) },
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

  s.tool("gh_delete_webhook", "Delete a webhook (needs confirm = \"owner/repo#hook_id\").", { ...R, hook_id: z.number(), confirm: z.string().optional() },
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
    { ...R, confirm: z.string().optional() },
    wrap(async ({ owner, repo, confirm }) => {
      assertRepo(owner, repo); assertDestructive(confirm, `${owner}/${repo}`); audit("DELETE_REPO", { owner, repo });
      await gh("DELETE", `/repos/${owner}/${repo}`); return `Deleted ${owner}/${repo}`;
    }));

  // ---- Escape hatch for "full control"
  s.tool("gh_api", "Call any GitHub REST endpoint. Repo paths must be inside the allowlist. DELETE needs ENABLE_DESTRUCTIVE and confirm = the exact path. Non-repo paths are GET only.",
    { method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().describe("e.g. /repos/Zohaib8090/KodrixIDE/issues"), query: z.record(z.string(), z.string()).optional(), body: z.record(z.string(), z.any()).optional(), confirm: z.string().optional() },
    wrap(async ({ method, path, query, body, confirm }) => {
      if (!path.startsWith("/") || path.includes("..")) throw new Error("Invalid path");
      const m = path.match(/^\/repos\/([^/]+)\/([^/?]+)/);
      if (m) assertRepo(m[1], m[2]);
      else if (method !== "GET" && !FULL_CONTROL) throw new Error("Only GET is allowed outside /repos/{owner}/{repo}");
      if (method !== "GET") audit("api", { method, path });
      if (method === "DELETE") assertDestructive(confirm, path);
      else if (method !== "GET") assertWritable();
      return gh(method, path, { query, body });
    }));

  registerAllTools(s);
  return s;
}

// ---------------------------------------------------------------- HTTP
const app = express();
app.set("trust proxy", 1); // Render terminates TLS in front of us
app.disable("x-powered-by");
app.use((_req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); next(); });
if (oauth) app.use(oauth.router); // /.well-known/*, /register, /authorize, /token, /revoke, /github/callback
app.use("/mcp", express.json({ limit: "35mb" }));

app.get("/", (_req, res) => res.send("ok"));
app.get("/healthz", (_req, res) => res.send("ok"));

const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Returns the request context ({ token, sub }) or null after sending a 401.
function authenticate(req, res) {
  if (AUTH_MODE === "oauth") {
    const ctx = oauth.authenticate(req);
    if (ctx) return ctx;
    res.set("WWW-Authenticate", `Bearer resource_metadata="${oauth.baseUrl}/.well-known/oauth-protected-resource"`);
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const provided = req.params.secret || bearer;
  if (!provided || !safeEq(provided, MCP_SECRET)) { res.status(401).json({ error: "unauthorized" }); return null; }
  return { token: GITHUB_TOKEN, sub: "static" };
}

async function handleMcp(req, res) {
  const ctx = authenticate(req, res);
  if (!ctx) return;
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await als.run(ctx, async () => {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
}
const notAllowed = (req, res) => {
  if (!authenticate(req, res)) return;
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
};
if (AUTH_MODE === "static") { app.post("/mcp/:secret", handleMcp); app.get("/mcp/:secret", notAllowed); app.delete("/mcp/:secret", notAllowed); }
app.post("/mcp", handleMcp);
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

app.listen(PORT, () => console.log(`github-mcp listening on :${PORT} (auth=${AUTH_MODE}, full_control=${FULL_CONTROL}, read_only=${READ_ONLY}, destructive=${ENABLE_DESTRUCTIVE})`));

// keep the free Render instance awake
// Keep-alive: Render's free tier sleeps after ~15 min without inbound traffic. Pinging our own public URL
// (through Render's proxy, so it counts as inbound) every few minutes keeps the instance awake.
// Set KEEPALIVE_MINUTES=0 to disable, or to another number to change the interval (default 4).
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MINUTES ?? 4) * 60 * 1000;
if (SELF_URL && KEEPALIVE_MS > 0) {
  const ping = async () => {
    try {
      const r = await fetch(`${SELF_URL}/healthz`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) console.log(JSON.stringify({ t: new Date().toISOString(), keepalive: "bad_status", status: r.status }));
    } catch (e) {
      console.log(JSON.stringify({ t: new Date().toISOString(), keepalive: "failed", error: String(e.message || e) }));
    }
  };
  setInterval(ping, KEEPALIVE_MS).unref();
  console.log(`keep-alive: pinging ${SELF_URL}/healthz every ${KEEPALIVE_MS / 60000} min`);
}
