# Deploying to a DigitalOcean droplet

This guide runs Twinstack Web on one Ubuntu droplet (22.04 or 24.04). Everything lives on the droplet:

```
browser ──HTTPS──> Nginx :443 ──> Next.js 127.0.0.1:3000 ──> Express 127.0.0.1:4000 ──> MongoDB 127.0.0.1:27017
```

Replace these placeholders everywhere below:

| Placeholder | Example | What it is |
| --- | --- | --- |
| `203.0.113.10` | your droplet's IP | from the DigitalOcean control panel |
| `203-0-113-10.sslip.io` | the IP with dots → dashes, plus `.sslip.io` | your hostname (see below) |
| `you@example.com` | | for Let's Encrypt expiry emails |

**Why sslip.io when you have no domain.** GitHub sign-in and the app's secure session cookies need HTTPS, and
HTTPS certificates need a hostname. [sslip.io](https://sslip.io) is a free public DNS service where
`203-0-113-10.sslip.io` resolves to `203.0.113.10`, so you get a working hostname with no setup. When you buy a domain
later, point it at the droplet and repeat steps 9, 12 and 13 with the new name.

Commands marked `$` run as your normal user with `sudo`. Commands in `mongosh` blocks run inside the MongoDB shell.

---

## 1. Connect and update

From your computer:

```bash
ssh root@203.0.113.10
```

On the droplet:

```bash
apt update && apt upgrade -y
```

## 2. Create a non-root user

```bash
adduser twinstack                     # choose a password
usermod -aG sudo twinstack
rsync --archive --chown=twinstack:twinstack ~/.ssh /home/twinstack   # reuse your SSH key
exit
```

Log back in as that user. Every later step runs as `twinstack`:

```bash
ssh twinstack@203.0.113.10
```

## 3. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Ports 3000, 4000 and 27017 stay closed. Only Nginx is public.

## 4. Swap (droplets with 2 GB RAM or less)

`next build` can run out of memory without it.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

## 5. Check what the MERN image already has

```bash
node -v; npm -v; git --version; mongod --version; pm2 -v; nginx -v
lsb_release -cs        # jammy = 22.04, noble = 24.04
```

Install only what's missing or too old. Node must be **20.12 or newer**.

### Node.js 22 (if missing or older than 20.12)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
node -v
```

### PM2, Nginx and Certbot

```bash
sudo npm install -g pm2
sudo apt install -y nginx certbot python3-certbot-nginx
```

## 6. MongoDB

### Install MongoDB 8.0 (skip if `mongod --version` already worked)

```bash
sudo apt install -y gnupg curl
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/8.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
sudo systemctl status mongod --no-pager
```

### Create users

Generate two passwords first. Hex passwords avoid characters that would need escaping in the connection string.

```bash
openssl rand -hex 24     # admin password, save it
openssl rand -hex 24     # app password, save it
mongosh
```

```js
use admin
db.createUser({ user: "admin", pwd: passwordPrompt(), roles: ["userAdminAnyDatabase", "readWriteAnyDatabase"] })

use twinstack
db.createUser({ user: "twinstack", pwd: passwordPrompt(), roles: [{ role: "readWrite", db: "twinstack" }] })
exit
```

### Turn on authentication and keep it on localhost

```bash
sudo nano /etc/mongod.conf
```

Make sure these sections look like this:

```yaml
net:
  port: 27017
  bindIp: 127.0.0.1

security:
  authorization: enabled
```

```bash
sudo systemctl restart mongod
mongosh "mongodb://twinstack:APP_PASSWORD@127.0.0.1:27017/twinstack?authSource=twinstack" --eval "db.runCommand({ ping: 1 })"
```

The last command should print `{ ok: 1 }`.

## 7. Create the production GitHub OAuth App

On GitHub, go to **Settings → Developer settings → OAuth Apps → New OAuth App**:

| Field | Value |
| --- | --- |
| Homepage URL | `https://203-0-113-10.sslip.io` |
| Authorization callback URL | `https://203-0-113-10.sslip.io/auth/github/callback` |

Create it, then **Generate a new client secret**. Keep the Client ID and secret for step 10.
Use a separate app from the one you use locally, because each app has one callback URL.

## 8. Get the code

Push your latest local changes to GitHub first. The droplet can only deploy what's on GitHub.

```bash
sudo mkdir -p /opt/twinstack /var/lib/twinstack/workspaces
sudo chown -R twinstack:twinstack /opt/twinstack /var/lib/twinstack
```

The repository is private, so give the droplet read access with a deploy key:

```bash
ssh-keygen -t ed25519 -C "twinstack-droplet" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

On GitHub, open **DemoProjectDjango/twinstack-web → Settings → Deploy keys → Add deploy key**, paste the key, and
leave write access off. Then:

```bash
ssh -T git@github.com               # answer "yes"; it says you've authenticated
git clone git@github.com:DemoProjectDjango/twinstack-web.git /opt/twinstack/web
```

The site manager also needs `git` itself (step 5) to clone users' sites.

## 9. Configure

Generate the two secrets:

```bash
openssl rand -hex 32     # JWT_SECRET
openssl rand -hex 32     # DATA_ENCRYPTION_KEY, back this one up somewhere safe
```

```bash
nano /opt/twinstack/web/server/.env
```

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=4000
CLIENT_URL=https://203-0-113-10.sslip.io

GITHUB_CLIENT_ID=<from step 7>
GITHUB_CLIENT_SECRET=<from step 7>
JWT_SECRET=<first secret>

MONGODB_URI=mongodb://twinstack:APP_PASSWORD@127.0.0.1:27017/twinstack?authSource=twinstack
MONGODB_DB=twinstack
DATA_ENCRYPTION_KEY=<second secret>

SITE_TEMPLATE_REPO=DemoProjectDjango/twinstack-site
# Required in production: nobody can open sites otherwise. Comma-separated GitHub usernames.
ALLOWED_GITHUB_LOGINS=your-github-username
WORKSPACES_DIR=/var/lib/twinstack/workspaces
```

```bash
chmod 600 /opt/twinstack/web/server/.env
echo "API_URL=http://127.0.0.1:4000" > /opt/twinstack/web/client/.env.local
```

**Never change `DATA_ENCRYPTION_KEY` after users have saved API keys.** Their stored keys can't be decrypted without it,
and they would have to enter them again. Changing `JWT_SECRET` only signs everyone out.

## 10. Install and build

```bash
cd /opt/twinstack/web
npm install          # also installs client/ and server/
npm run build        # builds the Next.js client; API_URL is read here
```

## 11. Start with PM2

```bash
cd /opt/twinstack/web
pm2 start ecosystem.config.cjs
pm2 status                          # both apps "online"
pm2 logs twinstack-api --lines 20   # expect "Connected to MongoDB" and "API listening"
pm2 save
pm2 startup systemd                 # prints a sudo command: copy and run it
```

After `pm2 startup`, the apps come back by themselves when the droplet reboots.

## 12. Nginx

```bash
sudo nano /etc/nginx/sites-available/twinstack
```

```nginx
server {
    listen 80;
    server_name 203-0-113-10.sslip.io;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Duplicating a large repository can take several minutes.
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/twinstack /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

## 13. HTTPS

```bash
sudo certbot --nginx -d 203-0-113-10.sslip.io --redirect --agree-tos -m you@example.com
sudo certbot renew --dry-run        # checks automatic renewal
```

Certbot updates the Nginx config and sets up automatic renewal. sslip.io is shared by many people, so Let's Encrypt
sometimes rate-limits it. If certbot reports a rate limit, wait an hour and retry, or use the equivalent
`203.0.113.10.nip.io` name. If you switch names, update `CLIENT_URL`, the OAuth App URLs and the Nginx `server_name` to
match.

## 14. Check it works

```bash
curl https://203-0-113-10.sslip.io/api/health     # {"ok":true}
```

Open `https://203-0-113-10.sslip.io` and sign in with GitHub. The dashboard should list the site template.

---

## Updating to a new version

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

To run it every night at 03:00, run `crontab -e` and add the same command prefixed with `0 3 * * *`. Also copy
`server/.env` somewhere safe: without `DATA_ENCRYPTION_KEY`, a database backup can't decrypt users' keys.

Uncommitted work in the site manager lives in `/var/lib/twinstack/workspaces`. Committed work is safe on GitHub.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| 502 Bad Gateway | `pm2 status`, then `pm2 logs`. One of the apps isn't running. |
| API exits with "Missing required environment variable" | That variable is missing from `server/.env`. |
| API exits with a MongoDB error | `sudo systemctl status mongod`, and the user and password in `MONGODB_URI` (test with the step 6 `mongosh` command). |
| GitHub says "redirect_uri is not associated with this application" | The OAuth App callback URL must exactly match `CLIENT_URL` + `/auth/github/callback`. |
| Sign-in returns to the homepage still signed out | The site isn't on HTTPS, so the browser drops the secure cookie. Finish step 13. |
| "Site management isn't enabled for your account" | Add the GitHub username to `ALLOWED_GITHUB_LOGINS`, then `pm2 restart twinstack-api`. |
| `npm run build` is killed | Out of memory: add swap (step 4). |

## Local development after this change

The API now needs MongoDB at startup. Two options:

- **Install MongoDB Community Server on your computer**, then use `MONGODB_URI=mongodb://127.0.0.1:27017` and
  `MONGODB_DB=twinstack_dev` in your local `server/.env`.
- **Use the droplet's MongoDB through an SSH tunnel.** Create a separate user for a `twinstack_dev` database so
  development data stays apart from production:

  ```js
  // mongosh as admin on the droplet
  use twinstack_dev
  db.createUser({ user: "dev", pwd: passwordPrompt(), roles: [{ role: "readWrite", db: "twinstack_dev" }] })
  ```

  ```bash
  # on your computer, keep this running while you develop
  ssh -N -L 27018:127.0.0.1:27017 twinstack@203.0.113.10
  ```

  ```ini
  MONGODB_URI=mongodb://dev:DEV_PASSWORD@127.0.0.1:27018/twinstack_dev?authSource=twinstack_dev
  MONGODB_DB=twinstack_dev
  ```

In either case, also add `DATA_ENCRYPTION_KEY` to your local `server/.env`.
