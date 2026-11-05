# Security

## Threat model

This server can hold the power of your GitHub account, so treat it like a credential.

| Risk | Mitigation |
| --- | --- |
| Stranger signs in | `ALLOWED_GITHUB_USERS` allowlist, checked after the GitHub login |
| Attacker registers a malicious OAuth client | Dynamic registration only accepts `claude.ai` / `claude.com` redirect URIs (plus localhost when explicitly enabled) |
| Drive-by or CSRF authorization | Consent page, cookie-bound nonce, sealed `state`, PKCE S256 mandatory |
| Stolen authorization code | 5 minute life, single use, bound to client, redirect URI and PKCE challenge |
| Token theft from storage | Nothing is stored. GitHub tokens exist only inside AES-256-GCM sealed tokens (per-purpose HKDF keys + AAD) |
| Stolen refresh token | Rotation with reuse detection, 30 day life, checked against GitHub on refresh |
| Brute force | Rate limiting on every OAuth endpoint, 128-bit random identifiers, authenticated encryption |
| Token leakage in logs | Tokens are never logged; only events and usernames |

## Known limits

- Revocation lists live in memory. After a restart a revoked, still-unexpired token works again until it expires
  (access tokens: 1 hour). For a hard kill, rotate `ENCRYPTION_KEY` or revoke the OAuth App on GitHub.
- A GitHub OAuth App token does not expire on its own. Anyone who obtains a sealed token **and** `ENCRYPTION_KEY`
  can read it. Keep `ENCRYPTION_KEY` and `GITHUB_CLIENT_SECRET` only in your host's secret store.
- `FULL_CONTROL=true` has no confirmations. Prefer `FULL_CONTROL=false` plus `ALLOWED_REPOS` if you only need part of it.
- Use the narrowest `GITHUB_SCOPES` you need. Drop `delete_repo` if you never want repo deletion possible.

## Reporting

Please open a private security advisory on this repository rather than a public issue.
