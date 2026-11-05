import crypto from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";

/**
 * OAuth 2.1 authorization server for MCP clients (Claude), with GitHub as the identity provider.
 *
 *  Claude --(DCR, PKCE)--> this server --(GitHub OAuth App login)--> GitHub
 *
 * - Dynamic client registration is restricted to allowed redirect hosts (claude.ai / claude.com).
 * - PKCE (S256) is mandatory. A consent page + cookie nonce stops drive-by authorization.
 * - Only GitHub logins listed in ALLOWED_GITHUB_USERS can finish a login.
 * - The user's GitHub token is never stored: it lives only inside AES-GCM sealed access/refresh tokens.
 * - Auth codes are single use, refresh tokens rotate with reuse detection, /revoke is supported.
 */

const COOKIE = "mcp_oauth_nonce";
const UA = "github-mcp";
const s = (v) => (typeof v === "string" ? v : "");
const rid = () => crypto.randomBytes(16).toString("base64url");
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createOAuth(cfg, sealer, log = () => {}) {
  const {
    baseUrl, githubClientId, githubClientSecret, githubWeb, githubApi, scopes,
    allowedUsers, allowedRedirectHosts, allowLocalhost, accessTtl, refreshTtl,
  } = cfg;
  const secure = baseUrl.startsWith("https://");

  // jti -> exp. Holds spent auth codes, rotated refresh tokens and revoked tokens (in memory only).
  const spent = new Map();
  setInterval(() => {
    const now = Date.now() / 1000;
    for (const [k, v] of spent) if (v < now) spent.delete(k);
  }, 60_000).unref();

  const validRedirect = (uri) => {
    try {
      const u = new URL(uri);
      if (u.hash) return false;
      if (u.protocol === "https:") return allowedRedirectHosts.includes(u.hostname);
      if (u.protocol === "http:" && allowLocalhost) return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
      return false;
    } catch { return false; }
  };

  const setNonce = (res, nonce) =>
    res.append("Set-Cookie", `${COOKIE}=${nonce}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure ? "; Secure" : ""}`);
  const clearNonce = (res) =>
    res.append("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`);

  const issue = (gh, sub, cid) => ({
    access_token: sealer.seal("access", { gh, sub, cid, jti: rid() }, accessTtl),
    token_type: "Bearer",
    expires_in: accessTtl,
    refresh_token: sealer.seal("refresh", { gh, sub, cid, jti: rid() }, refreshTtl),
    scope: "github",
  });

  const r = express.Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const form = express.urlencoded({ extended: false, limit: "20kb" });
  const json = express.json({ limit: "20kb" });
  const noStore = (res) => { res.set("Cache-Control", "no-store"); res.set("Pragma", "no-cache"); };

  // ------------------------------------------------------------ discovery
  const resourceMeta = (_req, res) => res.json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: ["github"],
  });
  r.get("/.well-known/oauth-protected-resource", resourceMeta);
  r.get("/.well-known/oauth-protected-resource/mcp", resourceMeta);
  const asMeta = (_req, res) => res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    revocation_endpoint: `${baseUrl}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["github"],
  });
  r.get("/.well-known/oauth-authorization-server", asMeta);
  r.get("/.well-known/oauth-authorization-server/mcp", asMeta);

  // ------------------------------------------------------------ dynamic client registration (stateless)
  r.post("/register", limiter, json, (req, res) => {
    noStore(res);
    const b = req.body || {};
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(s) : [];
    if (!uris.length || uris.length > 5 || !uris.every(validRedirect)) {
      return res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uri host is not allowed" });
    }
    const client_name = (s(b.client_name) || "MCP client").slice(0, 80);
    const client_id = sealer.seal("client", { redirect_uris: uris, client_name }, 365 * 24 * 3600);
    res.status(201).json({
      client_id, client_name, redirect_uris: uris,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // ------------------------------------------------------------ authorize: consent page
  r.get("/authorize", limiter, (req, res) => {
    const q = req.query;
    const client = sealer.unseal("client", s(q.client_id));
    if (!client) return res.status(400).type("text").send("Unknown client. Remove and re-add the connector in Claude.");
    const ru = s(q.redirect_uri);
    if (!client.redirect_uris.includes(ru)) return res.status(400).type("text").send("redirect_uri is not registered for this client.");
    const back = (error, desc) => {
      const u = new URL(ru);
      u.searchParams.set("error", error);
      if (desc) u.searchParams.set("error_description", desc);
      if (s(q.state)) u.searchParams.set("state", s(q.state));
      return res.redirect(302, u.toString());
    };
    if (s(q.response_type) !== "code") return back("unsupported_response_type");
    if (!s(q.code_challenge) || s(q.code_challenge_method) !== "S256") return back("invalid_request", "PKCE with S256 is required");

    const nonce = rid();
    const reqToken = sealer.seal("authreq", { cid: s(q.client_id), ru, cc: s(q.code_challenge), st: s(q.state), nonce }, 600);
    setNonce(res, nonce);
    const deny = new URL(ru);
    deny.searchParams.set("error", "access_denied");
    if (s(q.state)) deny.searchParams.set("state", s(q.state));
    res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    res.set("X-Frame-Options", "DENY");
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize GitHub MCP</title>
<style>body{font:16px system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:440px;padding:28px;background:#161b22;border:1px solid #30363d;border-radius:12px}
h1{font-size:20px;margin:0 0 12px}p{color:#9da7b3;line-height:1.5}code{color:#e6edf3}
.row{display:flex;gap:10px;margin-top:20px}button,a.btn{flex:1;text-align:center;padding:10px 14px;border-radius:8px;border:1px solid #30363d;font:inherit;cursor:pointer;text-decoration:none;color:#e6edf3;background:#21262d}
button.ok{background:#238636;border-color:#2ea043}</style></head><body><main>
<h1>Authorize ${esc(client.client_name)}</h1>
<p><b>${esc(client.client_name)}</b> (returns to <code>${esc(new URL(ru).host)}</code>) wants to control your GitHub account through this server. You will sign in with GitHub next.</p>
<p>Scopes requested: <code>${esc(scopes)}</code></p>
<form method="post" action="/authorize/approve"><input type="hidden" name="req" value="${esc(reqToken)}">
<div class="row"><a class="btn" href="${esc(deny.toString())}">Cancel</a><button class="ok" type="submit">Continue</button></div></form>
</main></body></html>`);
  });

  // ------------------------------------------------------------ authorize: approve -> GitHub login
  r.post("/authorize/approve", limiter, form, (req, res) => {
    const a = sealer.unseal("authreq", s(req.body?.req));
    const nonce = parseCookies(req)[COOKIE];
    if (!a || !nonce || !safeEq(nonce, a.nonce)) {
      return res.status(400).type("text").send("Session expired or invalid. Start again from Claude.");
    }
    const u = new URL(`${githubWeb}/login/oauth/authorize`);
    u.searchParams.set("client_id", githubClientId);
    u.searchParams.set("redirect_uri", `${baseUrl}/github/callback`);
    u.searchParams.set("scope", scopes);
    u.searchParams.set("state", sealer.seal("ghstate", a, 600));
    u.searchParams.set("allow_signup", "false");
    res.redirect(302, u.toString());
  });

  // ------------------------------------------------------------ GitHub callback
  r.get("/github/callback", limiter, async (req, res) => {
    const a = sealer.unseal("ghstate", s(req.query.state));
    const nonce = parseCookies(req)[COOKIE];
    if (!a || !nonce || !safeEq(nonce, a.nonce)) {
      return res.status(400).type("text").send("Session expired or invalid. Start again from Claude.");
    }
    clearNonce(res);
    const back = new URL(a.ru);
    if (a.st) back.searchParams.set("state", a.st);
    if (req.query.error || !s(req.query.code)) {
      back.searchParams.set("error", "access_denied");
      return res.redirect(302, back.toString());
    }
    try {
      const tr = await fetch(`${githubWeb}/login/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
        body: JSON.stringify({
          client_id: githubClientId, client_secret: githubClientSecret,
          code: s(req.query.code), redirect_uri: `${baseUrl}/github/callback`,
        }),
      });
      const t = await tr.json();
      if (!t.access_token) throw new Error(t.error_description || t.error || "token exchange failed");
      const ur = await fetch(`${githubApi}/user`, {
        headers: { Authorization: `Bearer ${t.access_token}`, Accept: "application/vnd.github+json", "User-Agent": UA },
      });
      if (!ur.ok) throw new Error(`GitHub /user returned ${ur.status}`);
      const user = await ur.json();
      if (!allowedUsers.includes(String(user.login).toLowerCase())) {
        log({ event: "login_denied", user: user.login });
        return res.status(403).type("text").send("This GitHub account is not allowed to use this server.");
      }
      const code = sealer.seal("code", {
        cid: a.cid, ru: a.ru, cc: a.cc, gh: t.access_token, sub: user.login, jti: rid(),
      }, 300);
      log({ event: "login_ok", user: user.login, scopes: t.scope });
      back.searchParams.set("code", code);
      res.redirect(302, back.toString());
    } catch (e) {
      log({ event: "login_error", error: String(e.message || e) });
      res.status(502).type("text").send("GitHub sign-in failed.");
    }
  });

  // ------------------------------------------------------------ token endpoint
  r.post("/token", limiter, form, json, async (req, res) => {
    noStore(res);
    const b = req.body || {};
    const fail = (error, error_description) => res.status(400).json({ error, error_description });

    if (s(b.grant_type) === "authorization_code") {
      const c = sealer.unseal("code", s(b.code));
      if (!c) return fail("invalid_grant", "code is invalid or expired");
      if (spent.has(c.jti)) { log({ event: "code_reuse", user: c.sub }); return fail("invalid_grant", "code already used"); }
      spent.set(c.jti, c.exp); // single use, burned even if the checks below fail
      if (s(b.client_id) !== c.cid) return fail("invalid_grant", "client mismatch");
      if (s(b.redirect_uri) !== c.ru) return fail("invalid_grant", "redirect_uri mismatch");
      const verifier = s(b.code_verifier);
      const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
      if (!verifier || !safeEq(challenge, c.cc)) return fail("invalid_grant", "PKCE verification failed");
      log({ event: "token_issued", user: c.sub });
      return res.json(issue(c.gh, c.sub, c.cid));
    }

    if (s(b.grant_type) === "refresh_token") {
      const t = sealer.unseal("refresh", s(b.refresh_token));
      if (!t) return fail("invalid_grant", "refresh token is invalid or expired");
      if (spent.has(t.jti)) { log({ event: "refresh_reuse", user: t.sub }); return fail("invalid_grant", "refresh token already used or revoked"); }
      if (s(b.client_id) && s(b.client_id) !== t.cid) return fail("invalid_grant", "client mismatch");
      // If the grant was revoked on GitHub, stop here.
      try {
        const ur = await fetch(`${githubApi}/user`, {
          headers: { Authorization: `Bearer ${t.gh}`, Accept: "application/vnd.github+json", "User-Agent": UA },
        });
        if (ur.status === 401) return fail("invalid_grant", "GitHub authorization was revoked");
      } catch { /* GitHub unreachable: do not lock the user out */ }
      spent.set(t.jti, t.exp); // rotation: the old refresh token stops working
      log({ event: "token_refreshed", user: t.sub });
      return res.json(issue(t.gh, t.sub, t.cid));
    }

    return fail("unsupported_grant_type");
  });

  // ------------------------------------------------------------ revocation (RFC 7009)
  r.post("/revoke", limiter, form, json, (req, res) => {
    noStore(res);
    const tok = s(req.body?.token);
    const p = sealer.unseal("access", tok) || sealer.unseal("refresh", tok);
    if (p) { spent.set(p.jti, p.exp); log({ event: "revoked", user: p.sub }); }
    res.status(200).json({});
  });

  // ------------------------------------------------------------ used by the MCP endpoint
  function authenticate(req) {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
    if (!m) return null;
    const p = sealer.unseal("access", m[1]);
    if (!p || spent.has(p.jti)) return null;
    return { token: p.gh, sub: p.sub };
  }

  return { router: r, authenticate, baseUrl };
}
