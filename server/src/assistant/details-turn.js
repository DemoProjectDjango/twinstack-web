import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { providerOf } from "../ai-providers.js";
import { DEEPSEEK_UPSTREAM } from "../claude-proxy.js";
import { createMessage } from "../openai-bridge.js";
import { getStaticInfo } from "../static-info.js";
import { runTool, toolInfo } from "./tools.js";

// Site details asked for on the Site details screen (site name, contact details, social links, FAQ,
// testimonials…) are filling in data, not designing or writing pages, so the app's cheaper model
// (fast-model.js, on DeepSeek or OpenAI) does them in one request instead of a whole Claude turn. Its
// changes become the same update_site_details proposals Claude makes (same checks, same cards), and
// the turn joins the conversation like any other. Anything it can't do (another kind of request, a
// reply it can't get right) returns null, and the turn goes to Claude as usual.

const MAX_TOKENS = 8000;
const TOOL = "update_site_details";

const SYSTEM = `You fill in the site details of a small business's website for its owner, who isn't technical. The site details are JSON sections (listed below with their current data). The owner's message says what to change.

Reply with one JSON object and nothing else:
{"handoff": false, "reply": "<one or two friendly sentences to the owner>", "changes": [{"section": "<section id>", "data": <the section's complete new data>, "summary": "<what changes, in a few plain words>"}]}

Rules:
- "data" is the whole section exactly as given in DATA, with the same fields and types, and only the asked-for values changed. Use only the fields FIELDS shows (a list's items have exactly the fields of its one example item); put each fact in the field that fits it best (a reviewer's name and details go in "meta"), and leave a field "" when nothing fits.
- Never invent facts: phone numbers, emails, addresses, prices, opening hours, reviews or names must come from the owner's message. If something needed is missing, make no change for it and ask for it in "reply".
- Questions about the details ("what's our email?") get an answer in "reply" and no changes.
- Set "handoff": true (and nothing else) when the message asks for anything other than these site details: pages, the menu, the header or footer, design, logos, images, files, publishing, search results, or several things at once.`;

/** The reply's JSON object, or null. */
function parseReply(text) {
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

/**
 * Runs the owner's site-details request on `model` (a deepseek-* or OpenAI id) with the app's key for
 * its provider, `apiKey`.
 * `beginSpend()` starts the request's Spend (credits.js); null means no credits. Fills `live` like
 * runTurn and resolves to runTurn's result, or null to let Claude take the turn.
 */
export async function runDetailsTurn({ key, text, model, apiKey, live, onUpdate = () => {}, beginSpend, signal }) {
  const { sections } = await getStaticInfo(key);
  if (!sections.length) return null;
  // DeepSeek takes Claude's request as it is; OpenAI's goes through openai-bridge.js.
  const send =
    providerOf(model) === "openai"
      ? async (params) => {
          try {
            return await createMessage(params, { apiKey, signal });
          } catch (err) {
            // Stopped by the owner: the same error the Anthropic SDK throws, which the route rethrows.
            if (signal?.aborted) throw new Anthropic.APIUserAbortError();
            throw err;
          }
        }
      : (params) => new Anthropic({ apiKey, baseURL: DEEPSEEK_UPSTREAM, maxRetries: 1 }).messages.create(params, { signal });
  // The layout too: an empty list shows no example of its items' fields.
  const described = sections
    .map((s) => `SECTION ${s.id} (${s.label}): ${s.description}\nFIELDS: ${JSON.stringify(s.shape)}\nDATA: ${JSON.stringify(s.data)}`)
    .join("\n\n");
  const messages = [{ role: "user", content: `${described}\n\nTHE OWNER SAYS:\n${text}` }];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  live.parts.push({ type: "activity", label: "Filling in your site details", pending: true });
  onUpdate();

  // One request, and one more if its changes don't fit the sections: the checks' words go back to it.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const spend = await beginSpend();
    const params = { model, max_tokens: MAX_TOKENS, system: SYSTEM, messages };
    params.max_tokens = spend?.maxTokens(MAX_TOKENS, params) ?? 0;
    if (!params.max_tokens) {
      await spend?.finish();
      return null;
    }
    let message;
    try {
      message = await send(params);
    } finally {
      await spend.finish(message ? { model: message.model, usage: message.usage } : {});
    }
    for (const field of Object.keys(usage)) usage[field] += message.usage?.[field] ?? 0;
    if (message.stop_reason === "max_tokens") return null;

    const replyText = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const reply = parseReply(replyText);
    if (!reply || reply.handoff === true || typeof reply.reply !== "string") return null;
    const changes = Array.isArray(reply.changes) ? reply.changes : [];

    // Each change through the same checks as Claude's proposals.
    const actions = [];
    const problems = [];
    for (const change of changes) {
      const outcome = await runTool(TOOL, { section: change?.section, data: change?.data, summary: String(change?.summary || "Update the site details").slice(0, 300) }, key);
      if (outcome.error) problems.push(`${change?.section}: ${outcome.error}`);
      else actions.push(outcome.action);
    }
    if (problems.length) {
      if (attempt === 2) return null;
      messages.push({ role: "assistant", content: replyText }, { role: "user", content: `These changes can't be saved:\n- ${problems.join("\n- ")}\nReply again with the corrected JSON object only.` });
      continue;
    }

    const info = toolInfo(TOOL);
    live.parts = live.parts.filter((p) => !p.pending);
    live.parts.push({ type: "text", text: reply.reply });
    const made = actions.map((action) => ({
      id: `fast_${randomUUID()}`,
      tool: TOOL,
      title: info.title,
      runs: info.runs,
      ...action,
      status: "proposed",
      result: null,
      reported: false,
      createdAt: new Date().toISOString(),
    }));
    for (const action of made) {
      live.actions.push(action);
      live.parts.push({ type: "action", id: action.id });
    }
    onUpdate();
    // The history Claude reads later: what was said and proposed, as plain text.
    const proposed = made.map((a) => `- Proposed (${a.title}): ${a.summary}`).join("\n");
    const appended = [{ role: "assistant", content: [{ type: "text", text: proposed ? `${reply.reply}\n\n${proposed}` : reply.reply }] }];
    return { appended, actions: made, usage, model: message.model ?? model, stopReason: "end_turn" };
  }
  return null;
}
