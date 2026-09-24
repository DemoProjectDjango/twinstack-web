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

The session (including the GitHub token) lives only in the encrypted cookie.

### MongoDB

The API connects at startup and won't run without it (`server/src/db.js`):

| Collection | `_id` | Holds |
| --- | --- | --- |
| `users` | GitHub user id | Profile (login, name, email, avatar), `createdAt`, `lastLoginAt`, `loginCount`, updated on every sign-in. Also `anthropicKey`: the user's key encrypted with AES-256-GCM under `DATA_ENCRYPTION_KEY`, bound to the user id, plus a masked `hint`. |
| `siteCopies` | GitHub repo id | Repos duplicated from the site template, so they stay recognised as copies even after a rename. |

### Which repositories users see

Only the site template (`SITE_TEMPLATE_REPO`, default `DemoProjectDjango/twinstack-site`) and copies of it
appear on the dashboard (`server/src/sites.js`). A repo counts as a copy if it was duplicated through the app, or
if it's named like the template (`twinstack-site`, `twinstack-site-*`).

- The **template** can only be duplicated. Its **Manage site** button is disabled, and the API refuses to open it.
- **Copies** can only be managed, not duplicated.

### Scopes

The app requests `read:user user:email repo workflow`. `repo` is the only OAuth App scope that exposes
private repositories, and it also grants write access. `workflow` is needed to push repos that contain
`.github/workflows/*` files (GitHub rejects those pushes otherwise). For read-only access, switch to a GitHub App with
"Contents: read" and "Metadata: read" permissions.

Private repos in organizations only appear if the org allows the OAuth App (Org settings → Third-party
access). Users can request access from <https://github.com/settings/connections/applications>.

### Duplicating a repository

The site template has a **Duplicate** button. It calls
`POST /api/repos/:owner/:repo/duplicate` with `{ name, private }`, and Express:

1. creates the new repo in the user's account (`POST /user/repos`),
2. `git clone --bare`s the source into a temp dir and pushes every branch and tag (full history),
3. sets the new repo's default branch to match the source, then deletes the temp dir,
4. records the new repo in `siteCopies`.

If a push fails after the repo was created, retrying with the same name reuses that repo as long as it
is still empty. A non-empty repo is never overwritten.

The GitHub token is handed to git via `GIT_CONFIG_*` env vars, never argv or a remote URL. The server
host needs `git` installed. Git LFS objects, issues, PRs, wikis and settings are not copied.

### Site manager

Copies of the site template have a **Manage site** button (`/sites/:owner/:repo`). For a copy that
has `site.config.json` and `scripts/build.js`, it runs the site's `npm run` commands from a web page:

| Tab | Site command |
| --- | --- |
| Build & preview | `check`, `build --drafts` (shown in an iframe), `npm ci`, `changelog` |
| Pages | `new <type> "Title" [--draft] [--slug=]` |
| Navigation | `nav:add`, `nav:remove` |
| Edit with Claude | `page:edit` (single edit and the `page-commands.json` queue, each with a preview) |
| Site tree | edits `scripts/site-tree.md`, then `scaffold` / `scaffold:preview` / `--force` |
| Schedule | edits the job list in `scripts/scaffold-schedule.md`, then `scaffold:schedule` / preview |
| Changes | diff, discard, commit, push |

How it works:

- Express keeps one clone per user and repo under `WORKSPACES_DIR`. Opening a site clones it the first
  time and fetches after that. Uncommitted work is kept between visits.
- Commands run `node scripts/<x>.js` in that clone (no shell, one at a time per clone). The browser
  polls for output. Only a short list of variables like `PATH` and `HOME` is passed to the scripts.
  The GitHub token and server secrets are never passed. `ANTHROPIC_API_KEY` is passed only to the
  Claude commands.
- Claude commands use **the user's own Anthropic key**. It's entered on the dashboard, checked with
  Anthropic, and stored encrypted in MongoDB. The browser only ever gets the masked hint back.
- By default, publishing creates a branch (`twinstack/<date>-<time>`), pushes it and opens a pull
  request into the default branch. Later commits on that branch update the same PR. Pushing directly
  to the current branch is an option.
- The preview is served from a signed URL (`/api/preview/...`) into an iframe sandboxed to an
  opaque origin, so the site's scripts can't call this app's API as the user.
- Opening a site runs that repo's code on the server. Set `ALLOWED_GITHUB_LOGINS` to decide who may
  use it. When it's empty, everyone can in development and no one can in production. Container
  isolation is not implemented yet.

## Setup

1. Create a GitHub OAuth App at <https://github.com/settings/developers>:
   - Homepage URL: `http://localhost:3000`
   - Authorization callback URL: `http://localhost:3000/auth/github/callback`
2. Configure env files:
   ```sh
   cp server/.env.example server/.env        # fill in GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, JWT_SECRET,
                                             # MONGODB_URI, DATA_ENCRYPTION_KEY (MongoDB must be running)
   cp client/.env.example client/.env.local
   ```
3. Install and run (requires Node 20.12+):
   ```sh
   npm install      # also installs client/ and server/
   npm run dev      # API on :4000, web on :3000
   ```

Open <http://localhost:3000>.

## Production notes

For a step-by-step DigitalOcean droplet setup (MongoDB, PM2, Nginx, HTTPS without a domain), see
[DEPLOY.md](DEPLOY.md).

- Set `NODE_ENV=production` on the server so cookies get the `Secure` flag (requires HTTPS).
- Set `CLIENT_URL` (server) to the public site URL, and `API_URL` (client) to where Express is
  reachable from the Next.js server. Update the GitHub OAuth App callback URL to match.
- `API_URL` is read in `next.config.ts` at build time, so set it before `npm run build`.
