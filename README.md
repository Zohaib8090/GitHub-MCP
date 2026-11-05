# GitHub-MCP

A self-hosted GitHub connector for Claude (any MCP client) with **real OAuth sign-in** and optional full control
over your GitHub account: repos, Actions runs and logs, releases and assets, branch protection, webhooks, Pages,
Actions secrets, and a generic REST escape hatch (`gh_api`) that can call any endpoint.

- **No personal access token to leak.** You sign in with GitHub (OAuth App). Your GitHub token is never stored:
  it only exists inside AES-256-GCM encrypted access/refresh tokens that Claude holds.
- **No database.** Tokens, auth codes and client ids are sealed, stateless blobs. Runs fine on Render's free tier.
- **Locked to you.** Only GitHub logins in `ALLOWED_GITHUB_USERS` can finish a login.
- **Hardened OAuth 2.1:** PKCE (S256) required, consent page, cookie-bound state, single-use codes, refresh token
  rotation with reuse detection, `/revoke`, rate limiting, redirect URIs limited to `claude.ai` / `claude.com`.

> **Full control is the default** (`FULL_CONTROL=true`): every repo your token can reach, writes and deletes with
> no confirmation. Anyone who can sign in as an allowed user, or hold a valid token, has that power.
> Set `FULL_CONTROL=false` to turn on `ALLOWED_REPOS`, `READ_ONLY` and confirmation-gated destructive actions.

## Setup (about 10 minutes)

1. **Fork or clone** this repo and deploy it as a Node web service (a `render.yaml` blueprint is included).
2. **Create a GitHub OAuth App**: GitHub -> Settings -> Developer settings -> OAuth Apps -> New.
   - Homepage URL: `https://YOUR-SERVICE.onrender.com`
   - Authorization callback URL: `https://YOUR-SERVICE.onrender.com/github/callback`
   - Generate a client secret.
3. **Set environment variables** on the service (see [`.env.example`](.env.example)):
   `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ALLOWED_GITHUB_USERS`.
   With the included `render.yaml` blueprint, Render also generates `ENCRYPTION_KEY` for you and the server
   reads its own URL from `RENDER_EXTERNAL_URL`, so you do not set `PUBLIC_URL`. On other hosts set `PUBLIC_URL`
   and `ENCRYPTION_KEY` (`openssl rand -base64 32`) yourself.
   The default Render URL is `https://github-mcp.onrender.com`. If Render gives you a different URL, update the
   OAuth App's callback URL to match.
4. **Add the connector in Claude**: Settings -> Connectors -> Add custom connector ->
   `https://YOUR-SERVICE.onrender.com/mcp`. Claude registers itself, shows a consent page, sends you through the
   GitHub login, and you are connected. Works on web, desktop and mobile.

Organization repos: an OAuth App needs the organization's approval (GitHub -> your org -> Settings -> Third-party
access). Without it the org's private repos stay invisible.

## How the login works

```
Claude --register--> /register          (stateless client id, redirect host must be claude.ai/claude.com)
Claude --browser---> /authorize         (consent page, PKCE S256 required, cookie nonce)
                     /authorize/approve --> github.com/login/oauth/authorize
GitHub --browser---> /github/callback   (checks the login against ALLOWED_GITHUB_USERS)
Claude --code------> /token             (verifies PKCE, returns sealed access + refresh tokens)
Claude --Bearer----> /mcp               (token unsealed per request, your GitHub token used for that call)
```

Access tokens last 1 hour, refresh tokens 30 days and rotate on every use. Revoke a token with `POST /revoke`.
To log everyone out at once, change `ENCRYPTION_KEY` or revoke the app at
GitHub -> Settings -> Applications.

## Tools

**390+ tools** covering the GitHub API. The full list is in [TOOLS.md](TOOLS.md).

| Toolset | What it covers |
| --- | --- |
| core (always on) | whoami, repos, Actions runs/logs/secrets, releases, branch protection, webhooks, Pages, `gh_api` (any REST endpoint) |
| `repos` | create/fork/transfer/delete repos, branches, tags, commits, compare, collaborators, traffic, stars, topics, deploy keys, security toggles |
| `git` | read/write files, **multi-file commits** (`gh_push_files`), trees, blobs, refs |
| `issues` | issues, comments, labels, milestones, assignees, sub-issues, reactions, timeline |
| `pulls` | PRs, diffs, reviews, inline comments, review threads, reviewers, Copilot review, merge |
| `actions`, `environments` | runs, jobs, artifacts, caches, variables, secrets, runners, permissions, environments |
| `checks`, `deployments` | check runs/suites, commit statuses, deployments |
| `security`, `rulesets` | Dependabot, code scanning, secret scanning, advisories, SBOM, rulesets |
| `releases`, `webhooks`, `pages` | release/asset management, webhook deliveries, Pages builds |
| `search` | repos, code, commits, issues, PRs, users, topics |
| `gists`, `users`, `orgs`, `notifications` | gists, profile/keys/follows, orgs/teams/members, notifications inbox |
| `projects`, `discussions`, `graphql` | Projects (v2), Discussions, raw GraphQL |
| `codespaces`, `packages`, `meta` | codespaces, packages, rate limit, licenses, markdown rendering |

### Keep the tool list lean

Every tool costs a little context in each chat. Pick what you need with `GITHUB_TOOLSETS`:

```
GITHUB_TOOLSETS=all                          # default
GITHUB_TOOLSETS=repos,git,issues,pulls       # just the day-to-day set
GITHUB_TOOLSETS=all,-codespaces,-packages    # everything except these
```

List responses are slimmed to the useful fields; pass `full: true` to any tool that has it to get the raw GitHub JSON.
After changing the tool list, reconnect the connector (or start a new chat) so Claude refreshes it.

Destructive tools (deletes, force pushes, transfers) need no confirmation under `FULL_CONTROL=true`. With
`FULL_CONTROL=false` they need `ENABLE_DESTRUCTIVE=true` and `confirm` set to the exact request path.
Writes are logged to stdout. Tokens are never logged.

### Adding a tool

Most tools are one line of data in `src/tools/specs/*.js`:

```js
["gh_lock_issue", "PUT /repos/{owner}/{repo}/issues/{issue_number:n}/lock", "Lock an issue.", "b.lock_reason?:s"]
```

`npm test` calls every spec against a mock GitHub and checks method, path, query and body.
Tools that need several API calls live in `src/tools/custom.js`.

The default OAuth scopes are broad (`repo workflow delete_repo admin:repo_hook admin:org gist notifications user project codespace ...`).
Narrow them with `GITHUB_SCOPES` if you do not need everything.

## Run locally

```bash
npm install
cp .env.example .env      # fill it in; use http://localhost:3000 as PUBLIC_URL and the callback URL
export $(grep -v '^#' .env | grep . | xargs) && ALLOW_LOCALHOST_REDIRECTS=true npm start
npm test                  # end-to-end OAuth tests against a mock GitHub
```

For quick local hacking without OAuth, `AUTH_MODE=static` uses one `GITHUB_TOKEN` and a secret URL
`/mcp/<MCP_SECRET>`. Do not use static mode for a public deployment.

## Security

See [SECURITY.md](SECURITY.md) for the threat model and how to report a problem.

## License

MIT
