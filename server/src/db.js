import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import { config } from "./config.js";

// MongoDB holds everything that outlives a browser session:
//   users       one document per account (_id = ObjectId): email, password
//               hash, sign-in history, the connected GitHub account (profile +
//               encrypted token) and the encrypted Anthropic API key
//   siteCopies  one document per repo duplicated from the site template
//               (_id = GitHub repo id, which survives renames)
//
// Account ids leave this module as 24-character hex strings.

let client;
let db;

export async function connectDb() {
  client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  db = client.db(config.mongo.dbName);
  await Promise.all([
    // Partial: documents without the field don't count as duplicates of each other.
    users().createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } }),
    users().createIndex({ "github.id": 1 }, { unique: true, partialFilterExpression: { "github.id": { $type: "number" } } }),
    siteCopies().createIndex({ userId: 1 }),
  ]);
}

export async function closeDb() {
  await client?.close();
}

const users = () => db.collection("users");
const siteCopies = () => db.collection("siteCopies");

function objectId(id) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

/* ---------------------------------------------------------------- secrets */

// AES-256-GCM under DATA_ENCRYPTION_KEY. The associated data names the field
// and the account, so a ciphertext copied elsewhere fails to decrypt.

function encrypt(plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.dataKey, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decrypt({ ciphertext, iv, tag }, aad) {
  const decipher = createDecipheriv("aes-256-gcm", config.dataKey, Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function tryDecrypt(secret, aad, label) {
  if (!secret) return null;
  try {
    return decrypt(secret, aad);
  } catch {
    // Wrong DATA_ENCRYPTION_KEY or a tampered document: treat as absent.
    console.error(`Stored ${label} could not be decrypted.`);
    return null;
  }
}

/* --------------------------------------------------------------- accounts */

export class DuplicateEmailError extends Error {}

/** What the rest of the app (and the browser, via /api/me) sees of an account. */
export function publicUser(doc) {
  return {
    id: doc._id.toHexString(),
    email: doc.email,
    name: doc.name,
    github: doc.github
      ? {
          id: doc.github.id,
          login: doc.github.login,
          name: doc.github.name,
          email: doc.github.email,
          avatarUrl: doc.github.avatarUrl,
          profileUrl: doc.github.profileUrl,
        }
      : null,
  };
}

export async function createUser({ email, name, passwordHash }) {
  const now = new Date();
  const doc = { email, name, passwordHash, createdAt: now, lastLoginAt: now, loginCount: 1 };
  try {
    const { insertedId } = await users().insertOne(doc);
    return { ...doc, _id: insertedId };
  } catch (err) {
    if (err?.code === 11000) throw new DuplicateEmailError("An account with that email already exists.");
    throw err;
  }
}

export function findUserByEmail(email) {
  return users().findOne({ email });
}

export async function findUserById(id) {
  const _id = objectId(id);
  return _id ? users().findOne({ _id }) : null;
}

export async function recordLogin(id) {
  await users().updateOne({ _id: objectId(id) }, { $set: { lastLoginAt: new Date() }, $inc: { loginCount: 1 } });
}

/* ----------------------------------------------------------------- github */

export class GithubInUseError extends Error {}

/** Links a GitHub account (profile + token) to this account. One GitHub account per app account. */
export async function linkGithub(id, profile, token) {
  const _id = objectId(id);
  const other = await users().findOne({ "github.id": profile.id, _id: { $ne: _id } }, { projection: { _id: 1 } });
  if (other) throw new GithubInUseError("That GitHub account is already connected to another account.");
  await users().updateOne(
    { _id },
    {
      $set: {
        github: { ...profile, connectedAt: new Date(), token: encrypt(JSON.stringify(token), `githubToken:${id}`) },
      },
    },
  );
}

export async function saveGithubToken(id, token) {
  await users().updateOne({ _id: objectId(id) }, { $set: { "github.token": encrypt(JSON.stringify(token), `githubToken:${id}`) } });
}

export async function unlinkGithub(id) {
  await users().updateOne({ _id: objectId(id) }, { $unset: { github: "" } });
}

/** `{ accessToken, refreshToken, expiresAt, scopes }` for an account document, or null. */
export function githubTokenOf(doc) {
  const id = doc._id.toHexString();
  const json = tryDecrypt(doc.github?.token, `githubToken:${id}`, `GitHub token for account ${id}`);
  return json ? JSON.parse(json) : null;
}

/* ---------------------------------------------------------- anthropic key */

export function keyHint(key) {
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

export async function setAnthropicKey(id, key) {
  await users().updateOne(
    { _id: objectId(id) },
    { $set: { anthropicKey: { ...encrypt(key, `anthropicKey:${id}`), hint: keyHint(key), updatedAt: new Date() } } },
  );
}

export async function clearAnthropicKey(id) {
  await users().updateOne({ _id: objectId(id) }, { $unset: { anthropicKey: "" } });
}

/** The masked key for display, or null. Never decrypts. */
export async function getAnthropicKeyHint(id) {
  const doc = await users().findOne({ _id: objectId(id) }, { projection: { "anthropicKey.hint": 1 } });
  return doc?.anthropicKey?.hint ?? null;
}

/** The plaintext key for handing to a Claude command, or null. */
export async function getAnthropicKey(id) {
  const doc = await users().findOne({ _id: objectId(id) }, { projection: { anthropicKey: 1 } });
  return tryDecrypt(doc?.anthropicKey, `anthropicKey:${id}`, `Anthropic key for account ${id}`);
}

/* ------------------------------------------------------------ site copies */

export async function recordSiteCopy({ userId, repo, source }) {
  await siteCopies().updateOne(
    { _id: repo.id },
    { $set: { fullName: repo.fullName, userId, source }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
}

/** Which of these GitHub repo ids were created as copies of the template. */
export async function findSiteCopyIds(repoIds) {
  const docs = await siteCopies()
    .find({ _id: { $in: repoIds } }, { projection: { _id: 1 } })
    .toArray();
  return new Set(docs.map((doc) => doc._id));
}
