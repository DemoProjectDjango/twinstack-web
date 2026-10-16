#!/usr/bin/env node
/**
 * Local testing of visit counting (analytics.js): published sites live on the internet and can't
 * reach localhost, so this opens a Cloudflare quick tunnel to the local API and writes its address
 * into server/.env as PUBLIC_API_URL. Keep it running while you test.
 *
 *   npm run tunnel            (from the repo root or server/)
 *
 * Needs cloudflared (winget install Cloudflare.cloudflared, or brew install cloudflared). A quick
 * tunnel gets a new address every time, so after starting it: the dev API restarts by itself, then
 * press "Update the counter" on the site's Analytics screen and publish, so the live site uses it.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(serverDir, ".env");
const port = process.env.PORT || readEnv("PORT") || "4000";

function readEnv(name) {
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : null;
}

function writePublicUrl(url) {
  const text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const line = `PUBLIC_API_URL=${url}`;
  const next = /^PUBLIC_API_URL=.*$/m.test(text)
    ? text.replace(/^PUBLIC_API_URL=.*$/m, line)
    : `${text}${text && !text.endsWith(newline) ? newline : ""}${line}${newline}`;
  writeFileSync(envFile, next);
  // `node --watch` (npm run dev) restarts on its entry file, not on .env.
  const now = new Date();
  utimesSync(path.join(serverDir, "src/index.js"), now, now);
}

/** winget's install folder (often missing from PATH until a new terminal), else whatever is on PATH. */
function cloudflared() {
  const installed =
    process.platform === "win32"
      ? ["C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe"].find((c) => existsSync(c))
      : null;
  return installed ?? "cloudflared";
}

const binary = cloudflared();
const child = spawn(binary, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
let announced = false;

child.on("error", (err) => {
  console.error(`\n  Couldn't start cloudflared (${err.message}). Install it: winget install Cloudflare.cloudflared\n`);
  process.exit(1);
});

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const url = !announced && /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk)?.[0];
    if (!url) return;
    announced = true;
    writePublicUrl(url);
    console.log(`\n  Tunnel: ${url} → http://localhost:${port}`);
    console.log("  PUBLIC_API_URL is set in server/.env and the dev API is restarting.");
    console.log('  Next: on the site\'s Analytics screen press "Update the counter", then publish.');
    console.log("  Keep this running while you test. Ctrl+C stops it.\n");
  });
}

child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
