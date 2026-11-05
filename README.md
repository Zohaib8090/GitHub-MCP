# github-mcp

Custom GitHub MCP connector for Claude, with guardrails. Fills the gaps of the official connector
(Actions runs/logs, releases with assets, branch protection, webhooks, Pages, repo settings, generic REST call).

## Guardrails
- `ALLOWED_REPOS` allowlist, every repo tool checks it
- `READ_ONLY=true` blocks every write
- Destructive actions (delete repo/webhook, DELETE via `gh_api`, making a repo private/public or archiving) need
  `ENABLE_DESTRUCTIVE=true` **and** an exact `confirm` string
- Endpoint is protected by a secret in the URL (`/mcp/<MCP_SECRET>`) or a Bearer header
- Every write is logged to stdout (visible in Render logs)

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Render -> New -> Web Service (or Blueprint using `render.yaml`).
3. Set env vars: `GITHUB_TOKEN`, `MCP_SECRET`, `ALLOWED_REPOS` (see `.env.example`).
4. In Claude: Settings -> Connectors -> Add custom connector, URL:
   `https://<your-service>.onrender.com/mcp/<MCP_SECRET>`

## Token
Create a fine-grained PAT at GitHub -> Settings -> Developer settings, limited to the repos you need.
Start without Administration write. Add it only if you need repo settings/protection/delete.

## Local run
```
cp .env.example .env   # fill it in
export $(grep -v '^#' .env | xargs) && npm install && npm start
```
