# Updating the live site

How to get a code change from your computer onto the droplet, so that `https://builder.mydomain.com` and
`https://api.mydomain.com` run the new version. This assumes the first-time setup in [DEPLOY.md](DEPLOY.md) is done.

The flow is always the same:

```
your computer:   edit → test → commit → git push
GitHub Actions:  lint + build → SSH into the droplet → bash deploy.sh      (automatic)
```

GitHub sits in the middle. The droplet only deploys what's on GitHub, so never edit code directly on the server.

Automatic deploys need a one-time setup (section 0). Until it's done, a push only updates GitHub and you have to run
`deploy.sh` on the droplet yourself (section 4).

---

## 0. One-time setup: deploy automatically on every push

The workflow in `.github/workflows/deploy.yml` runs on every push to `master`. It lints and builds the web app on
GitHub first, so broken code stops there. Then it logs in to the droplet over SSH and runs `deploy.sh`. It needs an
SSH key that GitHub can use.

### 0.1 Create a key just for GitHub Actions

On the droplet, as the `twinstack` user:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github_actions -N ""
```

Allow it to log in, but **only to run the deploy**. It can't open a shell or do anything else, so a leaked key can
only redeploy what's already on GitHub:

```bash
echo "command=\"bash /opt/twinstack/web/deploy.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat ~/.ssh/github_actions.pub)" >> ~/.ssh/authorized_keys
```

Print the private key for the next step:

```bash
cat ~/.ssh/github_actions
```

### 0.2 Add the secrets to GitHub

First get the droplet's host key, so GitHub can check it's talking to your server. On **your computer**, using the
droplet's **IP address**:

```bash
ssh-keyscan -t ed25519 203.0.113.10
```

On GitHub, open **DemoProjectDjango/twinstack-web → Settings → Secrets and variables → Actions → New repository
secret** and add four secrets:

| Name | Value |
| --- | --- |
| `DEPLOY_HOST` | the droplet's **IP address**, e.g. `203.0.113.10`. Not `builder.mydomain.com`: behind the Cloudflare proxy that name doesn't reach the server over SSH. |
| `DEPLOY_USER` | `twinstack` |
| `DEPLOY_SSH_KEY` | the whole output of `cat ~/.ssh/github_actions`, including the `-----BEGIN` and `-----END` lines |
| `DEPLOY_KNOWN_HOSTS` | the whole line printed by `ssh-keyscan` (starts with the IP, then `ssh-ed25519 AAAA…`) |

Then remove the private key from the droplet; GitHub has it now:

```bash
rm ~/.ssh/github_actions
```

### 0.3 Test it

On GitHub, open the **Actions** tab → **Deploy** → **Run workflow**. Both jobs, `check` and `deploy`, should turn
green, and the `deploy` log ends with `Deployed <commit> …` or `Already up to date`.

From now on, `git push` is all you need. If a deploy fails, GitHub emails you, and the **Actions** tab shows which step
failed and why.

---

## 1. Make and test the change on your computer

```bash
npm run dev                      # API on :4000, web app on :3000; try your change at http://localhost:3000
```

Before you commit, run the same checks the droplet will run:

```bash
npm --prefix client run lint     # ESLint
npm run build                    # builds the web app; type errors fail here, not only on the server
```

If either fails, fix it first. A failing build on the droplet takes the web app down until you fix it or roll back
(section 6).

If you changed dependencies, install them with `npm install <package>` inside `client/` or `server/`, and commit the
updated `package-lock.json`. The droplet installs exactly what the lockfile says.

## 2. Commit and push

```bash
git add -A
git status                       # check that no .env file is listed
git commit -m "feat: what you changed"
git push                         # to master
```

## 3. Check whether the droplet needs anything first

Most changes need nothing extra. Before you deploy, check this list. With automatic deploys, do these **before you
push**, because the push starts the deploy:

| Your change | Do this on the droplet **before** it deploys |
| --- | --- |
| Adds a new **required** variable to `server/src/config.js` | Add it to `/opt/twinstack/web/server/.env`, or the API won't start. Also add it to `server/.env.example`. |
| Adds an optional server variable | Add it to `server/.env` if you want a value other than the default. |
| Changes the upload size limit or a timeout | Update the Nginx files too (section 5). |
| Anything else | Nothing. |

Also consider timing. Restarting the API cancels any site-manager command that's running (a build, a Claude page
edit), because jobs live only in memory. Uncommitted edits in users' site workspaces are kept.

## 4. Deploy

With automatic deploys set up (section 0), the push in step 2 already started the deploy. Follow it in the GitHub
**Actions** tab; the `deploy` job's log shows the same output as running the script by hand. Nothing else to do here.

To deploy by hand (before section 0 is set up, or when GitHub Actions is down), from **your computer**:

```bash
ssh twinstack@203.0.113.10
```

On the droplet:

```bash
cd /opt/twinstack/web
bash deploy.sh
```

The script pulls from GitHub, lists the new commits, and then does only what those commits need:

| Files changed | What the script does |
| --- | --- |
| `server/package.json` or `server/package-lock.json` | `npm ci` in `server/` |
| `client/package.json` or `client/package-lock.json` | `npm ci` in `client/` |
| anything in `server/` | restarts `twinstack-api` |
| anything in `client/` | rebuilds the web app, then restarts `twinstack-web` |
| `ecosystem.config.cjs` | recreates both PM2 apps so the new settings apply |
| only docs or other files | nothing to restart |

It finishes by checking that the API and the web app both answer `{"ok":true}`, then prints:

```
Deployed a1b2c3d feat: what you changed.
To roll back: git reset --hard 9f8e7d6 && bash deploy.sh --no-pull --full
```

**Keep that rollback line** until you've checked the live site.

While the web app is rebuilding (usually one to two minutes), pages may briefly show errors. Restarts themselves take
a few seconds.

Other ways to run it:

```bash
bash deploy.sh --full              # pull, then reinstall, rebuild and restart everything regardless of what changed
bash deploy.sh --no-pull --full    # redo everything for the commit that's already checked out
```

## 5. Check the live site

From **your computer**:

```bash
curl https://builder.mydomain.com/api/health     # {"ok":true}
curl https://api.mydomain.com/api/health         # {"ok":true}
```

Then open `https://builder.mydomain.com`, sign in, and try the thing you changed. If the browser shows the old
version, hard-refresh with Ctrl+Shift+R.

If something is wrong, look at the logs on the droplet:

```bash
pm2 status
pm2 logs twinstack-api --lines 50
pm2 logs twinstack-web --lines 50
```

## 6. Roll back a bad deploy

If the new version is broken and you can't fix it quickly, go back to the previous commit on the droplet. Use the
rollback line `deploy.sh` printed:

```bash
cd /opt/twinstack/web
git reset --hard 9f8e7d6 && bash deploy.sh --no-pull --full
```

The site now runs the old code again. Then, on **your computer**, undo the bad commit on GitHub. Otherwise the next
`bash deploy.sh` brings it straight back:

```bash
git revert <bad-commit>          # makes a new commit that undoes it
git push
```

Once the fix or the revert is on GitHub, deploy normally with `bash deploy.sh`.

If you've lost the rollback line, `git log --oneline -10` on the droplet shows recent commits.

---

## Changes that aren't in git

`deploy.sh` only handles code from GitHub. These are done by hand on the droplet.

### Server settings (`server/.env`)

```bash
nano /opt/twinstack/web/server/.env
pm2 restart twinstack-api
```

Never change `DATA_ENCRYPTION_KEY`. Stored GitHub tokens and Anthropic keys can't be decrypted without the original.
`JWT_SECRET` can be changed, but that signs everyone out.

### Web app settings (`client/.env.local`)

`API_URL` is baked in when the web app is built, so rebuild after changing it:

```bash
nano /opt/twinstack/web/client/.env.local
bash deploy.sh --no-pull --full
```

### Nginx (domains, upload size, timeouts)

```bash
sudo nano /etc/nginx/sites-available/builder     # or .../api
sudo nginx -t && sudo systemctl reload nginx
```

### GitHub OAuth App

If you move the frontend to a different domain, update the OAuth App's Homepage URL and Authorization callback URL
(`https://<new-domain>/auth/github/callback`) on GitHub, set `CLIENT_URL` in `server/.env`, and run
`pm2 restart twinstack-api`.

### Server software

Every month or so, install OS security updates:

```bash
sudo apt update && sudo apt upgrade -y
```

If it says a restart is required, run `sudo reboot`. PM2 brings both apps back by itself (DEPLOY.md step 12).

---

## When deploy.sh stops with an error

| Message | What to do |
| --- | --- |
| `This checkout has local changes` | Someone edited files on the droplet. Make that change on your computer instead, then run `git checkout -- . && bash deploy.sh` on the droplet. |
| `Not possible to fast-forward` | The droplet's history differs from GitHub, usually after a force-push. If GitHub is correct, run `git fetch && git reset --hard origin/master && bash deploy.sh --no-pull --full`. |
| `Permission denied (publickey)` on pull | The droplet's deploy key was removed from the GitHub repo. Add `~/.ssh/id_ed25519.pub` again (DEPLOY.md step 9). |
| `Another deploy is already running` | Wait for it to finish. Only one deploy runs at a time. |
| Actions: `check` job fails | Lint or the build failed on GitHub, and nothing was deployed. Run the same two commands from step 1 on your computer, fix, and push again. |
| Actions: `Permission denied (publickey)` in the `deploy` job | `DEPLOY_SSH_KEY` is incomplete (it needs the BEGIN and END lines), or the `command=…` line is missing from `~/.ssh/authorized_keys` on the droplet (section 0.1). |
| Actions: `Host key verification failed` | `DEPLOY_KNOWN_HOSTS` is missing or wrong, or the droplet was rebuilt. Run `ssh-keyscan` again (section 0.2) and update the secret. |
| Actions: the `deploy` job times out connecting | `DEPLOY_HOST` must be the droplet's IP, not a domain behind Cloudflare. |
| The build fails | The web app is probably down now. Fix the code on your computer and push again, or roll back (section 6). |
| `npm ci` fails with a lockfile error | `package.json` and `package-lock.json` don't match. Run `npm install` in that folder on your computer, commit the lockfile, and push. |
| `API isn't answering` | `pm2 logs twinstack-api --lines 50`. Usually a missing variable in `server/.env` (section 3) or MongoDB being down (`sudo systemctl status mongod`). |
| `Web app isn't answering` | `pm2 logs twinstack-web --lines 50`. If the API is also down, fix the API first, because the web app's health check goes through it. |
