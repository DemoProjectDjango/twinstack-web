import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// scrypt from Node's standard library, stored as "scrypt$N$r$p$salt$hash" so
// the cost can be raised later without breaking existing hashes.

const scryptAsync = promisify(scrypt);
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password, stored) {
  const [scheme, n, r, p, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

// Checked against when the email doesn't exist, so a login attempt takes the
// same time either way and doesn't reveal which emails have accounts.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));

export async function verifyAgainstDummy(password) {
  await verifyPassword(password, DUMMY_HASH);
  return false;
}
