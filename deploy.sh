#!/usr/bin/env bash
# Deploys this checkout on the droplet (see UPDATING.md). Run from anywhere:
#
#   bash deploy.sh                    pull from GitHub, then install, build and restart only what changed
#   bash deploy.sh --full             same, but reinstall, rebuild and restart everything
#   bash deploy.sh --no-pull --full   deploy the commit that's checked out (first install, rollback)
set -euo pipefail

cd "$(dirname "$0")"

full=false
pull=true
for arg in "$@"; do
  case "$arg" in
    --full) full=true ;;
    --no-pull) pull=false ;;
    *) echo "Unknown option: $arg (use --full and/or --no-pull)" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }

# One deploy at a time.
exec 9>/tmp/twinstack-deploy.lock
flock -n 9 || { echo "Another deploy is already running." >&2; exit 1; }

# Code changes belong on your computer; edits made here would block the pull.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "This checkout has local changes. Make them on your computer and push instead." >&2
  git status --short --untracked-files=no >&2
  echo "To throw these changes away: git checkout -- . && bash deploy.sh" >&2
  exit 1
fi

if $pull; then
  step "Pulling from GitHub"
  git pull --ff-only
fi
new=$(git rev-parse HEAD)

# What's running is the last commit that finished a deploy, not whatever was checked out before this pull:
# a failed deploy or a manual `git pull` moves the checkout without rebuilding anything.
state="$(git rev-parse --git-dir)/twinstack-deployed"
old=$(cat "$state" 2>/dev/null || true)
if [ -z "$old" ] || ! git cat-file -e "$old^{commit}" 2>/dev/null; then
  if ! $full; then echo "No record of a finished deploy here, so deploying everything."; fi
  full=true
  old=$new
fi

if [ "$old" = "$new" ] && ! $full; then
  echo "Already up to date at $(git log -1 --format='%h %s'). Use --full to rebuild anyway."
  exit 0
fi

files=""
if [ "$old" != "$new" ]; then
  step "Changes since the last deploy ($(git rev-parse --short "$old"))"
  git log --oneline "$old..$new"
  files=$(git diff --name-only "$old" "$new")
fi

# True if a changed file matches the pattern, or always with --full.
changed() { $full || grep -qE "$1" <<<"$files"; }

if changed '^server/package(-lock)?\.json$'; then
  step "Installing API dependencies"
  npm ci --prefix server
fi

if changed '^client/package(-lock)?\.json$'; then
  step "Installing web app dependencies"
  npm ci --prefix client
fi

if changed '^client/'; then
  step "Building the web app"
  npm --prefix client run build
fi

# PM2 only rereads ecosystem.config.cjs when an app is started, so a changed file means delete and start.
recreate=false
if changed '^ecosystem\.config\.cjs$'; then recreate=true; fi

restart() {
  local app=$1
  if $recreate || ! pm2 jlist | grep "\"name\":\"$app\"" >/dev/null; then
    pm2 delete "$app" >/dev/null 2>&1 || true
    pm2 start ecosystem.config.cjs --only "$app"
  else
    pm2 restart "$app"
  fi
}

restarted=false
if changed '^server/' || $recreate; then
  step "Restarting the API"
  restart twinstack-api
  restarted=true
fi
if changed '^client/' || $recreate; then
  step "Restarting the web app"
  restart twinstack-web
  restarted=true
fi
if $restarted; then pm2 save >/dev/null; fi

# Waits up to a minute for {"ok":true}.
check() {
  local name=$1 url=$2 app=$3
  for _ in $(seq 30); do
    if curl -fsS "$url" 2>/dev/null | grep -q '"ok":true'; then
      echo "$name OK"
      return 0
    fi
    sleep 2
  done
  echo "$name isn't answering at $url. See: pm2 logs $app --lines 50" >&2
  return 1
}

step "Checking health"
check "API" http://127.0.0.1:4000/api/health twinstack-api
check "Web app" http://127.0.0.1:3000/api/health twinstack-web

echo "$new" > "$state"

echo
echo "Deployed $(git log -1 --format='%h %s')."
if [ "$old" != "$new" ]; then
  echo "To roll back: git reset --hard $(git rev-parse --short "$old") && bash deploy.sh --no-pull --full"
fi
