import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { anthropicClient } from "./assistant/turn.js";
import { ClaudeAccessError, anthropicUserId, beginSpend, claudeKeyFor } from "./credits.js";
import { acquire, workspaceDir } from "./workspace.js";
import { buildFillRequest, checkFill, mergeFill } from "./kit-fill-rules.js";

// Making a starter template the owner's own (plan: starter-kits-plan.md, "the kit-fill step"). A
// template's sample wording is written for its kind of organisation; after the template is applied,
// one small request rewrites the words the kit lists in kit.json → `fill` (headings, sentences, item
// titles and summaries) for what this owner said they do. Numbers, dates, amounts and names stay the
// sample's and the items stay marked `sample`, so Next steps and the publish prompt still ask the
// owner for the real ones: the AI never invents facts. It's an extra that can fail quietly: with no
// credits, a refusal or a bad reply the site keeps the template's own wording.

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 4000;
const TIMEOUT_MS = 40_000;

/**
 * Rewrites the template's sample wording in the site at `key` for `owner` (`{ name, what, brief }`).
 * Resolves to `{ filled: number, reason?: string }` (how many text values changed). Never throws.
 */
export async function fillKit({ key, userId, siteId = null, kit, owner }) {
  try {
    if (!kit?.fill || !userId || !(owner.what || owner.brief)) return { filled: 0, reason: "nothing to go on" };
    const dataDir = path.join(workspaceDir(key), "content", "data");
    const files = {};
    for (const file of Object.keys(kit.fill)) {
      try {
        files[file] = JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8"));
      } catch {
        // A file the site doesn't have (or can't read) is left out.
      }
    }
    const request = buildFillRequest(kit.fill, files);
    if (!request) return { filled: 0, reason: "no wording to change" };

    let claude;
    try {
      claude = await claudeKeyFor(userId);
    } catch (err) {
      if (err instanceof ClaudeAccessError) return { filled: 0, reason: err.code ?? "no AI access" };
      throw err;
    }
    const spend = await beginSpend({ userId, siteId, runId: randomUUID(), kind: "setup", charged: claude.charged });
    if (!spend) return { filled: 0, reason: "no credits" };
    const params = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      metadata: { user_id: anthropicUserId(userId) },
      system: SYSTEM,
      messages: [{ role: "user", content: userMessage(owner, request) }],
    };
    params.max_tokens = spend.maxTokens(params.max_tokens, params);
    if (!params.max_tokens) {
      await spend.finish();
      return { filled: 0, reason: "no credits" };
    }
    let message = null;
    try {
      message = await anthropicClient(claude.apiKey).messages.create(params, { timeout: TIMEOUT_MS });
    } finally {
      await spend.finish(message ? { model: message.model, usage: message.usage } : {});
    }
    if (message.stop_reason !== "end_turn") return { filled: 0, reason: "the reply was cut off" };
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const reply = parseJson(text);
    const checked = reply ? checkFill(kit.fill, files, reply) : { problem: "the reply wasn't JSON" };
    if (!checked.value) return { filled: 0, reason: `the reply didn't fit the template: ${checked.problem}` };

    const release = acquire(key, "making the template your own");
    let filled = 0;
    try {
      for (const [file, value] of Object.entries(checked.value)) {
        const { data, changed } = mergeFill(files[file], value, kit.fill[file]);
        if (!changed) continue;
        await fs.writeFile(path.join(dataDir, file), `${JSON.stringify(data, null, 2)}\n`);
        filled += changed;
      }
    } finally {
      release();
    }
    if (checked.problems.length) console.warn(`Template ${kit.id}: kept the sample wording where the AI's didn't fit: ${checked.problems.join("; ")}`);
    return { filled };
  } catch (err) {
    console.error(`Couldn't make the ${kit?.id} template's wording the owner's own:`, err.message);
    return { filled: 0, reason: "error" };
  }
}

const SYSTEM = `You adapt the sample wording of a ready-made website template to a specific organisation, so it reads as if written for them.

You get what the owner told us about themselves, and the template's sample wording as JSON. Reply with one JSON object and nothing else: exactly the same shape and keys as the sample, with only the strings rewritten.

Rules:
- Say what this organisation really does, in the owner's own terms and language. If the sample is about food and the organisation helps animals, the wording becomes about animals.
- Keep the same number of items, in the same order, and keep each item's role (a project stays a project, a volunteer role a role).
- Never invent facts: no statistics, years, amounts, addresses, names of people, partners or places, and no claims the owner didn't make ("run by volunteers", "since 2012"). Where the sample states such a fact and the owner hasn't, write it without the fact. Check especially the "about" and "story" sentences: "run by volunteers", "a borrowed van", "since 2012", "the whole town" and the like are the sample's inventions, so drop them unless the owner said so.
- Keep every string about as long as the sample's (never more than half as long again), plain text only: no HTML, no markdown, no braces, no emoji.
- Warm, plain, specific. No marketing filler.`;

function userMessage(owner, request) {
  const about = [owner.name && `Name: ${owner.name}`, owner.what && `What they do: ${owner.what}`, owner.brief && `Their brief for the website: ${owner.brief}`].filter(Boolean).join("\n");
  return `THE OWNER SAID:\n${about}\n\nTHE TEMPLATE'S SAMPLE WORDING:\n${JSON.stringify(request)}`;
}

function parseJson(text) {
  const raw = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
