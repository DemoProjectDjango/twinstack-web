import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import { DEFAULT_ASSISTANT_MODEL, DEFAULT_MODEL, isClaudeModel } from "./claude-models.js";
import { PROVIDERS, providerOf } from "./ai-providers.js";
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
//   creditPurchases  one document per purchase of Claude credits: the buyer as they
//               were then, the amounts, and what Stripe said about the payment
//               (card, fee, refunds); admins list them all on /admin/purchases
//   appSettings one document per app-wide setting an admin changes (_id = the
//               setting's name), e.g. "fastModel": which cheaper model runs
//   analyticsEvents  one document per page view or outside-link click on a
//               published site (siteId = GitHub repo id), kept for a year
//   analyticsSalts   the day's random salt for counting visitors (_id = the
//               UTC date), deleted after two days so visitors can't be traced
//   providerErrors   one document per refusal from Anthropic, OpenAI or
//               DeepSeek on the app's keys (out of balance, rate limited, key
//               refused…), kept 30 days (provider-health.js)
//   providerCosts    one document per provider and UTC day: the provider's own
//               cost report next to what the app recorded (_id = provider:day)
//
// An account's Claude credits are users.credits ({ balance, granted, purchased,
// used }), changed only in single atomic updates ($inc, or a pipeline that stops a
// refund at zero) so concurrent requests can't lose an update. purchaseIds there
// lists the recent paid purchases already credited. users.stripeCustomers holds
// the account's Stripe customer ids ({ live, test }).
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
    creditPurchases().createIndex({ createdAt: -1 }),
    creditPurchases().createIndex({ stripeSessionId: 1 }, { unique: true, partialFilterExpression: { stripeSessionId: { $type: "string" } } }),
    creditPurchases().createIndex({ paymentIntentId: 1 }, { partialFilterExpression: { paymentIntentId: { $type: "string" } } }),
    siteCopies().createIndex({ "analytics.key": 1 }, { unique: true, partialFilterExpression: { "analytics.key": { $type: "string" } } }),
    analyticsEvents().createIndex({ siteId: 1, at: -1 }),
    analyticsEvents().createIndex({ at: 1 }, { expireAfterSeconds: ANALYTICS_RETENTION_DAYS * 24 * 60 * 60 }),
    analyticsSalts().createIndex({ createdAt: 1 }, { expireAfterSeconds: 2 * 24 * 60 * 60 }),
    providerErrors().createIndex({ at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }),
    claudeUsage().createIndex({ charged: 1, createdAt: -1 }),
  ]);
  // Accounts from before credits get the free allowance once.
  await users().updateMany({ credits: { $exists: false } }, { $set: { credits: startingCredits() } });
  // Accounts that made a site before access requests existed keep their access.
  const owners = (await siteCopies().distinct("userId")).map(objectId).filter(Boolean);
  if (owners.length) {
    await users().updateMany(
      { _id: { $in: owners }, access: { $exists: false } },
      { $set: { access: { status: "approved", decidedAt: new Date(), decidedBy: "had a site already" } } },
    );
  }
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
const appSettings = () => db.collection("appSettings");
const analyticsEvents = () => db.collection("analyticsEvents");
const analyticsSalts = () => db.collection("analyticsSalts");

/** How long a site's visits are kept (the TTL index on analyticsEvents.at). */
export const ANALYTICS_RETENTION_DAYS = 365;

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

export const isAdminEmail = (email) => typeof email === "string" && config.adminEmails.includes(email.toLowerCase());

/**
 * Whether the account may create sites from the template: "none" (never asked), "pending",
 * "approved" or "denied". Admins are always approved.
 */
function accessOf(doc) {
  if (isAdminEmail(doc.email)) return { status: "approved", requestedAt: null };
  return { status: doc.access?.status ?? "none", requestedAt: doc.access?.requestedAt ?? null };
}

/** What the rest of the app (and the browser, via /api/me) sees of an account. */
export function publicUser(doc) {
  return {
    id: doc._id.toHexString(),
    email: doc.email,
    name: doc.name,
    admin: isAdminEmail(doc.email),
    access: accessOf(doc),
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

/* ----------------------------------------------------------------- access */

// Creating sites needs the owner's approval (users.access): the account asks once, an admin
// approves or denies it on /admin/access.

const ACCESS_STATUSES = ["approved", "denied"];

/** Marks the account's request as pending. Returns false when it's already pending, approved or denied. */
export async function requestAccess(id, message) {
  const { modifiedCount } = await users().updateOne(
    { _id: objectId(id), "access.status": { $nin: ["pending", ...ACCESS_STATUSES] } },
    { $set: { access: { status: "pending", requestedAt: new Date(), message } } },
  );
  return modifiedCount === 1;
}

/** Every account that asked for access or was given it, pending first, then newest first. */
export async function listAccessRequests() {
  const docs = await users()
    .find(
      { access: { $exists: true } },
      { projection: { email: 1, name: 1, createdAt: 1, "github.login": 1, access: 1 } },
    )
    .toArray();
  const order = { pending: 0, approved: 1, denied: 2 };
  const time = (doc) => (doc.access.requestedAt ?? doc.access.decidedAt ?? doc.createdAt ?? new Date(0)).getTime();
  return docs
    .sort((a, b) => (order[a.access.status] ?? 3) - (order[b.access.status] ?? 3) || time(b) - time(a))
    .map((doc) => ({
      id: doc._id.toHexString(),
      email: doc.email,
      name: doc.name,
      githubLogin: doc.github?.login ?? null,
      status: doc.access.status,
      message: doc.access.message ?? "",
      requestedAt: doc.access.requestedAt ?? null,
      decidedAt: doc.access.decidedAt ?? null,
    }));
}

/** Approves or denies an account. Returns its document, or null when there's no such account. */
export async function setAccessStatus(id, status, decidedBy) {
  if (!ACCESS_STATUSES.includes(status)) throw new Error(`Unknown access status: ${status}`);
  const _id = objectId(id);
  if (!_id) return null;
  return users().findOneAndUpdate(
    { _id },
    { $set: { "access.status": status, "access.decidedAt": new Date(), "access.decidedBy": decidedBy } },
    { returnDocument: "after" },
  );
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

// A site's own choice of AI model, shared by everyone who manages it: `fastModel` (fast-model.js)
// and `imageModel` (image-model.js), each `{ model, updatedAt, updatedBy }` on its siteCopies record.
// `siteId` is the GitHub repo id (siteIdFor); sites recorded by name only have no choices.
const SITE_MODEL_FIELDS = ["fastModel", "imageModel"];

/** The site's model choices: `{ fastModel, imageModel }`, each a model id, "off" or null (follow the admin's). */
export async function getSiteModels(siteId) {
  const none = { fastModel: null, imageModel: null };
  if (typeof siteId !== "number") return none;
  const doc = await siteCopies().findOne({ _id: siteId }, { projection: { fastModel: 1, imageModel: 1 } });
  return Object.fromEntries(SITE_MODEL_FIELDS.map((field) => [field, typeof doc?.[field]?.model === "string" ? doc[field].model : null]));
}

/** Saves one of the site's model choices (null goes back to the admin's). False when the site isn't a recorded copy. */
export async function setSiteModel(siteId, field, model, userId) {
  if (typeof siteId !== "number" || !SITE_MODEL_FIELDS.includes(field)) return false;
  const update = model ? { $set: { [field]: { model, updatedAt: new Date(), updatedBy: userId } } } : { $unset: { [field]: "" } };
  const result = await siteCopies().updateOne({ _id: siteId }, update);
  return result.matchedCount > 0;
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
  const { purchaseIds: _ids, ...credits } = doc?.credits ?? {};
  return { ...startingCredits(), ...credits };
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

// A purchase's status: "pending" (sent to Stripe Checkout), then "paid", "failed" or "expired";
// once paid, Stripe may refund it ("refunded", "part-refunded") or the bank may reverse it
// ("disputed"). Demo purchases (development only) are "paid" at once and nothing is charged.

// How many recent purchase ids an account keeps (users.credits.purchaseIds), so a purchase whose
// crediting was interrupted is never credited twice when it's tried again.
const RECENT_PURCHASES = 100;

/** What the browser sees of a purchase. */
function purchaseView({ _id, credits, priceCents, currency, provider, status, createdAt, paidAt, receiptUrl, refundedCredits }) {
  return { id: _id.toHexString(), credits, priceCents, currency, provider, status, createdAt, paidAt, receiptUrl, refundedCredits };
}

/**
 * A new purchase: a demo one is paid and credited at once, a Stripe one waits for its payment.
 * `buyer` ({ email, name }) is kept as it was then, for the admin's list, should the account change.
 * `livemode` is false for demo purchases and Stripe test keys.
 */
export async function createPurchase({ userId, buyer, credits, priceCents, currency, provider, livemode = false }) {
  const now = new Date();
  const demo = provider === "demo";
  const doc = {
    userId,
    buyer: { email: buyer.email ?? null, name: buyer.name ?? null },
    credits,
    priceCents,
    currency,
    provider,
    livemode,
    status: demo ? "paid" : "pending",
    createdAt: now,
    ...(demo && { paidAt: now }),
  };
  // insertOne adds _id to the document it's given.
  await creditPurchases().insertOne(doc);
  if (demo) await users().updateOne({ _id: objectId(userId) }, { $inc: { "credits.balance": credits, "credits.purchased": credits } });
  return purchaseView(doc);
}

export async function setPurchaseCheckout(id, stripeSessionId) {
  await creditPurchases().updateOne({ _id: objectId(id) }, { $set: { stripeSessionId } });
}

/** The purchase made with that Checkout Session: `userId`'s only, when given. */
export async function findPurchaseBySession(stripeSessionId, userId = null) {
  const doc = await creditPurchases().findOne({ stripeSessionId, ...(userId && { userId }) });
  return doc && { ...purchaseView(doc), userId: doc.userId };
}

/**
 * Stripe says the purchase is paid: marks it so (once) and adds its credits to the account (once,
 * however often this runs, so a repeated webhook or a retry after a crash is harmless). `payment` is
 * what Stripe says about it: paymentIntentId, customerId, amountPaidCents, feeCents, receiptUrl and
 * card ({ brand, last4, country }).
 */
export async function payPurchase(id, payment) {
  const _id = objectId(id);
  await creditPurchases().updateOne(
    { _id, status: "pending" },
    { $set: { status: "paid", paidAt: new Date(), credited: false, refundedCredits: 0, ...payment } },
  );
  const purchase = await creditPurchases().findOne({ _id, credited: false });
  if (!purchase) return;
  await users().updateOne(
    { _id: objectId(purchase.userId), "credits.purchaseIds": { $ne: _id } },
    {
      $inc: { "credits.balance": purchase.credits, "credits.purchased": purchase.credits },
      $push: { "credits.purchaseIds": { $each: [_id], $slice: -RECENT_PURCHASES } },
    },
  );
  await creditPurchases().updateOne({ _id }, { $set: { credited: true } });
}

/** A pending purchase that will never be paid: "failed" or "expired". */
export async function endPurchase(id, status) {
  await creditPurchases().updateOne({ _id: objectId(id), status: "pending" }, { $set: { status, endedAt: new Date() } });
}

/**
 * Takes back the credits of a refunded or disputed payment: `share` of them (0-1, what's been
 * refunded so far), less what was already taken back. The balance stops at zero: credits already
 * used aren't owed. `amounts` records the money involved (`refundedCents` so far, or `disputedCents`).
 */
export async function takeBackPurchase(paymentIntentId, { share, status, amounts = {} }) {
  const purchase = await creditPurchases().findOne({ paymentIntentId, credited: true });
  if (!purchase) return;
  const before = purchase.refundedCredits ?? 0;
  const target = Math.min(purchase.credits, Math.round(purchase.credits * share));
  const take = target - before;
  // Nothing more to take (a repeated event, or a dispute after a full refund): left as it is.
  if (take <= 0) return;
  // Matched on the amount read above, so two events at once can't both take the same credits.
  const { modifiedCount } = await creditPurchases().updateOne(
    { _id: purchase._id, refundedCredits: before },
    { $set: { status, refundedCredits: target, ...amounts, updatedAt: new Date() } },
  );
  if (!modifiedCount) return;
  await users().updateOne({ _id: objectId(purchase.userId) }, [
    {
      $set: {
        "credits.balance": { $max: [0, { $subtract: ["$credits.balance", take] }] },
        "credits.purchased": { $subtract: ["$credits.purchased", take] },
      },
    },
  ]);
}

/** The account's Stripe customer in that mode ("live" or "test", whose customers are separate). */
export async function getStripeCustomerId(userId, mode) {
  const doc = await users().findOne({ _id: objectId(userId) }, { projection: { stripeCustomers: 1 } });
  return doc?.stripeCustomers?.[mode] ?? null;
}

export async function setStripeCustomerId(userId, mode, customerId) {
  await users().updateOne({ _id: objectId(userId) }, { $set: { [`stripeCustomers.${mode}`]: customerId } });
}

const historyPage = (collection, userId, { before, limit }) =>
  collection
    .find({ userId, ...(before && { createdAt: { $lt: before } }) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

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

/** The account's Claude, DeepSeek and OpenAI use, a run per entry, newest first. */
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
        // The same rule as providerOf.
        _id: {
          $switch: {
            branches: [
              { case: { $regexMatch: { input: { $ifNull: ["$model", ""] }, regex: "^deepseek-" } }, then: "deepseek" },
              { case: { $regexMatch: { input: { $ifNull: ["$model", ""] }, regex: "^(gpt-|o[0-9])" } }, then: "openai" },
            ],
            default: "claude",
          },
        },
        requests: { $sum: 1 },
        credits: { $sum: { $cond: [{ $eq: ["$charged", true] }, { $ifNull: ["$credits", 0] }, 0] } },
        ...Object.fromEntries(TOKEN_FIELDS.map((f) => [f, sum(f)])),
      },
    },
  ];
}

/**
 * The account's use split by provider (`providers.claude`, `.deepseek`, `.openai`) and merged
 * (`credits`: everything charged, from the one balance they're all paid from).
 */
export async function usageByProvider(userId) {
  const rows = await claudeUsage().aggregate(usageByProviderPipeline(userId)).toArray();
  return usageTotals(rows);
}

export function usageTotals(rows) {
  const empty = () => ({ requests: 0, credits: 0, ...Object.fromEntries(TOKEN_FIELDS.map((f) => [f, 0])) });
  const providers = Object.fromEntries(PROVIDERS.map((p) => [p, empty()]));
  for (const { _id, ...totals } of rows) Object.assign(providers[_id], totals);
  return { credits: PROVIDERS.reduce((sum, p) => sum + providers[p].credits, 0), providers };
}

/** The account's credit purchases, newest first. */
export async function listCreditPurchases(userId, page) {
  return (await historyPage(creditPurchases(), userId, page)).map(purchaseView);
}

export const PURCHASE_STATUSES = ["pending", "paid", "failed", "expired", "refunded", "part-refunded", "disputed"];

/** A purchase as the admin sees it: everything stored, with the account as it is now. */
function adminPurchaseView(doc) {
  const { _id, userId, account, credited: _c, ...rest } = doc;
  return {
    id: _id.toHexString(),
    ...rest,
    account: account ? { id: userId, email: account.email ?? null, name: account.name ?? null } : { id: userId, deleted: true },
  };
}

/**
 * Every account's purchases for the admin, newest first, a page at a time (`before`, `limit`).
 * `status`, `provider` ("stripe", "demo") and `mode` ("live", "test") narrow it; `q` finds a buyer
 * by email or name (then or now) or a payment by its Stripe id.
 */
export async function listAllPurchases({ before = null, since = null, limit = 50, status = null, provider = null, mode = null, q = "" }) {
  const match = {
    ...((before || since) && { createdAt: { ...(before && { $lt: before }), ...(since && { $gte: since }) } }),
    ...(status && { status }),
    ...(provider && { provider }),
    ...(mode && { livemode: mode === "live" }),
  };
  const text = q.trim();
  const pattern = text && { $regex: text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  const docs = await creditPurchases()
    .aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: "users",
          let: { id: { $convert: { input: "$userId", to: "objectId", onError: null, onNull: null } } },
          pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$id"] } } }, { $project: { email: 1, name: 1 } }],
          as: "account",
        },
      },
      { $set: { account: { $first: "$account" } } },
      ...(text
        ? [
            {
              $match: {
                $or: [
                  { "buyer.email": pattern },
                  { "buyer.name": pattern },
                  { "account.email": pattern },
                  { "account.name": pattern },
                  { stripeSessionId: text },
                  { paymentIntentId: text },
                ],
              },
            },
          ]
        : []),
      { $limit: limit },
    ])
    .toArray();
  return docs.map(adminPurchaseView);
}

const PAID_STATUSES = ["paid", "refunded", "part-refunded", "disputed"];

/**
 * Money taken through Stripe, all time and in the last 30 days, live and test apart: purchases,
 * amount paid, Stripe's fees, refunded and disputed amounts, and credits sold and taken back.
 */
export async function purchaseTotals() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sums = {
    purchases: { $sum: 1 },
    paidCents: { $sum: { $ifNull: ["$amountPaidCents", 0] } },
    feeCents: { $sum: { $ifNull: ["$feeCents", 0] } },
    refundedCents: { $sum: { $ifNull: ["$refundedCents", 0] } },
    disputedCents: { $sum: { $ifNull: ["$disputedCents", 0] } },
    credits: { $sum: "$credits" },
    creditsTakenBack: { $sum: { $ifNull: ["$refundedCredits", 0] } },
  };
  const [row] = await creditPurchases()
    .aggregate([
      { $match: { provider: "stripe", status: { $in: PAID_STATUSES } } },
      {
        $facet: {
          allTime: [{ $group: { _id: { $eq: ["$livemode", true] }, ...sums } }],
          last30Days: [{ $match: { paidAt: { $gte: since } } }, { $group: { _id: { $eq: ["$livemode", true] }, ...sums } }],
        },
      },
    ])
    .toArray();
  const empty = Object.fromEntries(Object.keys(sums).map((k) => [k, 0]));
  const byMode = (groups) => {
    const live = groups.find((g) => g._id === true);
    const test = groups.find((g) => g._id === false);
    const strip = (g) => (g ? (({ _id, ...t }) => t)(g) : { ...empty });
    return { live: strip(live), test: strip(test) };
  };
  const pending = await creditPurchases().countDocuments({ provider: "stripe", status: "pending" });
  return { currency: "usd", allTime: byMode(row.allTime), last30Days: byMode(row.last30Days), pending };
}

/* ------------------------------------------------------ provider health */

// What the app's own keys cost and how they're holding up (provider-health.js). Spend comes from
// claudeUsage (charged requests ran on the app's keys); providerErrors keeps the providers' refusals
// for 30 days; providerCosts keeps each day's check against a provider's own cost report.

const providerErrors = () => db.collection("providerErrors");
const providerCosts = () => db.collection("providerCosts");

/** Credits charged per provider since `since` (claudeUsage at the app's prices). */
export async function chargedByProvider(since) {
  const rows = await claudeUsage()
    .aggregate([
      { $match: { charged: true, createdAt: { $gte: since } } },
      { $group: { _id: "$model", credits: { $sum: { $ifNull: ["$credits", 0] } } } },
    ])
    .toArray();
  const totals = Object.fromEntries(PROVIDERS.map((p) => [p, 0]));
  for (const row of rows) totals[providerOf(row._id)] += row.credits;
  return totals;
}

/** Credits charged per provider per UTC day (`YYYY-MM-DD`) since `since`. */
export async function chargedByProviderPerDay(since) {
  const rows = await claudeUsage()
    .aggregate([
      { $match: { charged: true, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } }, model: "$model" },
          credits: { $sum: { $ifNull: ["$credits", 0] } },
        },
      },
    ])
    .toArray();
  const days = {};
  for (const { _id, credits } of rows) {
    days[_id.day] ??= Object.fromEntries(PROVIDERS.map((p) => [p, 0]));
    days[_id.day][providerOf(_id.model)] += credits;
  }
  return days;
}

/** The credits every account still has to spend: what they could still use on the app's keys. */
export async function outstandingCredits() {
  const [row] = await users()
    .aggregate([
      { $match: { "credits.balance": { $gt: 0 } } },
      { $group: { _id: null, credits: { $sum: "$credits.balance" }, accounts: { $sum: 1 } } },
    ])
    .toArray();
  return { credits: row?.credits ?? 0, accounts: row?.accounts ?? 0 };
}

/**
 * The admin's activity report for `start`-`end` (instants, end excluded), days counted in `zone`:
 * credits bought (by when they were paid), free credits given to new accounts, and credits used
 * per provider. `days` has one row per local day with any of it; `users` the `userLimit` accounts
 * that used or bought the most, each with its balance now.
 */
export async function creditActivity({ start, end, zone, userLimit = 100 }) {
  const range = { $gte: start, $lt: end };
  const day = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: zone } });
  const [usageRows, purchaseRows, signupRows] = await Promise.all([
    claudeUsage()
      .aggregate([
        { $match: { charged: true, createdAt: range } },
        {
          $group: {
            _id: { userId: "$userId", model: "$model", day: day("$createdAt") },
            credits: { $sum: { $ifNull: ["$credits", 0] } },
            requests: { $sum: 1 },
          },
        },
      ])
      .toArray(),
    creditPurchases()
      .aggregate([
        { $match: { status: { $in: PAID_STATUSES }, paidAt: range } },
        {
          $group: {
            _id: { userId: "$userId", provider: "$provider", day: day("$paidAt") },
            purchases: { $sum: 1 },
            credits: { $sum: "$credits" },
            paidCents: { $sum: { $ifNull: ["$amountPaidCents", 0] } },
            refundedCents: { $sum: { $add: [{ $ifNull: ["$refundedCents", 0] }, { $ifNull: ["$disputedCents", 0] }] } },
            creditsTakenBack: { $sum: { $ifNull: ["$refundedCredits", 0] } },
          },
        },
      ])
      .toArray(),
    users()
      .aggregate([
        { $match: { createdAt: range } },
        { $group: { _id: day("$createdAt"), accounts: { $sum: 1 }, credits: { $sum: { $ifNull: ["$credits.granted", 0] } } } },
      ])
      .toArray(),
  ]);

  const usageZero = () => Object.fromEntries(PROVIDERS.map((p) => [p, { credits: 0, requests: 0 }]));
  const totals = {
    purchases: { count: 0, credits: 0, paidCents: 0, refundedCents: 0, creditsTakenBack: 0, demoCount: 0, demoCredits: 0 },
    free: { accounts: 0, credits: 0 },
    usage: usageZero(),
  };
  const days = new Map();
  const dayRow = (d) => {
    if (!days.has(d)) days.set(d, { day: d, boughtCredits: 0, paidCents: 0, purchases: 0, freeCredits: 0, newAccounts: 0, used: usageZero() });
    return days.get(d);
  };
  const people = new Map();
  const person = (id) => {
    if (!people.has(id)) people.set(id, { userId: id, boughtCredits: 0, paidCents: 0, purchases: 0, used: usageZero() });
    return people.get(id);
  };

  for (const { _id, credits, requests } of usageRows) {
    const provider = providerOf(_id.model);
    for (const usage of [totals.usage, dayRow(_id.day).used, person(_id.userId).used]) {
      usage[provider].credits += credits;
      usage[provider].requests += requests;
    }
  }
  for (const { _id, purchases, credits, paidCents, refundedCents, creditsTakenBack } of purchaseRows) {
    const p = totals.purchases;
    if (_id.provider === "demo") {
      p.demoCount += purchases;
      p.demoCredits += credits;
    } else {
      p.count += purchases;
      p.credits += credits;
      p.paidCents += paidCents;
      p.refundedCents += refundedCents;
      p.creditsTakenBack += creditsTakenBack;
    }
    const d = dayRow(_id.day);
    const who = person(_id.userId);
    for (const row of [d, who]) {
      row.boughtCredits += credits;
      row.paidCents += paidCents;
      row.purchases += purchases;
    }
  }
  for (const { _id, accounts, credits } of signupRows) {
    totals.free.accounts += accounts;
    totals.free.credits += credits;
    const d = dayRow(_id);
    d.newAccounts += accounts;
    d.freeCredits += credits;
  }

  const usedOf = (row) => PROVIDERS.reduce((sum, p) => sum + row.used[p].credits, 0);
  const ranked = [...people.values()].sort((a, b) => usedOf(b) - usedOf(a) || b.boughtCredits - a.boughtCredits);
  const shown = ranked.slice(0, userLimit);
  const accounts = await users()
    .find({ _id: { $in: shown.map((r) => objectId(r.userId)).filter(Boolean) } }, { projection: { email: 1, name: 1, "credits.balance": 1 } })
    .toArray();
  const byId = new Map(accounts.map((a) => [a._id.toHexString(), a]));

  return {
    totals: { ...totals, usedCredits: usedOf({ used: totals.usage }) },
    days: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
    users: shown.map((r) => {
      const account = byId.get(r.userId);
      return {
        ...r,
        usedCredits: usedOf(r),
        email: account?.email ?? null,
        name: account?.name ?? null,
        deleted: !account,
        balance: account ? (account.credits?.balance ?? 0) : null,
      };
    }),
    userCount: ranked.length,
  };
}

export async function recordProviderError({ provider, kind, status, message }) {
  await providerErrors().insertOne({ provider, kind, status, message: String(message ?? "").slice(0, 500), at: new Date() });
}

/** Per provider: how many errors of each kind since `since`, and the latest one. */
export async function providerErrorSummary(since) {
  const rows = await providerErrors()
    .aggregate([
      { $match: { at: { $gte: since } } },
      { $sort: { at: -1 } },
      { $group: { _id: { provider: "$provider", kind: "$kind" }, count: { $sum: 1 }, latest: { $first: "$$ROOT" } } },
    ])
    .toArray();
  const summary = {};
  for (const { _id, count, latest } of rows) {
    const entry = (summary[_id.provider] ??= { counts: {}, latest: null });
    entry.counts[_id.kind] = count;
    if (!entry.latest || latest.at > entry.latest.at) entry.latest = { kind: latest.kind, status: latest.status, message: latest.message, at: latest.at };
  }
  return summary;
}

/** One day's check of a provider's cost report against what the app recorded. */
export async function saveProviderCost(provider, day, check) {
  await providerCosts().updateOne({ _id: `${provider}:${day}` }, { $set: { provider, day, ...check, checkedAt: new Date() } }, { upsert: true });
}

/** The cost checks since `sinceDay` (`YYYY-MM-DD`), newest first. */
export async function listProviderCosts(sinceDay) {
  const docs = await providerCosts().find({ day: { $gte: sinceDay } }).sort({ day: -1 }).toArray();
  return docs.map(({ _id, ...rest }) => rest);
}

/* ------------------------------------------------------------ app settings */

/** An app-wide setting's document (`{ _id, value, updatedAt, updatedBy }`), or null when never set. */
export function getAppSetting(name) {
  return appSettings().findOne({ _id: name });
}

/** Saves an app-wide setting, recording which admin changed it. */
export async function setAppSetting(name, value, updatedBy) {
  await appSettings().updateOne({ _id: name }, { $set: { value, updatedAt: new Date(), updatedBy } }, { upsert: true });
}

/* -------------------------------------------------------------- analytics */

// A site's visit counting (analytics.js). Its settings are siteCopies.analytics:
// { key, enabled, hosts, updatedAt }. `key` is the random id the site's pages send
// their visits with; `hosts` are the addresses it's published at, the only ones
// whose visits count. Only the copy's creator (siteCopies.userId) sees any of it.

/** The site's creator and analytics settings, or null when it isn't a recorded copy. */
export async function findSiteAnalytics(siteId) {
  if (typeof siteId !== "number") return null;
  const doc = await siteCopies().findOne({ _id: siteId }, { projection: { userId: 1, fullName: 1, analytics: 1 } });
  return doc ? { userId: doc.userId ?? null, fullName: doc.fullName, analytics: doc.analytics ?? null } : null;
}

/** Changes the site's analytics settings (fields of siteCopies.analytics). */
export async function updateSiteAnalytics(siteId, fields) {
  const set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`analytics.${k}`, v]));
  await siteCopies().updateOne({ _id: siteId }, { $set: { ...set, "analytics.updatedAt": new Date() } });
}

/** The site a visit's key belongs to: `{ siteId, enabled, hosts }`, or null. */
export async function findSiteByAnalyticsKey(key) {
  const doc = await siteCopies().findOne({ "analytics.key": key }, { projection: { analytics: 1 } });
  return doc ? { siteId: doc._id, enabled: doc.analytics.enabled === true, hosts: doc.analytics.hosts ?? [] } : null;
}

export async function insertAnalyticsEvents(events) {
  if (events.length) await analyticsEvents().insertMany(events, { ordered: false });
}

/** Runs an aggregation over one site's events from `from` (inclusive) to `to` (exclusive). */
export function aggregateAnalytics(siteId, from, to, pipeline) {
  return analyticsEvents()
    .aggregate([{ $match: { siteId, at: { $gte: from, $lt: to } } }, ...pipeline], { allowDiskUse: true })
    .toArray();
}

export async function hasAnalyticsEvents(siteId) {
  return Boolean(await analyticsEvents().findOne({ siteId }, { projection: { _id: 1 } }));
}

export async function deleteAnalyticsEvents(siteId) {
  const result = await analyticsEvents().deleteMany({ siteId });
  return result.deletedCount;
}

/** Today's salt (UTC), made by whichever request needs it first. */
export async function analyticsSaltFor(day) {
  await analyticsSalts().updateOne(
    { _id: day },
    { $setOnInsert: { salt: randomBytes(32).toString("hex"), createdAt: new Date() } },
    { upsert: true },
  ).catch((err) => {
    // Two first requests at once: the other one made it.
    if (err?.code !== 11000) throw err;
  });
  return (await analyticsSalts().findOne({ _id: day })).salt;
}
