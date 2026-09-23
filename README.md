# Twinstack Web

Next.js 16 (App Router) frontend + Express 5 API, with GitHub OAuth sign-in.

```
client/   Next.js app (port 3000)
server/   Express API (port 4000) — owns the OAuth flow and sessions
```

## How auth works

1. "Sign in with GitHub" → `/auth/github` (proxied by Next.js rewrites to Express), which sets a
   short-lived `oauth_state` cookie and redirects to GitHub.
2. GitHub redirects to `/auth/github/callback`. Express checks the state, exchanges the code for an
   access token, fetches the profile, and stores `{ user, githubToken }` in an **encrypted** JWT
   (JWE, A256GCM) in an httpOnly `session` cookie (7 days).
3. Next.js server components call `GET /api/me` on Express with that cookie to get the user.
   `src/proxy.ts` redirects guests away from `/dashboard`.
4. The dashboard fetches `GET /api/repos` from the browser. Express lists every repo the user can
   access (owned, collaborator, org member — including private ones). If the GitHub token has
   expired (OAuth Apps with "Expire user access tokens" enabled issue 8-hour tokens), Express
   refreshes it and re-issues the cookie.
5. "Sign out" posts to `/auth/logout`, which clears the cookie.

Everything lives in the encrypted cookie, so **no database is needed**. Add MongoDB when you need to
persist app data or share state across devices.

### Scopes

The app requests `read:user user:email repo workflow`. `repo` is the only OAuth App scope that exposes
private repositories, and it also grants write access. `workflow` is needed to push repos that contain
`.github/workflows/*` files (GitHub rejects those pushes otherwise). For read-only access, switch to a GitHub App with
"Contents: read" and "Metadata: read" permissions.

Private repos in organizations only appear if the org allows the OAuth App (Org settings → Third-party
access). Users can request access from <https://github.com/settings/connections/applications>.

### Duplicating a repository

Each repo on the dashboard has a **Duplicate** button. It calls
`POST /api/repos/:owner/:repo/duplicate` with `{ name, private }`, and Express:

1. creates the new repo in the user's account (`POST /user/repos`),
2. `git clone --bare`s the source into a temp dir and pushes every branch and tag (full history),
3. sets the new repo's default branch to match the source, then deletes the temp dir.

If a push fails after the repo was created, retrying with the same name reuses that repo as long as it
is still empty. A non-empty repo is never overwritten.

The GitHub token is handed to git via `GIT_CONFIG_*` env vars, never argv or a remote URL. The server
host needs `git` installed. Git LFS objects, issues, PRs, wikis and settings are not copied.

## Setup

1. Create a GitHub OAuth App at <https://github.com/settings/developers>:
   - Homepage URL: `http://localhost:3000`
   - Authorization callback URL: `http://localhost:3000/auth/github/callback`
2. Configure env files:
   ```sh
   cp server/.env.example server/.env        # fill in GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, JWT_SECRET
   cp client/.env.example client/.env.local
   ```
3. Install and run (requires Node 20.12+):
   ```sh
   npm install      # also installs client/ and server/
   npm run dev      # API on :4000, web on :3000
   ```

Open <http://localhost:3000>.

## Production notes

- Set `NODE_ENV=production` on the server so cookies get the `Secure` flag (requires HTTPS).
- Set `CLIENT_URL` (server) to the public site URL, and `API_URL` (client) to where Express is
  reachable from the Next.js server. Update the GitHub OAuth App callback URL to match.
- `API_URL` is read in `next.config.ts` at build time, so set it before `npm run build`.
