import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// Emailed 6-digit codes, shared by sign-up (pendingSignups) and password reset
// (passwordResets). A request emails a code and returns a token the browser keeps;
// the follow-up must bring both. Records hold only hashes of the two.
//
// The token ties the code to the browser that asked for it: a newer request for the
// same address replaces the record, so someone else's request can't ride on the
// code the owner receives.

export const CODE_TTL_MS = 15 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_RESEND_MS = 60 * 1000;
export const CODE_MAX_SENDS = 5; // per address, while its record lives (an hour, by TTL)

// Codes emailed per IP, to stop the forms being used to email strangers. In memory,
// so it resets on restart; enough for a single-server deployment.
const IP_WINDOW_MS = 60 * 60 * 1000;
const IP_MAX = 10;
const sendsByIp = new Map();

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function sameHash(a, b) {
  return typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const codeHash = (email, code) => sha256(`${email}:${code}`);

/** A new code and token, with the hashed fields a record stores. */
export function newCode(email) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const token = randomBytes(32).toString("hex");
  return {
    code,
    token,
    fields: { codeHash: codeHash(email, code), tokenHash: sha256(token), codeExpiresAt: new Date(Date.now() + CODE_TTL_MS) },
  };
}

/**
 * Whether another code may be emailed now: null, or { status, body } to answer with. The
 * resend wait carries retryAfter (seconds), which drives the forms' countdown ring.
 */
export function sendRefusal(record, ip, what = "requests") {
  const waitMs = record ? record.sentAt.getTime() + CODE_RESEND_MS - Date.now() : 0;
  if (waitMs > 0) {
    return {
      status: 429,
      body: { error: "We just sent a code. Wait a minute before asking for another.", retryAfter: Math.ceil(waitMs / 1000) },
    };
  }
  if (record && record.sends >= CODE_MAX_SENDS) {
    return { status: 429, body: { error: "Too many codes sent to this address. Try again in an hour." } };
  }
  if (ipLimited(ip)) return { status: 429, body: { error: `Too many ${what} from here. Try again in an hour.` } };
  return null;
}

function ipLimited(ip) {
  const entry = sendsByIp.get(ip);
  if (!entry || entry.resetAt < Date.now()) {
    sendsByIp.set(ip, { count: 1, resetAt: Date.now() + IP_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > IP_MAX;
}

/** Reads { email, token, code } from a request body; code is null unless it's 6 digits. */
export function readCodeAttempt(body) {
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const token = typeof body?.token === "string" ? body.token : "";
  const code = typeof body?.code === "string" ? body.code.replace(/\s+/g, "") : "";
  return { email, token, code: /^\d{6}$/.test(code) ? code : null };
}

/**
 * Checks a code against its record. Returns { ok: true, tokenHash } or { ok: false, status,
 * body, wrongCode, discard }: count wrongCode against the record (by tokenHash), delete it on discard.
 */
export function checkCode(record, { email, token, code }, startOver) {
  const tokenHash = sha256(token);
  if (!record || !sameHash(record.tokenHash, tokenHash)) {
    return { ok: false, status: 410, body: { error: `This has expired or was replaced. ${startOver}`, restart: true } };
  }
  if (record.attempts >= CODE_MAX_ATTEMPTS) {
    return { ok: false, discard: true, status: 429, body: { error: "Too many wrong codes. Start again to get a new one.", restart: true } };
  }
  if (record.codeExpiresAt.getTime() < Date.now()) {
    return { ok: false, status: 410, body: { error: "That code has expired. Send a new one.", expired: true } };
  }
  if (!sameHash(record.codeHash, codeHash(email, code))) {
    return { ok: false, wrongCode: true, tokenHash, status: 400, body: { error: "That code isn't right. Check the email and try again." } };
  }
  return { ok: true, tokenHash };
}
