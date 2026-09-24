# Deploying to builder.mydomain.com

This guide takes a **brand-new Ubuntu 24.04 VPS** to a working Twinstack Web at `https://builder.mydomain.com`.
Everything runs on that one server:

```
browser ──HTTPS──> Nginx :443 ──> Next.js 127.0.0.1:3000 ──> Express 127.0.0.1:4000 ──> MongoDB 127.0.0.1:27017
```

Replace these placeholders everywhere below:

| Placeholder | What it is |
| --- | --- |
| `builder.mydomain.com` | your subdomain |
| `203.0.113.10` | your VPS's public IPv4 address (from your provider's control panel) |
| `you@example.com` | your email, for Let's Encrypt certificate expiry notices |
| `your-github-username` | the GitHub account you'll connect after logging in |

Commands run on **your computer** are marked as such. Everything else runs on the VPS.

How users get in: they **create an account** (name, email, password) on the site, **log in**, then **connect GitHub**
from the dashboard. The GitHub connection is saved with their account.

---

## 1. Create the VPS

In your provider's control panel (DigitalOcean: **Create → Droplets**):

- **Image:** Ubuntu 24.04 (LTS) x64
- **Size:** at least **2 GB RAM**. 1 GB works only with the swap file from step 5.
- **Authentication:** SSH key. Add your computer's public key. If you don't have one, run
  `ssh-keygen -t ed25519` on your computer and paste the contents of `~/.ssh/id_ed25519.pub`.

Note the public IPv4 address once it's created.

## 2. Point the subdomain at the VPS

Wherever `mydomain.com`'s DNS is managed (your registrar, Cloudflare, DigitalOcean **Networking → Domains**, …),
add one record:

| Type | Name / Host | Value | TTL |
| --- | --- | --- | --- |
| `A` | `builder` | `203.0.113.10` | 300 (or the lowest offered) |

If you use Cloudflare, set the record to **DNS only** (grey cloud) for now. Certbot in step 13 needs to reach the
server directly.

Check it from **your computer**. It can take a few minutes to a few hours:

```bash
nslookup builder.mydomain.com        # should answer 203.0.113.10
```

Carry on with the next steps while it spreads. It only has to work by step 13.

## 3. First login and updates

From **your computer**:

```bash
ssh root@203.0.113.10
```

On the VPS:

```bash
apt update && apt upgrade -y
timedatectl set-timezone UTC
```

If it asks about restarting services or a newer kernel, accept the defaults. Run `reboot` afterwards if it says a restart
is required, then SSH in again.

## 4. Create a user for the app

```bash
adduser twinstack                       # choose a password, other questions can stay empty
usermod -aG sudo twinstack
rsync --archive --chown=twinstack:twinstack ~/.ssh /home/twinstack
exit
```

From **your computer**, log in as that user. Every later step runs as `twinstack`:

```bash
ssh twinstack@203.0.113.10
```

## 5. Firewall and swap

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
```

Only SSH, HTTP and HTTPS are open. The app's ports (3000, 4000) and MongoDB (27017) stay private.

Swap stops `npm run build` running out of memory on small servers:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

## 6. Install Node.js, git, Nginx, Certbot and PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git nginx certbot python3-certbot-nginx
sudo npm install -g pm2

node -v       # v22.x (anything 20.12 or newer works)
git --version
nginx -v
pm2 -v
```

`git` is required at runtime too: the site manager uses it to clone and push users' sites.

## 7. Install MongoDB 8.0

```bash
sudo apt install -y gnupg curl
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
sudo systemctl status mongod --no-pager     # "active (running)"
```

### Create the database users

Generate two passwords and save them in your password manager. Hex passwords avoid characters that would need escaping
in the connection string.

```bash
openssl rand -hex 24     # ADMIN_PASSWORD
openssl rand -hex 24     # APP_PASSWORD
mongosh
```

In `mongosh`, paste each password when `passwordPrompt()` asks:

```js
use admin
db.createUser({ user: "admin", pwd: passwordPrompt(), roles: ["userAdminAnyDatabase", "readWriteAnyDatabase"] })

use twinstack
db.createUser({ user: "twinstack", pwd: passwordPrompt(), roles: [{ role: "readWrite", db: "twinstack" }] })
exit
```

### Require passwords and keep MongoDB private

```bash
sudo nano /etc/mongod.conf
```

Make these two sections look like this. `net` is already there; add `security` if it's missing or commented out:

```yaml
net:
  port: 27017
  bindIp: 127.0.0.1

security:
  authorization: enabled
```

Save (Ctrl+O, Enter) and exit (Ctrl+X), then:

```bash
sudo systemctl restart mongod
mongosh "mongodb://twinstack:APP_PASSWORD@127.0.0.1:27017/twinstack?authSource=twinstack" --eval "db.runCommand({ ping: 1 })"
```

It should print `{ ok: 1 }`.

## 8. Create the GitHub OAuth App

This is what the dashboard's **Connect GitHub** button uses. On GitHub, go to **Settings → Developer settings → OAuth Apps
→ New OAuth App**:

| Field | Value |
| --- | --- |
| Application name | Twinstack Builder |
| Homepage URL | `https://builder.mydomain.com` |
| Authorization callback URL | `https://builder.mydomain.com/auth/github/callback` |

Click **Register application**, then **Generate a new client secret**. Copy the **Client ID** and the **Client secret**
now; the secret is shown only once. Keep this app separate from the one you use on `localhost`, because each app has one
callback URL.

## 9. Get the code onto the VPS

First, on **your computer**: commit and push your latest changes to GitHub. The server can only deploy what's there.

Then on the VPS:

```bash
sudo mkdir -p /opt/twinstack /var/lib/twinstack/workspaces
sudo chown -R twinstack:twinstack /opt/twinstack /var/lib/twinstack
```

The repository is private, so give the server read-only access with a deploy key:

```bash
ssh-keygen -t ed25519 -C "builder.mydomain.com" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

On GitHub, open **DemoProjectDjango/twinstack-web → Settings → Deploy keys → Add deploy key**. Paste the key, title it
`builder.mydomain.com`, and leave **Allow write access** off. Then:

```bash
ssh -T git@github.com                    # type "yes"; it replies that you've authenticated
git clone git@github.com:DemoProjectDjango/twinstack-web.git /opt/twinstack/web
```

## 10. Configure

Generate two secrets:

```bash
openssl rand -hex 32     # JWT_SECRET
openssl rand -hex 32     # DATA_ENCRYPTION_KEY: also save a copy somewhere safe
```

Create the API's settings file:

```bash
nano /opt/twinstack/web/server/.env
```

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=4000
CLIENT_URL=https://builder.mydomain.com

# From step 8
GITHUB_CLIENT_ID=paste-client-id
GITHUB_CLIENT_SECRET=paste-client-secret

# From above
JWT_SECRET=paste-first-secret
DATA_ENCRYPTION_KEY=paste-second-secret

# From step 7
MONGODB_URI=mongodb://twinstack:APP_PASSWORD@127.0.0.1:27017/twinstack?authSource=twinstack
MONGODB_DB=twinstack

SITE_TEMPLATE_REPO=DemoProjectDjango/twinstack-site
# GitHub usernames (comma-separated) allowed to open sites. Required in production, or nobody can.
ALLOWED_GITHUB_LOGINS=your-github-username
WORKSPACES_DIR=/var/lib/twinstack/workspaces
```

Lock it down and create the web app's settings file:

```bash
chmod 600 /opt/twinstack/web/server/.env
echo "API_URL=http://127.0.0.1:4000" > /opt/twinstack/web/client/.env.local
```

What the secrets do:

- `JWT_SECRET` encrypts login cookies. Changing it only logs everyone out.
- `DATA_ENCRYPTION_KEY` encrypts each user's GitHub token and Anthropic key in MongoDB. **Never change or lose it.**
  Without it, users would have to reconnect GitHub and re-enter their keys.

## 11. Install and build

```bash
cd /opt/twinstack/web
npm install          # also installs client/ and server/
npm run build        # builds the Next.js app; it reads API_URL here
```

## 12. Start the app with PM2

```bash
cd /opt/twinstack/web
pm2 start ecosystem.config.cjs
pm2 status                            # twinstack-api and twinstack-web both "online"
pm2 logs twinstack-api --lines 20     # "Connected to MongoDB (twinstack)" and "API listening on http://127.0.0.1:4000"
curl http://127.0.0.1:3000/api/health # {"ok":true}
```

Make it start again after a reboot:

```bash
pm2 save
pm2 startup systemd
```

`pm2 startup` prints a command beginning with `sudo env PATH=...`. Copy it, run it, then run `pm2 save` again.

## 13. Nginx and HTTPS

```bash
sudo nano /etc/nginx/sites-available/builder
```

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name builder.mydomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Copying a large repository can take several minutes.
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/builder /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t                       # "syntax is ok" and "test is successful"
sudo systemctl reload nginx
```

Check that DNS from step 2 is working (`nslookup builder.mydomain.com` shows your IP), then get the certificate:

```bash
sudo certbot --nginx -d builder.mydomain.com --redirect --agree-tos -m you@example.com --no-eff-email
sudo certbot renew --dry-run        # confirms automatic renewal works
```

Certbot adds HTTPS to the Nginx config and redirects `http://` to `https://`. Renewal happens automatically.

If you use Cloudflare, you can turn its proxy (orange cloud) back on now. Set **SSL/TLS** to **Full (strict)**.

## 14. Open the site

```bash
curl https://builder.mydomain.com/api/health     # {"ok":true}
```

In your browser:

1. Go to `https://builder.mydomain.com` and click **Create an account**.
2. On the dashboard, click **Connect GitHub** and approve the permissions. You come back to the dashboard connected.
3. Your site template appears under **Site repositories**. **Duplicate** it, then click **Manage site** on your copy.

If **Manage site** says "Site management isn't enabled for your account", the GitHub username you connected isn't in
`ALLOWED_GITHUB_LOGINS` (step 10). Fix it, then run `pm2 restart twinstack-api`.

---

## Deploying updates

On **your computer**, push the changes to GitHub. Then on the VPS:

```bash
cd /opt/twinstack/web
git pull
npm install
npm run build
pm2 restart all
```

## Backups

```bash
mkdir -p ~/backups
mongodump --uri="mongodb://twinstack:APP_PASSWORD@127.0.0.1:27017/twinstack?authSource=twinstack" \
  --archive=$HOME/backups/twinstack-$(date +%F).gz --gzip
```

To back up every night at 03:00 and keep 14 days, run `crontab -e` and add:

```cron
0 3 * * * mongodump --uri="mongodb://twinstack:APP_PASSWORD@127.0.0.1:27017/twinstack?authSource=twinstack" --archive=$HOME/backups/twinstack-$(date +\%F).gz --gzip && find $HOME/backups -name 'twinstack-*.gz' -mtime +14 -delete
```

Copy the backups off the server regularly. Keep `server/.env` backed up separately: a database backup can't decrypt
users' GitHub tokens and Anthropic keys without its `DATA_ENCRYPTION_KEY`.

Restore with:

```bash
mongorestore --uri="mongodb://twinstack:APP_PASSWORD@127.0.0.1:27017/twinstack?authSource=twinstack" --archive=FILE.gz --gzip --drop
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser can't reach the site at all | `nslookup builder.mydomain.com` shows your IP, `sudo ufw status` allows 80/443, `sudo systemctl status nginx` |
| 502 Bad Gateway | `pm2 status`, then `pm2 logs`. One of the apps isn't running. |
| API stops with "Missing required environment variable" | That variable is missing from `server/.env` |
| API stops with a MongoDB error | `sudo systemctl status mongod`, and test the user and password with the `mongosh` command from step 7 |
| Certbot fails | DNS isn't pointing at the server yet, port 80 is blocked, or the Cloudflare proxy is on |
| GitHub says "redirect_uri is not associated with this application" | The OAuth App's callback must be exactly `https://builder.mydomain.com/auth/github/callback`, matching `CLIENT_URL` |
| After logging in you're sent back to the login page | The site isn't on HTTPS yet, so the browser drops the secure cookie. Finish step 13. |
| "Too many failed attempts" | 10 wrong passwords for that email in 15 minutes. Wait, or `pm2 restart twinstack-api`. |
| `npm run build` is killed | Out of memory: add the swap file (step 5) |

Useful commands:

```bash
pm2 logs                      # live logs from both apps (Ctrl+C to stop)
pm2 restart twinstack-api     # after editing server/.env
sudo tail -f /var/log/nginx/error.log
```

## Running it on your computer

The API needs MongoDB at startup. Install
[MongoDB Community Server](https://www.mongodb.com/try/download/community) on your computer. Then, in your local
`server/.env`:

```ini
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=twinstack_dev
DATA_ENCRYPTION_KEY=<a different 64-hex value from production>
```

Use your separate localhost GitHub OAuth App, with callback `http://localhost:3000/auth/github/callback`. Then run
`npm run dev`.
