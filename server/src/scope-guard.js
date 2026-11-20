import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { recordScopeBlock } from "./db.js";

/** Shared wording for what counts as website work. */
export const SCOPE_RULE = `WHAT YOU HELP WITH
- You only help with the owner's website and with using Twinstack: its pages, wording, design, pictures, menus, contact details, search results (SEO), visits, publishing and address (domain), and questions about how any of that works. Writing that goes on the site (a blog post, an About page, a menu, a price list, a translation of a page) is website work, whatever its subject: a bakery's site talks about bread, a lawyer's about law.
- Advice that shapes the site counts too: what pages to have, what to say to visitors, a tagline, how to describe their services.
- Anything else (homework, essays, emails or letters that aren't for the site, code for other projects, general questions, chatting) you decline in one friendly sentence and offer something you can do for their website instead. Don't do part of it.
- When it's unclear whether a request is for the site, assume it is, or ask.`;

/** Put first in the system prompt of the site's scripts' requests (claude-proxy.js). */
export const PROXY_SCOPE_NOTE = `You are working inside Twinstack, a website builder, on one of its websites. Only produce work for that website: its pages, files, wording, design and search text. If the request is not about building or changing the website, do not carry it out.`;

export const SCOPE_REPLY =
  "I can only help with your website here: its pages, wording, design, pictures, menus, search results and publishing. If this is meant for your site, tell me which page it's for and I'll get started.";

const MODEL = "claude-haiku-4-5";
const TIMEOUT_MS = 6000;
// Short messages are almost always replies ("yes", "make it blue"): not worth a check.
const MIN_CHARS = 25;

const CLASSIFIER = `You check messages sent to the assistant inside a website builder. The assistant builds and changes the sender's own small-business website, and answers questions about the website and the builder.

${SCOPE_RULE}

Decide whether the NEW MESSAGE asks for website work, judged by the task, never by the subject (any subject can be written about on a website). Use the earlier conversation to read short replies.
- in: it's website work, a question about the site or the builder, a reply in the conversation, or plausibly content for the site.
- out: it clearly asks for something that is not for the website (homework, a cover letter, an email to a customer, code for another project, general knowledge or chat, role-play).
- unsure: anything else.
When in doubt, answer in or unsure, never out.

Answer with exactly two lines:
VERDICT: in|out|unsure
REASON: a few words`;

/**
 * Whether a new message to the assistant is about the website: `{ allowed, verdict, reason }`.
 * `recent` is the conversation's last few shown entries (display entries), for context.
 */
export async function checkScope({ text, recent = [], userId = null, siteId = null, where = "assistant", signal }) {
  const message = typeof text === "string" ? text.trim() : "";
  if (message.length < MIN_CHARS || !config.platformAnthropicKey) return { allowed: true, verdict: "skipped", reason: "" };
  const earlier = recent
    .map(entryText)
    .filter(Boolean)
    .slice(-3)
    .join("\n")
    .slice(-2000);
  let reply;
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await new Anthropic({ apiKey: config.platformAnthropicKey, ...(process.env.ANTHROPIC_BASE_URL && { baseURL: process.env.ANTHROPIC_BASE_URL }) }).messages.create(
      {
        model: MODEL,
        max_tokens: 40,
        system: CLASSIFIER,
        messages: [{ role: "user", content: `${earlier ? `EARLIER CONVERSATION\n${earlier}\n\n` : ""}NEW MESSAGE\n${message.slice(0, 6000)}` }],
      },
      { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, maxRetries: 0 },
    );
    reply = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  } catch (err) {
    if (signal?.aborted) throw err;
    console.error("The scope check failed, so the message goes through:", err.message);
    return { allowed: true, verdict: "error", reason: "" };
  }
  const verdict = /VERDICT:\s*(in|out|unsure)/i.exec(reply)?.[1]?.toLowerCase() ?? "unsure";
  const reason = /REASON:\s*(.+)/i.exec(reply)?.[1]?.trim() ?? "";
  if (verdict !== "out") return { allowed: true, verdict, reason };
  await recordScopeBlock({ userId, siteId, where, text: message, reason }).catch((err) => console.error("Couldn't record a scope block:", err.message));
  return { allowed: false, verdict, reason };
}

function entryText(entry) {
  if (entry?.role === "user") return entry.text ? `Owner: ${entry.text}` : "";
  if (entry?.role === "assistant") {
    const said = (entry.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join(" ");
    return said ? `Assistant: ${said.slice(-600)}` : "";
  }
  return "";
}

/** A turn result (as assistant/quick-turn.js returns) that answers with SCOPE_REPLY. */
export function scopeReplyResult(live) {
  live.parts.push({ type: "text", text: SCOPE_REPLY });
  return {
    appended: [{ role: "assistant", content: [{ type: "text", text: SCOPE_REPLY }] }],
    actions: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    model: null,
    stopReason: "end_turn",
  };
}
