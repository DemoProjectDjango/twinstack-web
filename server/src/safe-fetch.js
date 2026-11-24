import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

// Fetching addresses an owner typed (copy-website.js) from the app's own server. Without care that
// is server-side request forgery: "http://169.254.169.254/" (the cloud's metadata service),
// "http://localhost:4000/" (this API) or a name that resolves to 10.x would be reached from inside.
// So every connection, redirects included, may only reach a public address on port 80 or 443, and
// the check runs on the address the socket actually connects to (the `lookup` below), so a name
// that resolves differently the second time (DNS rebinding) can't slip past it.

export class FetchRefused extends Error {}

const V4_BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const v4 = (ip) => ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;

/** Whether `ip` is an ordinary public internet address. */
export function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = v4(ip);
    return !V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (v4(base) >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (lower === "::" || lower === "::1") return false;
    // Unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8), documentation (2001:db8::/32), NAT64 and 6to4 wrappers.
    return !/^(f[cd]|fe[89ab]|ff)/.test(lower) && !lower.startsWith("2001:db8") && !lower.startsWith("64:ff9b") && !lower.startsWith("2002:");
  }
  return false;
}

/** The URL as a public http(s) address, or a FetchRefused saying why not. */
export function checkUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefused(`${String(raw).slice(0, 100)} isn't a web address.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FetchRefused("Only http and https addresses can be fetched.");
  if (url.username || url.password) throw new FetchRefused("Addresses with a user name or password can't be fetched.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new FetchRefused("Only the usual web ports (80 and 443) can be fetched.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new FetchRefused("That address is on a private network.");
  }
  if (net.isIP(host) && !isPublicAddress(host)) throw new FetchRefused("That address is on a private network.");
  return url;
}

/** dns.lookup that refuses names resolving to anything but public addresses (used by every socket). */
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => !isPublicAddress(a.address));
    if (bad || !addresses.length) return callback(new FetchRefused(`${hostname} is on a private network.`));
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/** Whether every address `hostname` resolves to is public (for requests a browser makes). */
export async function hostIsPublic(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return isPublicAddress(host);
  try {
    const addresses = await dns.promises.lookup(host, { all: true });
    return addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address));
  } catch {
    return false;
  }
}

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 TwinstackCopy/1.0";

function requestOnce(url, { timeoutMs, maxBytes, accept }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: publicLookup,
        timeout: timeoutMs,
        headers: { "user-agent": USER_AGENT, accept: accept ?? "*/*", "accept-encoding": "gzip, deflate, br", "accept-language": "en" },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: new URL(res.headers.location, url).href, status: res.statusCode });
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream = encoding === "br" ? res.pipe(zlib.createBrotliDecompress()) : encoding === "gzip" ? res.pipe(zlib.createGunzip()) : encoding === "deflate" ? res.pipe(zlib.createInflate()) : res;
        const chunks = [];
        let size = 0;
        stream.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new FetchRefused(`${url.href.slice(0, 120)} is bigger than ${Math.round(maxBytes / 1024 / 1024)} MB.`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: url.href }));
        stream.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new FetchRefused(`${url.host} took too long to answer.`)));
    req.on("error", reject);
    req.end();
  });
}

/**
 * GETs a public address, following up to 5 redirects (each one checked again), and returns
 * `{ status, headers, body: Buffer, url }` (the final address). Throws FetchRefused for private
 * or unusual addresses and bodies over `maxBytes`, and network errors as they come.
 */
export async function safeFetch(raw, { timeoutMs = 20_000, maxBytes = 5 * 1024 * 1024, accept } = {}) {
  let url = checkUrl(raw);
  for (let hop = 0; hop <= 5; hop++) {
    const result = await requestOnce(url, { timeoutMs, maxBytes, accept });
    if (!result.redirect) return result;
    url = checkUrl(result.redirect);
  }
  throw new FetchRefused(`${String(raw).slice(0, 100)} redirects too many times.`);
}
