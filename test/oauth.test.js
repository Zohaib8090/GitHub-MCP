import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

// End-to-end OAuth test: the real server talks to a mock GitHub (token exchange + /user).

const REDIRECT = "http://127.0.0.1:9/cb";
const b64u = (b) => Buffer.from(b).toString("base64url");
let mock, server, base, mockLogin = "zohaib8090";
const githubTokensSeen = [];

const freePort = () => new Promise((res) => {
  const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
});

before(async () => {
  mock = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/login/oauth/access_token") {
      req.resume();
      return req.on("end", () => res.end(JSON.stringify({ access_token: `gho_mock_${mockLogin}`, scope: "repo", token_type: "bearer" })));
    }
    if (req.url === "/user") {
      githubTokensSeen.push(req.headers.authorization);
      const m = /gho_mock_(.+)$/.exec(req.headers.authorization || "");
      if (!m) { res.statusCode = 401; return res.end("{}"); }
      return res.end(JSON.stringify({ login: m[1], id: 1 }));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.js"], {
    env: {
      PATH: process.env.PATH, PORT: String(port), PUBLIC_URL: base, AUTH_MODE: "oauth",
      GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret",
      GITHUB_WEB_URL: mockUrl, GITHUB_API_URL: mockUrl,
      ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
      ALLOWED_GITHUB_USERS: "Zohaib8090", ALLOW_LOCALHOST_REDIRECTS: "true",
    },
  });
  await new Promise((res, rej) => {
    server.stdout.on("data", (d) => { if (String(d).includes("listening")) res(); });
    server.stderr.on("data", (d) => console.error(String(d)));
    server.on("exit", (c) => rej(new Error(`server exited early (${c})`)));
    setTimeout(() => rej(new Error("server start timeout")), 8000).unref();
  });
});

after(() => { server?.kill(); mock?.close(); });

// ---------------------------------------------------------------- helpers
const register = (uris = [REDIRECT]) => fetch(`${base}/register`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ redirect_uris: uris, client_name: "Test client" }),
});

async function startAuthorize() {
  const reg = await (await register()).json();
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({
    response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256", state: "xyz",
  });
  const r = await fetch(`${base}/authorize?${q}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  return {
    clientId: reg.client_id, verifier,
    req: /name="req" value="([^"]+)"/.exec(html)[1],
    cookie: r.headers.get("set-cookie").split(";")[0],
  };
}

const approve = (req, cookie) => fetch(`${base}/authorize/approve`, {
  method: "POST", redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
  body: new URLSearchParams({ req }),
});

const githubCallback = (location, cookie) => {
  const state = new URL(location).searchParams.get("state");
  return fetch(`${base}/github/callback?code=abc&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { Cookie: cookie } });
};

const tokenReq = (params) => fetch(`${base}/token`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params),
});

async function loginUntilCode() {
  const a = await startAuthorize();
  const ap = await approve(a.req, a.cookie);
  assert.equal(ap.status, 302);
  const cb = await githubCallback(ap.headers.get("location"), a.cookie);
  return { a, cb };
}

const mcpCall = (accessToken, body) => fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------- tests
test("unauthenticated /mcp returns 401 with resource metadata pointer", async () => {
  const r = await mcpCall(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /resource_metadata=".*oauth-protected-resource"/);
});

test("discovery documents advertise S256 PKCE and registration", async () => {
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.registration_endpoint, `${base}/register`);
  const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(pr.resource, `${base}/mcp`);
});

test("registration rejects redirect URIs on unknown hosts", async () => {
  assert.equal((await register(["https://evil.example/cb"])).status, 400);
  assert.equal((await register(["https://claude.ai/api/mcp/auth_callback"])).status, 201);
});

test("approve without the cookie nonce is rejected", async () => {
  const a = await startAuthorize();
  assert.equal((await approve(a.req, null)).status, 400);
});

test("full flow: login, tokens, MCP call uses the user's GitHub token, refresh rotation, revoke", async () => {
  const { a, cb } = await loginUntilCode();
  assert.equal(cb.status, 302);
  const back = new URL(cb.headers.get("location"));
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get("state"), "xyz");
  const code = back.searchParams.get("code");

  // wrong PKCE verifier fails and burns the code
  const bad = await tokenReq({ grant_type: "authorization_code", code, client_id: a.clientId, redirect_uri: REDIRECT, code_verifier: "wrong" });
  assert.equal(bad.status, 400);
  const replay = await tokenReq({ grant_type: "authorization_code", code, client_id: a.clientId, redirect_uri: REDIRECT, code_verifier: a.verifier });
  assert.equal(replay.status, 400);

  // fresh login for the happy path
  const second = await loginUntilCode();
  const code2 = new URL(second.cb.headers.get("location")).searchParams.get("code");
  const tr = await tokenReq({ grant_type: "authorization_code", code: code2, client_id: second.a.clientId, redirect_uri: REDIRECT, code_verifier: second.a.verifier });
  assert.equal(tr.status, 200);
  const t = await tr.json();
  assert.equal(t.token_type, "Bearer");
  assert.ok(!t.access_token.includes("gho_"), "GitHub token must not be readable inside the access token");

  // code reuse after success
  const again = await tokenReq({ grant_type: "authorization_code", code: code2, client_id: second.a.clientId, redirect_uri: REDIRECT, code_verifier: second.a.verifier });
  assert.equal(again.status, 400);

  // MCP call goes through with the logged-in user's GitHub token
  const out = await (await mcpCall(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gh_whoami", arguments: {} } })).text();
  assert.match(out, /zohaib8090/);
  assert.ok(githubTokensSeen.includes("Bearer gho_mock_zohaib8090"));

  // tampered token
  const flipped = t.access_token.slice(0, -2) + (t.access_token.endsWith("AA") ? "BB" : "AA");
  assert.equal((await mcpCall(flipped, { jsonrpc: "2.0", id: 3, method: "tools/list" })).status, 401);

  // refresh rotates; the old refresh token is dead
  const rf = await tokenReq({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: second.a.clientId });
  assert.equal(rf.status, 200);
  const t2 = await rf.json();
  assert.equal((await tokenReq({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: second.a.clientId })).status, 400);

  // revoke kills the access token
  assert.equal((await mcpCall(t2.access_token, { jsonrpc: "2.0", id: 4, method: "tools/list" })).status, 200);
  await fetch(`${base}/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t2.access_token }) });
  assert.equal((await mcpCall(t2.access_token, { jsonrpc: "2.0", id: 5, method: "tools/list" })).status, 401);
});

test("a GitHub account that is not on the allowlist is refused", async () => {
  mockLogin = "mallory";
  try {
    const { cb } = await loginUntilCode();
    assert.equal(cb.status, 403);
  } finally {
    mockLogin = "zohaib8090";
  }
});
