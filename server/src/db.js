import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MongoClient } from "mongodb";
import { config } from "./config.js";

// MongoDB holds what must outlive a browser session:
//   users       one document per GitHub user (_id = GitHub user id): profile,
//               sign-in history and their encrypted Anthropic API key
//   siteCopies  one document per repo duplicated from the site template
//               (_id = GitHub repo id, which survives renames)

let client;
let db;

export async function connectDb() {
  client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  db = client.db(config.mongo.dbName);
  await Promise.all([
    db.collection("users").createIndex({ login: 1 }),
    db.collection("siteCopies").createIndex({ userId: 1 }),
  ]);
}

export async function closeDb() {
  await client?.close();
}

const users = () => db.collection("users");
const siteCopies = () => db.collection("siteCopies");

/* ------------------------------------------------------------------ users */

/** Upserts the GitHub profile on every sign-in. */
export async function recordSignIn(user) {
  const now = new Date();
  await users().updateOne(
    { _id: user.id },
    {
      $set: {
        login: user.login,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        profileUrl: user.profileUrl,
        lastLoginAt: now,
      },
      $setOnInsert: { createdAt: now },
      $inc: { loginCount: 1 },
    },
    { upsert: true },
  );
}

/* ---------------------------------------------------------- anthropic key */

// AES-256-GCM, with the user id as associated data so a ciphertext copied onto
// another user's document fails to decrypt.

function encrypt(plaintext, userId) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.dataKey, iv);
  cipher.setAAD(Buffer.from(`anthropicKey:${userId}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decrypt({ ciphertext, iv, tag }, userId) {
  const decipher = createDecipheriv("aes-256-gcm", config.dataKey, Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(`anthropicKey:${userId}`));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function keyHint(key) {
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

export async function setAnthropicKey(userId, key) {
  await users().updateOne(
    { _id: userId },
    { $set: { anthropicKey: { ...encrypt(key, userId), hint: keyHint(key), updatedAt: new Date() } } },
    // Sessions from before the database existed have no user document yet.
    { upsert: true },
  );
}

export async function clearAnthropicKey(userId) {
  await users().updateOne({ _id: userId }, { $unset: { anthropicKey: "" } });
}

/** The masked key for display, or null. Never decrypts. */
export async function getAnthropicKeyHint(userId) {
  const user = await users().findOne({ _id: userId }, { projection: { "anthropicKey.hint": 1 } });
  return user?.anthropicKey?.hint ?? null;
}

/** The plaintext key for handing to a Claude command, or null. */
export async function getAnthropicKey(userId) {
  const user = await users().findOne({ _id: userId }, { projection: { anthropicKey: 1 } });
  if (!user?.anthropicKey) return null;
  try {
    return decrypt(user.anthropicKey, userId);
  } catch {
    // Wrong DATA_ENCRYPTION_KEY or a tampered document: treat as no key.
    console.error(`Stored Anthropic key for user ${userId} could not be decrypted.`);
    return null;
  }
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
