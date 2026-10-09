import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import { DEFAULT_ASSISTANT_MODEL, DEFAULT_MODEL, isClaudeModel } from "./claude-models.js";
import { config } from "./config.js";

// MongoDB holds everything that outlives a browser session:
//   users       one document per account (_id = ObjectId): email, password
//               hash, sign-in history, the connected GitHub account (profile +
//               encrypted token) and the encrypted Anthropic API key
//   siteCopies  one document per repo duplicated from the site template
//               (_id = GitHub repo id, which survives renames)
//   workLog     one document per line of a site's Claude work log
//               (siteId = GitHub repo id)
//   workLogForgotten  lines the user removed from a site's work log
//   assistantConversations  the "Ask Claude" chats: one active conversation per
//               user and site (siteId = GitHub repo id), with the exact Claude
//               message history, what the chat shows and the proposed changes
//   claudeUsage one document per Claude request made for a user (tokens in and
//               out, and the credits it cost), the account's usage history
//   creditPurchases  one document per purchase of Claude credits
//
// An account's Claude credits are users.credits ({ balance, granted, purchased,
// used }), changed only with $inc so concurrent requests can't lose an update.
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
    workLog().createIndex({ siteId: 1, createdAt: -1 }),
    workLogForgotten().createIndex({ siteId: 1, line: 1 }, { unique: true }),
    conversations().createIndex({ userId: 1, siteId: 1, archived: 1, updatedAt: -1 }),
    claudeUsage().createIndex({ userId: 1, createdAt: -1 }),
    creditPurchases().createIndex({ userId: 1, createdAt: -1 }),
  ]);
  // Accounts from before credits get the free allowance once.
  await users().updateMany({ credits: { $exists: false } }, { $set: { credits: startingCredits() } });
}

export async function closeDb() {
  await client?.close();
}

const users = () => db.collection("users");
const siteCopies = () => db.collection("siteCopies");
const workLog = () => db.collection("workLog");
const workLogForgotten = () => db.collection("workLogForgotten");
const conversations = () => db.collection("assistantConversations");
const claudeUsage = () => db.collection("claudeUsage");
const creditPurchases = () => db.collection("creditPurchases");

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
  const doc = { email, name, passwordHash, createdAt: now, lastLoginAt: now, loginCount: 1, credits: startingCredits() };
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

/** The account whose connected GitHub login is this one (any case), or null. */
export function findUserByGithubLogin(login) {
  return users().findOne({ "github.login": login }, { collation: { locale: "en", strength: 2 } });
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

/* ------------------------------------------------------------ claude model */

export async function setClaudeModel(id, model) {
  await users().updateOne({ _id: objectId(id) }, { $set: { claudeModel: model } });
}

/** The account's chosen Claude model, or the default when it hasn't chosen one (or chose one no longer offered). */
export async function getClaudeModel(id) {
  const doc = await users().findOne({ _id: objectId(id) }, { projection: { claudeModel: 1 } });
  return isClaudeModel(doc?.claudeModel) ? doc.claudeModel : DEFAULT_MODEL;
}

export async function setAssistantModel(id, model) {
  await users().updateOne({ _id: objectId(id) }, { $set: { assistantModel: model } });
}

/** The model the "Ask Claude" assistant answers with: the account's choice, or DEFAULT_ASSISTANT_MODEL. */
export async function getAssistantModel(id) {
  const doc = await users().findOne({ _id: objectId(id) }, { projection: { assistantModel: 1 } });
  return isClaudeModel(doc?.assistantModel) ? doc.assistantModel : DEFAULT_ASSISTANT_MODEL;
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

/* --------------------------------------------------------------- work log */

// Each site's Claude work log (the lines its scripts write to
// knowledge/work-log.md), kept here as well so the next Claude run sees a
// change as soon as it's made, not once its pull request has merged.
// siteId is the GitHub repo id, shared by everyone who manages the site.
//
// Lines the user removes from the memory are recorded in workLogForgotten, so
// a copy still in some branch's committed log can't bring them back.

/** Saves new log lines, oldest first. A line written again is no longer forgotten. */
export async function addWorkLogLines(siteId, lines) {
  if (!lines.length) return;
  const now = Date.now();
  // Distinct timestamps keep lines written in one go in their order.
  await workLog().insertMany(lines.map((line, i) => ({ siteId, line, createdAt: new Date(now + i) })));
  await workLogForgotten().deleteMany({ siteId, line: { $in: lines } });
}

/** Removes these lines from the memory: stored copies are deleted, and committed copies are ignored from now on. */
export async function forgetWorkLogLines(siteId, lines) {
  if (!lines.length) return;
  await workLog().deleteMany({ siteId, line: { $in: lines } });
  await Promise.all(
    lines.map((line) => workLogForgotten().updateOne({ siteId, line }, { $set: { siteId, line, forgottenAt: new Date() } }, { upsert: true })),
  );
}

/** Removes every stored line of the site (the caller forgets the committed ones it can see). */
export async function clearWorkLog(siteId) {
  await workLog().deleteMany({ siteId });
}

/** Rewrites a line in place: it keeps its position, and the old wording is forgotten. */
export async function replaceWorkLogLine(siteId, line, replacement) {
  await workLog().updateMany({ siteId, line }, { $set: { line: replacement } });
  await workLogForgotten().updateOne({ siteId, line }, { $set: { siteId, line, forgottenAt: new Date() } }, { upsert: true });
  await workLogForgotten().deleteMany({ siteId, line: { $in: [replacement] } });
}

/** The lines removed from this site's memory. */
export async function forgottenWorkLogLines(siteId) {
  const docs = await workLogForgotten().find({ siteId }, { projection: { line: 1 } }).toArray();
  return new Set(docs.map((doc) => doc.line));
}

/** The newest `limit` lines, oldest first. */
export async function recentWorkLogLines(siteId, limit) {
  const docs = await workLog()
    .find({ siteId }, { projection: { line: 1 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  return docs.map((doc) => doc.line).reverse();
}

/* ------------------------------------------------------- the assistant */

// One active conversation per user and site; starting a new one archives the old. `messages` is
// the exact history sent to Claude and is only ever appended to (thinking blocks are bound to it).
// Updates are targeted ($push / $set on one action) so a turn finishing and a change being
// applied at the same moment can't overwrite each other.

function conversationView(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id.toHexString(), ...rest };
}

export async function findConversation(userId, siteId) {
  const doc = await conversations().findOne({ userId, siteId, archived: false }, { sort: { updatedAt: -1 } });
  return conversationView(doc);
}

export async function createConversation({ userId, siteId, toolset }) {
  const now = new Date();
  const doc = {
    userId,
    siteId,
    // The assistant's tool list it was started with (a conversation stays bound to it).
    toolset,
    archived: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
    display: [],
    actions: {},
    // Ids of the files attached to it, removed with it.
    attachments: [],
    knowledge: { notes: "", sent: [] },
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
  const { insertedId } = await conversations().insertOne(doc);
  return conversationView({ _id: insertedId, ...doc });
}

/** Applies a MongoDB update to the user's conversation; returns the updated conversation, or null. */
export async function updateConversation(id, userId, update) {
  const _id = objectId(id);
  if (!_id) return null;
  const doc = await conversations().findOneAndUpdate(
    { _id, userId },
    { ...update, $set: { ...(update.$set ?? {}), updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  return conversationView(doc);
}

export async function archiveConversations(userId, siteId) {
  await conversations().updateMany({ userId, siteId, archived: false }, { $set: { archived: true, archivedAt: new Date() } });
}

/* ---------------------------------------------------------------- credits */

/** Every account starts with this many credits (credits.js prices them). */
export const FREE_CREDITS = 10_000;

function startingCredits() {
  return { balance: FREE_CREDITS, granted: FREE_CREDITS, purchased: 0, used: 0 };
}

/** `{ balance, granted, purchased, used }` for the account. */
export async function getCredits(id) {
  const doc = await users().findOne({ _id: objectId(id) }, { projection: { credits: 1 } });
  return { ...startingCredits(), ...doc?.credits };
}

/**
 * One Claude request made for a user: its tokens, and the credits it cost when `charged` (Claude ran
 * on the app's key). Charging may take the balance below zero: a request is only refused before it
 * starts. `usage` is the API's usage object.
 */
export async function recordClaudeUsage({ userId, siteId = null, runId = null, kind, command = null, model, usage, credits = 0, charged = false }) {
  if (charged && credits > 0) {
    await users().updateOne({ _id: objectId(userId) }, { $inc: { "credits.balance": -credits, "credits.used": credits } });
  }
  await claudeUsage().insertOne({
    userId,
    siteId,
    runId,
    kind,
    command,
    model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    webSearches: usage.server_tool_use?.web_search_requests ?? 0,
    credits,
    charged,
    createdAt: new Date(),
  });
}

/** A completed purchase: the credits are added at once. `provider` is "demo" until payments exist. */
export async function addPurchasedCredits({ userId, credits, priceCents, currency, provider }) {
  const now = new Date();
  const purchase = { credits, priceCents, currency, provider, status: "paid", createdAt: now, paidAt: now };
  // A copy: insertOne adds _id to the document it's given.
  const { insertedId } = await creditPurchases().insertOne({ userId, ...purchase });
  await users().updateOne({ _id: objectId(userId) }, { $inc: { "credits.balance": credits, "credits.purchased": credits } });
  return { id: insertedId.toHexString(), ...purchase };
}

const historyPage = (collection, userId, { before, limit }) =>
  collection
    .find({ userId, ...(before && { createdAt: { $lt: before } }) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

/** Which AI a model belongs to: "deepseek" for deepseek-* models, else "claude". */
export const providerOf = (model) => (typeof model === "string" && model.startsWith("deepseek-") ? "deepseek" : "claude");

const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "webSearches"];

/**
 * The aggregation behind listClaudeUsage: the account's requests grouped by run (`runId`: one job,
 * assistant answer or site update; a request recorded before runs were is a run of its own), each
 * run dated by its latest request, newest first, `limit` runs from before `before` (a Date).
 */
export function usageRunsPipeline(userId, { before = null, limit }) {
  return [
    { $match: { userId } },
    { $sort: { createdAt: 1, _id: 1 } },
    {
      $group: {
        _id: { $ifNull: ["$runId", { $toString: "$_id" }] },
        createdAt: { $max: "$createdAt" },
        startedAt: { $min: "$createdAt" },
        kind: { $first: "$kind" },
        command: { $first: "$command" },
        requests: { $push: { model: "$model", credits: "$credits", charged: "$charged", ...Object.fromEntries(TOKEN_FIELDS.map((f) => [f, `$${f}`])) } },
      },
    },
    ...(before ? [{ $match: { createdAt: { $lt: before } } }] : []),
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: limit },
  ];
}

/**
 * One run as the credits history shows it: its credits merged (`credits`, what the account was
 * charged) and split by model (`models`, each with its provider, requests, tokens and credits).
 */
export function usageRun({ _id, createdAt, startedAt, kind, command, requests }) {
  const models = new Map();
  for (const r of requests) {
    const name = r.model ?? "unknown";
    const entry = models.get(name) ?? { model: name, provider: providerOf(r.model), requests: 0, credits: 0, ...Object.fromEntries(TOKEN_FIELDS.map((f) => [f, 0])) };
    entry.requests += 1;
    if (r.charged === true) entry.credits += r.credits ?? 0;
    for (const f of TOKEN_FIELDS) entry[f] += r[f] ?? 0;
    models.set(name, entry);
  }
  const list = [...models.values()];
  return {
    id: String(_id),
    createdAt,
    startedAt,
    kind,
    command: command ?? null,
    // Charged when any request ran on the app's key; "own key" when every one ran on the account's.
    charged: requests.some((r) => r.charged === true),
    ownKey: requests.every((r) => r.charged === false),
    credits: list.reduce((sum, m) => sum + m.credits, 0),
    models: list,
  };
}

/** The account's Claude and DeepSeek use, a run per entry, newest first. */
export async function listClaudeUsage(userId, page) {
  const runs = await claudeUsage().aggregate(usageRunsPipeline(userId, page)).toArray();
  return runs.map(usageRun);
}

/** The aggregation behind usageByProvider: charged credits, requests and tokens per provider. */
export function usageByProviderPipeline(userId) {
  const sum = (field) => ({ $sum: { $ifNull: [`$${field}`, 0] } });
  return [
    { $match: { userId } },
    {
      $group: {
        _id: { $cond: [{ $regexMatch: { input: { $ifNull: ["$model", ""] }, regex: "^deepseek-" } }, "deepseek", "claude"] },
        requests: { $sum: 1 },
        credits: { $sum: { $cond: [{ $eq: ["$charged", true] }, { $ifNull: ["$credits", 0] }, 0] } },
        ...Object.fromEntries(TOKEN_FIELDS.map((f) => [f, sum(f)])),
      },
    },
  ];
}

/**
 * The account's use split by provider (`providers.claude`, `providers.deepseek`) and merged
 * (`credits`: everything charged, from the one balance both are paid from).
 */
export async function usageByProvider(userId) {
  const rows = await claudeUsage().aggregate(usageByProviderPipeline(userId)).toArray();
  return usageTotals(rows);
}

export function usageTotals(rows) {
  const empty = () => ({ requests: 0, credits: 0, ...Object.fromEntries(TOKEN_FIELDS.map((f) => [f, 0])) });
  const providers = { claude: empty(), deepseek: empty() };
  for (const { _id, ...totals } of rows) Object.assign(providers[_id], totals);
  return { credits: providers.claude.credits + providers.deepseek.credits, providers };
}

/** The account's credit purchases, newest first. */
export async function listCreditPurchases(userId, page) {
  const docs = await historyPage(creditPurchases(), userId, page);
  return docs.map(({ _id, userId: _u, ...rest }) => ({ id: _id.toHexString(), ...rest }));
}
