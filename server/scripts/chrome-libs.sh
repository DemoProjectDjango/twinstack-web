#!/usr/bin/env bash
# Makes the headless Chrome that copies websites start on a server that lacks the system libraries
# it needs, without admin rights: the missing Debian/Ubuntu packages are downloaded with
# `apt-get download` (no root) and unpacked into a folder of this user's, and an env file there
# tells the API (server/src/assistant/view-page.js, chromeEnv) where they are.
#
#   bash server/scripts/chrome-libs.sh <chrome-headless-shell> [<folder>]
#
# Exits 0 when Chrome starts (with or without the fetched libraries), 1 when it still can't.
# deploy.sh runs it; it never needs sudo. An admin can instead install them system-wide with
#   sudo npx --yes playwright@<version> install-deps chromium-headless-shell
set -u
shell="${1:?usage: chrome-libs.sh <chrome-headless-shell> [folder]}"
dest="${2:-$HOME/.cache/twinstack-chrome-libs}"
envfile="$dest/env"

starts() {
  (
    if [ -f "$envfile" ]; then set -a; . "$envfile"; set +a; fi
    timeout 60 "$shell" --headless --no-sandbox --disable-gpu --dump-dom 'data:text/html,<p>ok</p>' 2>/dev/null | grep -q '<p>ok</p>'
  )
}

if starts; then echo "The browser starts."; exit 0; fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo "The browser can't start and this isn't a Debian or Ubuntu server: install Chrome's libraries as an admin." >&2
  exit 1
fi

echo "The browser is missing system libraries: fetching them for this user (no admin rights needed)."
mkdir -p "$dest/debs" "$dest/root" "$dest/fontcache"
cd "$dest/debs" || exit 1

# Playwright's list for Chromium on Ubuntu/Debian (24.04 names end in t64), plus fonts.
want=(
  libasound2t64 libasound2 libatk-bridge2.0-0t64 libatk-bridge2.0-0 libatk1.0-0t64 libatk1.0-0
  libatspi2.0-0t64 libatspi2.0-0 libcairo2 libcups2t64 libcups2 libdbus-1-3 libdrm2 libgbm1
  libglib2.0-0t64 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libx11-6 libxcb1
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 libexpat1
  libfontconfig1 fontconfig-config fonts-liberation fonts-dejavu-core
)
avail=()
for p in "${want[@]}"; do apt-cache show "$p" >/dev/null 2>&1 && avail+=("$p"); done
# Everything they depend on, then only what isn't installed already.
mapfile -t all < <(apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances "${avail[@]}" 2>/dev/null | grep -E '^[a-z0-9]' | sort -u)
need=()
for p in "${all[@]}"; do
  dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed" || need+=("$p")
done
echo "Fetching ${#need[@]} packages."
for p in "${need[@]}"; do apt-get download "$p" >/dev/null 2>&1 || true; done
for d in ./*.deb; do [ -e "$d" ] && dpkg-deb -x "$d" "$dest/root"; done

# Where the libraries landed, and a font setup that also sees the fetched fonts.
libdirs=$(find "$dest/root" -name '*.so*' -printf '%h\n' 2>/dev/null | sort -u | paste -sd: -)
cat > "$dest/fonts.conf" <<CONF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/usr/share/fonts</dir>
  <dir>$dest/root/usr/share/fonts</dir>
  <cachedir>$dest/fontcache</cachedir>
  <include ignore_missing="yes">/etc/fonts/conf.d</include>
</fontconfig>
CONF
{
  echo "LD_LIBRARY_PATH=$libdirs"
  echo "FONTCONFIG_FILE=$dest/fonts.conf"
} > "$envfile"

if starts; then
  echo "The browser starts now (libraries in $dest)."
  exit 0
fi
echo "The browser still can't start. Missing:" >&2
(set -a; . "$envfile"; set +a; ldd "$shell" | grep "not found") >&2
exit 1
