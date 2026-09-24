# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Next.js 16 (App Router, React 19, Tailwind 4) frontend in `client/` and an Express 5 API in `server/` (plain ESM JavaScript, no build step). Users sign in with GitHub OAuth, see every repo they can access, can duplicate a repo (full history) into their own account, and can manage a twinstack-site repo (run its build, content and Claude commands, then commit and open a PR) from the browser. There is no database: all session state lives in an encrypted cookie.

**Before writing any code in `client/`, read `client/AGENTS.md`.** This Next.js version has breaking changes from what you may know; consult `client/node_modules/next/dist/docs/`. For example, route protection lives in `client/src/proxy.ts` (exporting `proxy`), not `middleware.ts`.

## Commands

Node 20.12+ (both packages use `node --env-file-if-exists`).

```bash
npm install          # root; postinstall also installs client/ and server/
npm run dev          # API on :4000 (node --watch) and web on :3000, via concurrently
npm run build        # builds client only (server needs no build)
npm run start        # production start of both

npm --prefix client run lint   # ESLint (eslint-config-next); the only lint in the repo
```

There are no tests. Env setup: copy `server/.env.example` → `server/.env` (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `JWT_SECRET` are required; the server throws at startup without them) and `client/.env.example` → `client/.env.local` (`API_URL`). Optional server vars: `ALLOWED_GITHUB_LOGINS`, `WORKSPACES_DIR` (see the site manager section below).

## Architecture

**Single origin via rewrites.** The browser only ever talks to Next.js on :3000. `client/next.config.ts` rewrites `/auth/*` and `/api/*` to Express, so the httpOnly `session` cookie is first-party. The GitHub OAuth callback URL therefore points at the *client* (`http://localhost:3000/auth/github/callback`), not the API. `API_URL` is read at build time. `experimental.proxyTimeout` is raised to 10 minutes because duplication can take a long time.

**Session = encrypted JWT (JWE, `dir` + A256GCM).** `server/src/session.js` encrypts `{ user, github: { accessToken, refreshToken, expiresAt, scopes } }` with a key derived from `JWT_SECRET` (SHA-256). It is encrypted, not just signed, because it carries the GitHub token. `requireAuth` decrypts it onto `req.session` / `req.user`.

**Who verifies the session.** Only Express can decrypt the cookie. `client/src/proxy.ts` only checks that the cookie *exists* on `/dashboard/*` and `/sites/*`. Server components call `getUser()` in `client/src/lib/session.ts` (`server-only`), which forwards the cookie to `GET /api/me`. Client components (`RepoList`, `DuplicateRepo`) call `/api/*` directly from the browser through the rewrite.

**Token refresh.** `getAccessToken(req, res)` in `server/src/github.js` refreshes the GitHub token when it is within 60s of expiry (only when the OAuth App issues expiring tokens) and re-issues the cookie. Any route that calls GitHub should get its token through this function. Any GitHub 401 or refresh failure throws `ReauthRequiredError`, which routes map to `401 { error: "reauth_required" }`. The client treats that code as "sign in again".

**Scopes.** `read:user user:email repo workflow`, requested in `server/src/routes/auth.js`. `workflow` is needed to push repos that contain `.github/workflows/*`. The duplicate route rejects older sessions that lack it with a `reauth_required` response.

**Duplication** (`server/src/duplicate.js`). It validates owner and name, then `POST /user/repos`. Next it runs `git clone --bare` of the source into a temp dir and pushes `refs/heads/*` and `refs/tags/*` to the new repo. After that it PATCHes the default branch to match the source, and finally removes the temp dir. If the name already exists and that repo is empty and admin-owned, it is reused, which lets a failed copy be retried. A non-empty repo is never overwritten. The token reaches git only through `GIT_CONFIG_*` env vars (an `http.extraheader`), never through argv or a remote URL; keep it that way. The server host needs `git` installed. Error classes: `DuplicateError` has a user-safe message and HTTP status. `MissingScopeError` maps to reauth. Anything else becomes a 502, with `err.partialRepo` noted if an empty repo was left behind.

**Site manager** (`/sites/[owner]/[repo]`, the README has the user-facing summary). It drives a twinstack-site repo's scripts from the browser:
- `server/src/workspace.js` keeps a persistent clone per user and repo at `WORKSPACES_DIR/<userId>/<owner>/<repo>`. Repo metadata and the `npm ci` lockfile stamp live inside `.git/` so they never appear as changes. It also handles status, diff, discard, commit/push/PR and reset. A per-workspace lock (`acquire`) makes sure only one command or git operation touches a clone at a time.
- `server/src/commands.js` is the only list of runnable commands. Each builds a fixed `node scripts/<x>.js` argv from validated input. There is no shell, and values that start with `-` are rejected. New site commands go here. Scripts get the `jobEnv()` allowlist, never `process.env`, so the GitHub token and server secrets can't reach repo code.
- `server/src/jobs.js` runs commands in memory. The client polls `GET /api/jobs/:id?since=<offset>` (not SSE, so it works through the Next rewrite proxy). Jobs are lost on restart.
- `server/src/site-files.js` reads site data (collections, pages, nav) by parsing files. **Never import repo code into the server process.**
- `server/src/routes/preview.js` serves `dist/` under a signed URL with a CSP sandbox header, and rewrites root-relative `href`/`src`/`url()` into the preview prefix. The client iframe is sandboxed without `allow-same-origin`, so keep both.
- The user's Anthropic key lives only in the session cookie as `anthropicKey`, managed by `routes/settings.js`. Re-login carries it over in `routes/auth.js`, and any code that rewrites the session must spread `req.session` to keep it.
- Client: `components/site/SiteManager.tsx` owns status, the job and polling, and exposes them via `useSite()` (`site-context.tsx`). Each tab is a `*Panel.tsx`. Panels reload their data whenever `version` bumps, which happens after every command and git operation.

**Mutating routes require `Content-Type: application/json`** (415 otherwise). This is the CSRF defence together with the `SameSite=Lax` cookie, so keep it on new POST routes.
