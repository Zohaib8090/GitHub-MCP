import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { ALL_SPECS, ALL_CUSTOM, BUILTIN, TOOLSETS, enabledToolsets, toolCount } from "../src/tools/index.js";
import { ok } from "../src/core.js";

// Every declarative tool is called against a recording mock GitHub; custom tools get scenario tests.
const SECRET = "s".repeat(32);
const calls = [];
let routes = {};
let mock, full, guard;

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function start(env) {
  const port = await freePort();
  const proc = spawn(process.execPath, ["server.js"], {
    env: { PATH: process.env.PATH, PORT: String(port), AUTH_MODE: "static", GITHUB_TOKEN: "ghp_test", MCP_SECRET: SECRET,
      GITHUB_API_URL: `http://127.0.0.1:${mock.address().port}`, ...env },
  });
  await new Promise((res, rej) => {
    proc.stdout.on("data", (d) => { if (String(d).includes("listening")) res(); });
    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.on("exit", (c) => rej(new Error(`server exited (${c})`)));
    setTimeout(() => rej(new Error("start timeout")), 8000).unref();
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

before(async () => {
  mock = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const rec = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: raw ? JSON.parse(raw) : undefined, accept: req.headers.accept };
      calls.push(rec);
      const r = routes[`${req.method} ${u.pathname}`];
      const out = typeof r === "function" ? r(rec) : r;
      const status = out?.status ?? 200;
      res.statusCode = status;
      if (out && "text" in out) { res.setHeader("Content-Type", "text/plain"); return res.end(out.text); }
      res.setHeader("Content-Type", "application/json");
      res.end(status === 204 ? "" : JSON.stringify(out && "json" in out ? out.json : out ?? {}));
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  full = await start({ FULL_CONTROL: "true" });
  guard = await start({ FULL_CONTROL: "false", ALLOWED_REPOS: "o/r", ENABLE_DESTRUCTIVE: "true" });
});
after(() => { full?.proc.kill(); guard?.proc.kill(); mock?.close(); });

let id = 0;
async function rpc(srv, method, params) {
  const r = await fetch(`${srv.base}/mcp/${SECRET}`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await r.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  const msg = JSON.parse(line ? line.slice(5) : text);
  if (msg.error) throw new Error(JSON.stringify(msg.error));
  return msg.result;
}
async function call(srv, name, args = {}) {
  calls.length = 0;
  const r = await rpc(srv, "tools/call", { name, arguments: args });
  const text = r.content[0].text;
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { isError: !!r.isError, text, json, calls: [...calls] };
}

// ---------------------------------------------------------------- catalogue sanity
test("catalogue: unique names, valid DSL, all toolsets populated", () => {
  const names = [...BUILTIN, ...ALL_SPECS.map((s) => s.name), ...ALL_CUSTOM.map((c) => c.name)];
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((n) => /^gh_[a-z0-9_]+$/.test(n)), "tool names must be snake_case gh_*");
  assert.ok(ALL_SPECS.length >= 300, `expected 300+ declarative tools, got ${ALL_SPECS.length}`);
  for (const t of [...ALL_SPECS, ...ALL_CUSTOM]) assert.ok(t.description && t.description.length > 8, `${t.name} needs a description`);
  assert.equal(toolCount(), names.length);
});

test("toolset selection: all, allow-list and negatives", () => {
  assert.deepEqual([...enabledToolsets("all")].sort(), TOOLSETS);
  assert.deepEqual([...enabledToolsets("issues,pulls")].sort(), ["issues", "pulls"]);
  const neg = enabledToolsets("all,-codespaces,-packages");
  assert.ok(!neg.has("codespaces") && !neg.has("packages") && neg.has("repos"));
});

test("ok(): null/undefined become OK", () => {
  assert.equal(ok(null).content[0].text, "OK");
  assert.equal(ok("hi").content[0].text, "hi");
});

test("tools/list exposes every tool", async () => {
  const r = await rpc(full, "tools/list", {});
  assert.equal(r.tools.length, toolCount());
  const w = await call(full, "gh_whoami");
  routes["GET /user"] = { login: "me" };
  assert.equal(r.tools.some((t) => t.name === "gh_push_files"), true);
});

// ---------------------------------------------------------------- generic wiring for every declarative tool
const SAMPLE = { s: "v", n: 3, b: true, sa: ["a", "b"], na: [1], o: { k: 1 }, oa: [{ k: 1 }], j: "j" };
const sample = (t) => { const m = /^e\((.+)\)$/.exec(t); return m ? m[1].split("|")[0] : SAMPLE[t]; };

test("every declarative tool sends the right method, path, query and body", async () => {
  routes = {};
  const failures = [];
  for (const spec of ALL_SPECS) {
    const args = {};
    const pv = {};
    for (const [n, v] of Object.entries(spec.pathVars)) { args[n] = v.star ? "feat/x" : v.type === "n" ? 7 : `${n}1`; pv[n] = args[n]; }
    const qb = {};
    for (const tok of spec.params.split(/\s+/).filter(Boolean)) {
      const m = /^([qb])\.(\w+)\??:(.+)$/.exec(tok);
      args[m[2]] = sample(m[3]); qb[m[2]] = m[1];
    }
    const r = await call(full, spec.name, args);
    const c = r.calls[0];
    const expectedPath = spec.pathTpl.replace(/\{(\w+)\}/g, (_, n) => (spec.pathVars[n].star ? String(pv[n]).split("/").map(encodeURIComponent).join("/") : encodeURIComponent(String(pv[n]))));
    const problems = [];
    if (r.isError) problems.push(`error: ${r.text}`);
    if (r.calls.length !== 1) problems.push(`expected 1 request, got ${r.calls.length}`);
    if (c) {
      if (c.method !== spec.method) problems.push(`method ${c.method}`);
      if (c.path !== decodeURI(expectedPath).replace(/%2F/gi, "/") && c.path !== expectedPath) {
        if (decodeURIComponent(c.path) !== decodeURIComponent(expectedPath)) problems.push(`path ${c.path} != ${expectedPath}`);
      }
      if (/[{}]|undefined/.test(c.path)) problems.push("unresolved path");
      const wantQ = spec.query.filter((k) => k in args).sort();
      if (JSON.stringify(Object.keys(c.query).sort()) !== JSON.stringify(wantQ)) problems.push(`query ${Object.keys(c.query)} != ${wantQ}`);
      const wantB = spec.body.sort();
      const gotB = Object.keys(c.body || {}).sort();
      if (spec.method !== "GET" && wantB.length && JSON.stringify(gotB) !== JSON.stringify([...wantB])) problems.push(`body ${gotB} != ${wantB}`);
      if (spec.method === "GET" && c.body) problems.push("GET with body");
      if (spec.opts.accept && c.accept !== spec.opts.accept) problems.push("accept header");
    }
    if (problems.length) failures.push(`${spec.name}: ${problems.join("; ")}`);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("slimming: pick/listKey shrink responses unless full=true", async () => {
  routes = { "GET /repos/o/r/branches": [{ name: "main", protected: true, commit: { sha: "abc", url: "u" }, _links: {} }] };
  let r = await call(full, "gh_list_branches", { owner: "o", repo: "r" });
  assert.deepEqual(r.json, [{ name: "main", protected: true, commit: { sha: "abc" } }]);
  r = await call(full, "gh_list_branches", { owner: "o", repo: "r", full: true });
  assert.ok(r.json[0]._links);
  routes = { "GET /repos/o/r/actions/runs/7/artifacts": { total_count: 1, artifacts: [{ id: 1, name: "a", size_in_bytes: 5, junk: 1 }] } };
  r = await call(full, "gh_list_run_artifacts", { owner: "o", repo: "r", run_id: 7 });
  assert.deepEqual(r.json, { total_count: 1, items: [{ id: 1, name: "a", size_in_bytes: 5 }] });
  routes = {};
});

test("204 responses come back as OK; GitHub errors surface as tool errors", async () => {
  routes = { "PUT /user/starred/o/r": { status: 204 }, "GET /user/orgs": { status: 403, json: { message: "nope" } } };
  assert.equal((await call(full, "gh_star_repo", { owner: "o", repo: "r" })).text, "OK");
  const e = await call(full, "gh_list_user_orgs");
  assert.ok(e.isError && /GitHub 403/.test(e.text));
  routes = {};
});

// ---------------------------------------------------------------- custom tools
const SHA = "a".repeat(40);

test("gh_get_file decodes content and lists directories", async () => {
  routes = { "GET /repos/o/r/contents/src/a.txt": { path: "src/a.txt", sha: "s1", size: 5, encoding: "base64", content: Buffer.from("héllo").toString("base64") },
    "GET /repos/o/r/contents/src": [{ name: "a.txt", type: "file", size: 5, path: "src/a.txt", url: "x" }] };
  assert.equal((await call(full, "gh_get_file", { owner: "o", repo: "r", path: "src/a.txt" })).json.content, "héllo");
  assert.deepEqual((await call(full, "gh_get_file", { owner: "o", repo: "r", path: "src" })).json, [{ name: "a.txt", type: "file", size: 5, path: "src/a.txt" }]);
});

test("gh_put_file creates, then updates with the looked-up sha", async () => {
  let exists = false;
  routes = {
    "GET /repos/o/r/contents/new.md": () => (exists ? { sha: "old-sha", path: "new.md" } : { status: 404, json: { message: "Not Found" } }),
    "PUT /repos/o/r/contents/new.md": () => ({ commit: { sha: "c1", html_url: "u" }, content: { sha: "f1" } }),
  };
  let r = await call(full, "gh_put_file", { owner: "o", repo: "r", path: "new.md", content: "hi", message: "m" });
  const put1 = r.calls.find((c) => c.method === "PUT");
  assert.equal(put1.body.sha, undefined);
  assert.equal(Buffer.from(put1.body.content, "base64").toString(), "hi");
  assert.equal(r.json.created, true);
  exists = true;
  r = await call(full, "gh_put_file", { owner: "o", repo: "r", path: "new.md", content: "bye", message: "m", branch: "dev" });
  assert.equal(r.calls.find((c) => c.method === "PUT").body.sha, "old-sha");
  assert.equal(r.json.created, false);
});

test("gh_push_files makes one commit with adds, edits and deletes", async () => {
  let n = 0;
  routes = {
    "GET /repos/o/r": { default_branch: "main", size: 10 },
    "GET /repos/o/r/git/ref/heads/main": { object: { sha: "c1" } },
    "GET /repos/o/r/git/commits/c1": { tree: { sha: "t1" } },
    "POST /repos/o/r/git/blobs": () => ({ sha: `b${++n}` }),
    "POST /repos/o/r/git/trees": { sha: "t2" },
    "POST /repos/o/r/git/commits": { sha: "c2", html_url: "u" },
    "PATCH /repos/o/r/git/refs/heads/main": { object: { sha: "c2" } },
  };
  const r = await call(full, "gh_push_files", { owner: "o", repo: "r", message: "multi", files: [{ path: "a.txt", content: "A" }, { path: "dir/b.bin", content: "QQ==", encoding: "base64" }, { path: "gone.txt", delete: true }] });
  assert.ok(!r.isError, r.text);
  const tree = r.calls.find((c) => c.path.endsWith("/git/trees")).body;
  assert.equal(tree.base_tree, "t1");
  assert.deepEqual(tree.tree.map((t) => [t.path, t.sha]), [["a.txt", "b1"], ["dir/b.bin", "b2"], ["gone.txt", null]]);
  const blob2 = r.calls.filter((c) => c.path.endsWith("/git/blobs"))[1].body;
  assert.deepEqual(blob2, { content: "QQ==", encoding: "base64" });
  assert.deepEqual(r.calls.find((c) => c.path.endsWith("/git/commits") && c.method === "POST").body.parents, ["c1"]);
  assert.equal(r.calls.at(-1).body.sha, "c2");
  assert.equal(r.json.commit, "c2");
});

test("gh_push_files creates a missing branch and bootstraps an empty repo", async () => {
  // missing branch -> created from default branch head
  routes = {
    "GET /repos/o/r": { default_branch: "main", size: 10 },
    "GET /repos/o/r/git/ref/heads/feat": { status: 404, json: { message: "Not Found" } },
    "GET /repos/o/r/commits/main": { text: SHA },
    "POST /repos/o/r/git/refs": { ref: "refs/heads/feat", object: { sha: SHA } },
    [`GET /repos/o/r/git/commits/${SHA}`]: { tree: { sha: "t1" } },
    "POST /repos/o/r/git/blobs": { sha: "b1" }, "POST /repos/o/r/git/trees": { sha: "t2" },
    "POST /repos/o/r/git/commits": { sha: "c2", html_url: "u" }, "PATCH /repos/o/r/git/refs/heads/feat": {},
  };
  let r = await call(full, "gh_push_files", { owner: "o", repo: "r", branch: "feat", message: "m", files: [{ path: "a", content: "x" }] });
  assert.ok(!r.isError, r.text);
  assert.deepEqual(r.calls.find((c) => c.method === "POST" && c.path.endsWith("/git/refs")).body, { ref: "refs/heads/feat", sha: SHA });

  // empty repo -> first file through the contents API
  let refCalls = 0;
  routes = {
    "GET /repos/o/e": { default_branch: "main", size: 0 },
    "GET /repos/o/e/git/ref/heads/main": () => (++refCalls === 1 ? { status: 409, json: { message: "Git Repository is empty." } } : { object: { sha: "c1" } }),
    "PUT /repos/o/e/contents/README.md": { commit: { sha: "c1", html_url: "u" }, content: {} },
    "GET /repos/o/e/git/commits/c1": { tree: { sha: "t1" } },
    "POST /repos/o/e/git/blobs": { sha: "b1" }, "POST /repos/o/e/git/trees": { sha: "t2" },
    "POST /repos/o/e/git/commits": { sha: "c2", html_url: "u" }, "PATCH /repos/o/e/git/refs/heads/main": {},
  };
  r = await call(full, "gh_push_files", { owner: "o", repo: "e", message: "init", files: [{ path: "README.md", content: "# hi" }, { path: "src/x.js", content: "1" }] });
  assert.ok(!r.isError, r.text);
  assert.equal(r.json.bootstrap_commit, "c1");
  assert.equal(r.json.commit, "c2");
});

test("gh_create_repo defaults to private and uses the right endpoint", async () => {
  routes = { "GET /user": { login: "me" }, "POST /user/repos": { full_name: "me/x", html_url: "u", private: true, default_branch: "main", clone_url: "c" },
    "POST /orgs/acme/repos": { full_name: "acme/x", html_url: "u", private: true, default_branch: "main", clone_url: "c" } };
  let r = await call(full, "gh_create_repo", { name: "x" });
  assert.equal(r.calls.find((c) => c.method === "POST").body.private, true);
  assert.equal(r.json.full_name, "me/x");
  r = await call(full, "gh_create_repo", { name: "x", org: "acme", private: false });
  assert.ok(r.calls.some((c) => c.path === "/orgs/acme/repos" && c.body.private === false));
});

test("gh_create_branch / gh_create_tag (annotated) / gh_update_ref", async () => {
  routes = { "GET /repos/o/r": { default_branch: "main" }, "GET /repos/o/r/commits/main": { text: SHA },
    "POST /repos/o/r/git/refs": (c) => ({ ref: c.body.ref, object: { sha: c.body.sha } }),
    "POST /repos/o/r/git/tags": { sha: "tagobj" }, "PATCH /repos/o/r/git/refs/heads/main": { ref: "refs/heads/main", object: { sha: SHA } } };
  let r = await call(full, "gh_create_branch", { owner: "o", repo: "r", branch: "x" });
  assert.deepEqual(r.json, { ref: "refs/heads/x", sha: SHA });
  r = await call(full, "gh_create_tag", { owner: "o", repo: "r", tag: "v1", message: "release" });
  assert.deepEqual(r.calls.find((c) => c.path.endsWith("/git/refs")).body, { ref: "refs/tags/v1", sha: "tagobj" });
  assert.equal(r.json.annotated, true);
  r = await call(full, "gh_create_tag", { owner: "o", repo: "r", tag: "v0" });
  assert.deepEqual(r.calls.find((c) => c.path.endsWith("/git/refs")).body, { ref: "refs/tags/v0", sha: SHA });
  r = await call(full, "gh_update_ref", { owner: "o", repo: "r", ref: "heads/main", sha: SHA, force: true });
  assert.equal(r.calls[0].body.force, true);
});

test("gh_get_pull_diff, copilot review, draft toggle, search pulls", async () => {
  routes = { "GET /repos/o/r/pulls/5": (c) => (c.accept.includes("diff") ? { text: "diff --git a b" } : { draft: false, node_id: "PR_1" }),
    "POST /repos/o/r/pulls/5/requested_reviewers": {}, "POST /graphql": { data: { ok: 1 } },
    "GET /search/issues": { total_count: 1, items: [{ number: 5, title: "t", state: "open", user: { login: "me" }, repository_url: "https://api.github.com/repos/o/r", html_url: "u" }] } };
  assert.equal((await call(full, "gh_get_pull_diff", { owner: "o", repo: "r", pull_number: 5 })).text, "diff --git a b");
  let r = await call(full, "gh_request_copilot_review", { owner: "o", repo: "r", pull_number: 5 });
  assert.deepEqual(r.calls[0].body.reviewers, ["copilot-pull-request-reviewer[bot]"]);
  r = await call(full, "gh_set_pull_draft", { owner: "o", repo: "r", pull_number: 5, draft: true });
  assert.match(r.calls.find((c) => c.path === "/graphql").body.query, /convertPullRequestToDraft/);
  r = await call(full, "gh_search_pulls", { query: "repo:o/r is:open" });
  assert.equal(r.calls[0].query.q, "is:pr repo:o/r is:open");
  assert.equal(r.json.items[0].repo, "o/r");
});

test("gh_set_variable upserts; gh_get_run_logs_url returns the redirect", async () => {
  let exists = false;
  routes = { "PATCH /repos/o/r/actions/variables/V": () => (exists ? {} : { status: 404, json: { message: "nf" } }), "POST /repos/o/r/actions/variables": { status: 201 },
    "GET /repos/o/r/actions/runs/9/logs": () => ({ status: 302 }) };
  assert.match((await call(full, "gh_set_variable", { owner: "o", repo: "r", name: "V", value: "1" })).text, /created/);
  exists = true;
  assert.match((await call(full, "gh_set_variable", { owner: "o", repo: "r", name: "V", value: "2" })).text, /updated/);
  const l = await call(full, "gh_get_run_logs_url", { owner: "o", repo: "r", run_id: 9 });
  assert.ok(l.isError && /No redirect/.test(l.text)); // mock gave no Location header
});

test("gh_list_files filters by prefix; gists transform files; graphql errors surface", async () => {
  routes = { "GET /repos/o/r": { default_branch: "main" },
    "GET /repos/o/r/git/trees/main": { truncated: false, tree: [{ type: "blob", path: "src/a.js", size: 1 }, { type: "tree", path: "src" }, { type: "blob", path: "README.md", size: 2 }] } };
  let r = await call(full, "gh_list_files", { owner: "o", repo: "r", path_prefix: "src/" });
  assert.deepEqual(r.json.files, [{ path: "src/a.js", size: 1 }]);
  routes = { "POST /gists": { id: "g1", html_url: "u", public: false }, "PATCH /gists/g1": { id: "g1", html_url: "u" } };
  r = await call(full, "gh_create_gist", { files: { "a.txt": "A" } });
  assert.deepEqual(r.calls[0].body.files, { "a.txt": { content: "A" } });
  r = await call(full, "gh_update_gist", { gist_id: "g1", files: { "a.txt": null, "b.txt": "B" } });
  assert.deepEqual(r.calls[0].body.files, { "a.txt": null, "b.txt": { content: "B" } });
  routes = { "POST /graphql": { errors: [{ message: "bad" }] } };
  r = await call(full, "gh_graphql", { query: "{ viewer { login } }" });
  assert.ok(r.isError && /GraphQL/.test(r.text));
});

test("secrets are sealed client-side (environment / dependabot / org)", async () => {
  const sodium = (await import("libsodium-wrappers")).default; await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const key = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  routes = {
    "GET /repos/o/r/environments/prod/secrets/public-key": { key, key_id: "k1" }, "PUT /repos/o/r/environments/prod/secrets/TOK": { status: 201 },
    "GET /repos/o/r/dependabot/secrets/public-key": { key, key_id: "k2" }, "PUT /repos/o/r/dependabot/secrets/TOK": { status: 201 },
    "GET /orgs/acme/actions/secrets/public-key": { key, key_id: "k3" }, "PUT /orgs/acme/actions/secrets/TOK": { status: 201 },
  };
  for (const [tool, args, keyId] of [["gh_set_environment_secret", { owner: "o", repo: "r", environment_name: "prod", name: "TOK", value: "hunter2" }, "k1"],
    ["gh_set_dependabot_secret", { owner: "o", repo: "r", name: "TOK", value: "hunter2" }, "k2"], ["gh_set_org_actions_secret", { org: "acme", name: "TOK", value: "hunter2" }, "k3"]]) {
    const r = await call(full, tool, args);
    assert.ok(!r.isError, r.text);
    const put = r.calls.find((c) => c.method === "PUT").body;
    assert.equal(put.key_id, keyId);
    const plain = sodium.crypto_box_seal_open(sodium.from_base64(put.encrypted_value, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey);
    assert.equal(sodium.to_string(plain), "hunter2");
    assert.ok(!JSON.stringify(put).includes("hunter2"));
  }
});

// ---------------------------------------------------------------- guard mode (FULL_CONTROL=false)
test("guard mode: allowlist, confirmations, no writes outside allowed repos, no GraphQL mutations", async () => {
  routes = {};
  let r = await call(guard, "gh_list_issues", { owner: "o", repo: "other" });
  assert.ok(r.isError && /ALLOWED_REPOS/.test(r.text) && r.calls.length === 0);
  r = await call(guard, "gh_list_issues", { owner: "o", repo: "r" });
  assert.ok(!r.isError);
  r = await call(guard, "gh_delete_label", { owner: "o", repo: "r", label_name: "bug" });
  assert.ok(r.isError && /Confirmation required/.test(r.text) && r.calls.length === 0);
  r = await call(guard, "gh_delete_label", { owner: "o", repo: "r", label_name: "bug", confirm: "/repos/o/r/labels/bug" });
  assert.ok(!r.isError, r.text);
  r = await call(guard, "gh_star_repo", { owner: "o", repo: "r" });
  assert.ok(r.isError && /FULL_CONTROL/.test(r.text) && r.calls.length === 0);
  r = await call(guard, "gh_graphql", { query: "mutation { x }" });
  assert.ok(r.isError && /FULL_CONTROL/.test(r.text) && r.calls.length === 0);
  r = await call(guard, "gh_push_files", { owner: "o", repo: "other", message: "m", files: [{ path: "a", content: "b" }] });
  assert.ok(r.isError && /ALLOWED_REPOS/.test(r.text) && r.calls.length === 0);
  routes = { "GET /user": { login: "o" } };
  r = await call(guard, "gh_create_repo", { name: "nope" });
  assert.ok(r.isError && /ALLOWED_REPOS/.test(r.text) && !r.calls.some((c) => c.method === "POST"));
});
