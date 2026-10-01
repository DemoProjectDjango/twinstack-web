# Twinstack Web

Next.js 16 (App Router) frontend + Express 5 API + MongoDB. Users have email and password accounts and
connect GitHub to them.

```
client/   Next.js app (port 3000)
server/   Express API (port 4000) — owns accounts, sessions and the GitHub connection
```

## How auth works

1. **Accounts.** `/register` and `/login` (Next.js pages) post JSON to `/auth/register` and `/auth/login`, which
   the Next.js rewrites proxy to Express. Passwords are hashed with scrypt (`server/src/passwords.js`). A failed
   login returns the same message for an unknown email as for a wrong password, and an email is locked for
   15 minutes after 10 failures. On success Express sets an httpOnly `session` cookie: an **encrypted** JWT
   (JWE, A256GCM, 7 days) that holds only the account id.
2. **Every request** loads the account from MongoDB (`requireAuth` in `server/src/session.js`). Next.js server
   components get it from `GET /api/me`, and `src/proxy.ts` sends guests to `/login`.
3. **Connect GitHub.** From the dashboard, `/auth/github` sets a short-lived `oauth_state` cookie and redirects to
   GitHub (logged-in users only). `/auth/github/callback` checks the state, exchanges the code, fetches the
   profile and links it to the account. The profile and the token are saved in MongoDB, with the token
   encrypted. One GitHub account can be linked to only one account. Disconnecting removes the link.
4. **GitHub features** (`/api/repos`, duplicating, the site manager) require a linked account (`requireGithub`,
   otherwise `401 github_not_connected`). Expired GitHub tokens are refreshed and saved back (OAuth Apps with
   "Expire user access tokens" enabled issue 8-hour tokens).
5. "Sign out" posts to `/auth/logout`, which clears the cookie. The GitHub connection and Anthropic key stay with
   the account.

### MongoDB

The API connects at startup and won't run without it (`server/src/db.js`):

| Collection | `_id` | Holds |
| --- | --- | --- |
| `users` | ObjectId | `email` (unique, lowercase), `name`, `passwordHash`, `createdAt`, `lastLoginAt`, `loginCount`. `github`: the linked profile (unique by GitHub id) plus `token`. `anthropicKey` plus a masked `hint`. `token` and `anthropicKey` are encrypted with AES-256-GCM under `DATA_ENCRYPTION_KEY`, bound to the account id. |
| `siteCopies` | GitHub repo id | Repos duplicated from the site template, so they stay recognised as copies even after a rename. |

### Which repositories users see

Only the site template (`SITE_TEMPLATE_REPO`, default `DemoProjectDjango/twinstack-site`) and copies of it
appear on the dashboard (`server/src/sites.js`). A repo counts as a copy only if it was duplicated through the app,
which records it by repo id (so renaming it is fine). Copies made before that record existed can be recorded with
`npm --prefix server run record-copies -- <owner/repo> …`.

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
| Site info | edits `site.config.json` (name, taglines, contact, social) and `content/data/*.json` (company facts, FAQ, testimonials, homepage sections, redirects) in forms |
| Edit with Claude | **Write & generate**: write a page's `.md` yourself (rough copy, notes, images inserted at the cursor from uploads, `assets/img/` or URLs) and `page:generate` has Claude turn that draft into the finished page, keeping your facts and adding none. **Edit by instruction**: `page:edit` on one `.md` page, with optional images. **Convert HTML**: upload an existing `.html` page and pick the page it becomes. The old site's header, footer, navigation and sidebars are removed, and Claude converts the rest to markdown, keeping its wording and the page's frontmatter. Whichever mode you use, the preview shows the complete proposed file with any problems or warnings, and it can be edited and then applied without calling Claude again. |
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
- Opening a site runs that repo's code on the server. Only copies duplicated through the app can be
  opened, and duplicating needs read access to the template on GitHub. So keep the template private:
  giving someone access to it on GitHub is what lets them build sites here, and a public template
  lets anyone in. Container isolation is not implemented yet.

### Publishing and custom domains

Every copy publishes itself with GitHub Pages: each push to its default branch runs the copy's deploy
workflow, and the site goes live at `https://<owner>.github.io/<repo>/`. The **Live site** bar at the top of
the site manager shows the link and the latest deploy.

To use your own domain, open **Custom domain** in that bar, enter it (`www.example.com` or `example.com`)
and click **Connect domain**. The app saves it in the repo's Pages settings and rebuilds the site for it. Then,
at the domain's DNS provider (the registrar, such as GoDaddy or Namecheap, or a DNS host such as Cloudflare):

1. Delete any existing `A`, `AAAA` or `CNAME` record for that name, such as a parking page. Leave `MX` and
   `TXT` records (email) alone.
2. Add the records the bar shows:
   - A subdomain (`www.example.com`, `shop.example.com`): one `CNAME` record, name `www` (the part before
     the domain), pointing to `<owner>.github.io`.
   - A bare domain (`example.com`): four `A` records at `@` pointing to `185.199.108.153`,
     `185.199.109.153`, `185.199.110.153` and `185.199.111.153` (optionally four `AAAA` records for IPv6:
     `2606:50c0:8000::153` to `2606:50c0:8003::153`), plus a `CNAME` for `www` pointing to
     `<owner>.github.io`.
3. On Cloudflare, set the records to **DNS only** (grey cloud) until GitHub has issued the certificate. If the
   domain has CAA records, allow `letsencrypt.org`.
4. Wait for DNS to update (usually within an hour, up to 48 hours) and use **Check DNS** to see what GitHub
   sees. Once the certificate is ready (minutes to 24 hours), tick **Enforce HTTPS**.

Verifying the domain under your GitHub account's Settings → Pages → Verified domains stops anyone else from
attaching it to their own Pages site. Pages for a private repository, with or without a domain, needs a paid
GitHub plan.

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

For a step-by-step setup on a new Ubuntu VPS with your own subdomain (DNS, MongoDB, PM2, Nginx, HTTPS), see
[DEPLOY.md](DEPLOY.md). To ship code changes to the live server afterwards, see [UPDATING.md](UPDATING.md).

- Set `NODE_ENV=production` on the server so cookies get the `Secure` flag (requires HTTPS).
- Set `CLIENT_URL` (server) to the public site URL, and `API_URL` (client) to where Express is
  reachable from the Next.js server. Update the GitHub OAuth App callback URL to match.
- `API_URL` is read in `next.config.ts` at build time, so set it before `npm run build`.
