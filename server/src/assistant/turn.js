import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { countInputTokens } from "../credits.js";
import { noteProviderError } from "../provider-health.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { TOOL_DEFINITIONS, runTool, toolInfo } from "./tools.js";

// One assistant turn: Claude answers the owner's latest message, calling tools as it goes, until
// it stops. Read tools run straight away; change tools become proposals (actions) for the owner.
// `messages` is the conversation's full history and is only ever appended to.

// Requests Claude may make in one turn (each tool round is one). Plenty for "read a few things,
// propose a few changes"; it stops a runaway loop.
const MAX_STEPS = 16;
const MAX_TOKENS = 64_000;
// server-side-fallback: a request a safety classifier declines is retried on the model Anthropic
// recommends for it. context-management: old tool results (page sources) are cleared from long
// conversations on the server, which doesn't count as editing the history.
const BETAS = ["server-side-fallback-2026-07-01", "context-management-2025-06-27"];
// The history is cached for an hour, not 5 minutes: owners pause between messages (to look at a
// page, apply a card), and every pause past the TTL rewrote the whole history (often 80k+ tokens).
// A 1-hour write costs 2x input instead of 1.25x, but only on what's new each request.
const CACHE = { type: "ephemeral", ttl: "1h" };
// Clearing old tool results rewrites the cache from the first cleared one on, so it's only worth
// doing in large steps: past 100k tokens, and only when it clears at least 40k.
const CONTEXT_EDITS = [
  {
    type: "clear_tool_uses_20250919",
    trigger: { type: "input_tokens", value: 100_000 },
    keep: { type: "tool_uses", value: 3 },
    clear_at_least: { type: "input_tokens", value: 40_000 },
  },
];

// The instructions and tools are the same for every conversation and every account, so they're cached
// on their own (a breakpoint after the system prompt) and shared: a new or long-idle conversation then
// reads them at a tenth of the price instead of writing them again. `sharedCachedAt` is when this
// server last sent them, so the cost estimate knows they're probably cached.
const SYSTEM = [{ type: "text", text: SYSTEM_PROMPT, cache_control: CACHE }];
const SHARED_TOKENS = Math.ceil(JSON.stringify({ SYSTEM_PROMPT, TOOL_DEFINITIONS }).length / 3.5);
const CACHE_FRESH_MS = 55 * 60 * 1000;
let sharedCachedAt = 0;

/**
 * What to tell the owner when a request was refused although they still have credits. A new
 * conversation is suggested only when there's an earlier one to leave behind (`fresh` is false):
 * otherwise the cost is the instructions themselves, which a new conversation reads just the same.
 */
const tooCostlyNote = ({ needed, balance, fresh }) => {
  const cost = `about ${needed.toLocaleString("en")} credits and you have ${balance.toLocaleString("en")}`;
  return fresh
    ? `I've stopped before starting, because reading your request along with my instructions would cost ${cost}. It costs more when Claude hasn't been used for an hour or so. Buy more credits below and I'll carry on.`
    : `I've stopped before starting, because picking this conversation up again would cost ${cost}. Claude re-reads a whole conversation when it's been idle for a while. Start a new conversation to carry on for less, or buy more credits below.`;
};

const OUT_OF_CREDITS_NOTE = "I've stopped here because your Claude credits have run out. Buy more credits below and I'll carry on.";

const PROPOSED ="Shown to the owner as a card. It is NOT applied yet: they'll apply or skip it, and the next message will tell you which.";

export function anthropicClient(apiKey) {
  return new Anthropic({ apiKey, ...(process.env.ANTHROPIC_BASE_URL && { baseURL: process.env.ANTHROPIC_BASE_URL }) });
}

const emptyUsage = () => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

function addUsage(total, usage) {
  for (const field of Object.keys(total)) total[field] += usage?.[field] ?? 0;
}

/**
 * Runs the turn. `live` is updated as it goes (text as it streams, what Claude is looking at, the
 * proposals) so the browser can show progress; `onUpdate` is called after each change to it.
 * Returns the messages to append to the history, the proposals and the token usage. `model` is
 * the account's assistant model (getAssistantModel); a fallback after a refusal may answer with another.
 * `beginSpend()` starts each request's Spend (credits.js), which caps its max_tokens, watches it as
 * it streams and charges it; null means the account can't pay for another request. A request cut
 * off because the credits ran out keeps the text it wrote, and the turn ends there. `cachedTokens`:
 * how much of the history is still in Claude's cache (the conversation's last request, if it was
 * within the hour), so the first request's cost is estimated right; later ones use the step before.
 * The result's `lastPrompt` is the last request's size, for the next turn's `cachedTokens`.
 * `imageModel` is the site's image model (image-model.js) for pictures create_image makes.
 */
// Claude takes at most 100 images in one request, the history's included. With 20 files a message,
// a long conversation can pass that: the oldest images are then sent as a line saying they were
// shown earlier (Claude has already described or used them), so the conversation keeps working.
const MAX_REQUEST_IMAGES = 90;
const EARLIER_IMAGE = { type: "text", text: "(An image attached earlier in the conversation, no longer shown.)" };

/** `messages` with only the newest MAX_REQUEST_IMAGES image blocks kept (the same array when under it). */
export function withinImageLimit(messages) {
  let images = 0;
  const count = (blocks) => {
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block?.type === "image") images++;
      else if (block?.type === "tool_result") count(block.content);
    }
  };
  for (const message of messages) count(message.content);
  if (images <= MAX_REQUEST_IMAGES) return messages;
  let drop = images - MAX_REQUEST_IMAGES;
  const trim = (blocks) =>
    blocks.map((block) => {
      if (drop > 0 && block?.type === "image") {
        drop--;
        return EARLIER_IMAGE;
      }
      if (drop > 0 && block?.type === "tool_result" && Array.isArray(block.content)) return { ...block, content: trim(block.content) };
      return block;
    });
  return messages.map((message) => (drop > 0 && Array.isArray(message.content) ? { ...message, content: trim(message.content) } : message));
}

export async function runTurn({ client, key, model: requested, history, live, onUpdate = () => {}, beginSpend, cachedTokens = 0, signal, imageModel = null, userId = null }) {
  const messages = [...history];
  const start = history.length;
  const usage = emptyUsage();
  const actions = [];
  let model = requested;
  let stopReason = null;
  let lastPrompt = 0;
  const promptSize = (u) => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);

  try {
    await loop();
  } catch (err) {
    if (err instanceof Anthropic.APIError && err.status && client.apiKey === config.platformAnthropicKey) noteProviderError("claude", err.status, err.message);
    // Whatever finished before the error (complete steps only) is still part of the conversation.
    err.partial = { appended: messages.slice(start), actions, usage, model, lastPrompt };
    throw err;
  }
  onUpdate();
  return { appended: messages.slice(start), actions, usage, model, stopReason, lastPrompt };

  async function loop() {
    for (let step = 0; step < MAX_STEPS; step++) {
      const params = {
        model: requested,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        tools: TOOL_DEFINITIONS,
        messages: withinImageLimit(messages),
        output_config: { effort: "medium" },
        cache_control: CACHE,
        context_management: { edits: CONTEXT_EDITS },
        fallbacks: "default",
        betas: BETAS,
      };
      const spend = await beginSpend();
      const sharedWarm = Date.now() - sharedCachedAt < CACHE_FRESH_MS ? SHARED_TOKENS : 0;
      const cached = { cachedTokens: Math.max(sharedWarm, step === 0 ? cachedTokens : lastPrompt) };
      // Counted exactly when it's close: a request whose reading alone passes the limit is charged and gets nothing.
      params.max_tokens = (await spend?.fitMaxTokens(MAX_TOKENS, params, cached, (body) => countInputTokens(client, body))) ?? 0;
      if (!params.max_tokens) {
        await spend?.finish();
        // `start` is 1 when the owner's message is the conversation's first.
        const shortfall = spend?.shortfall && { ...spend.shortfall, fresh: start <= 1 };
        live.parts.push(
          shortfall
            ? { type: "text", text: tooCostlyNote(shortfall), credits: shortfall.fresh ? "out" : "short" }
            : { type: "text", text: OUT_OF_CREDITS_NOTE, credits: "out" },
        );
        stopReason = "out_of_credits";
        break;
      }
      const stream = client.beta.messages.stream(params, { signal });

      // Text streams into the current text part; a tool call shows as "Reading the site plan".
      const blockParts = new Map();
      let cutOff = null;
      stream.on("streamEvent", (event, snapshot) => {
        // The credits are spent down to the overdraft limit: stop Claude, keeping what it wrote.
        if (!cutOff && spend.track(event)) {
          cutOff = snapshot ?? { content: [] };
          stream.abort();
        }
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "text") {
            const part = { type: "text", text: "" };
            live.parts.push(part);
            blockParts.set(event.index, part);
          } else if (block.type === "tool_use") {
            const info = toolInfo(block.name);
            if (info?.kind === "read") {
              const part = { type: "activity", label: info.activity({}) };
              live.parts.push(part);
              blockParts.set(event.index, part);
            } else if (info && info.kind !== "talk") {
              live.parts.push({ type: "activity", label: "Getting a change ready", pending: true });
              blockParts.set(event.index, live.parts.at(-1));
            }
          }
          onUpdate();
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          const part = blockParts.get(event.index);
          if (part?.type === "text") {
            part.text += event.delta.text;
            onUpdate();
          }
        }
      });

      let message;
      try {
        message = await stream.finalMessage();
      } catch (err) {
        // A request stopped part-way (by the owner, an error, or the credits) is charged for what
        // it used up to then.
        if (!spend.stopped) {
          addUsage(usage, spend.usage);
          await spend.finish();
          // With eager input streaming, a tool input that isn't valid JSON rejects the stream. Ask
          // again (the failed request added nothing to the history); API errors go to the caller.
          if (err instanceof Anthropic.APIError || err instanceof Anthropic.APIUserAbortError || step === MAX_STEPS - 1) throw err;
          live.parts = live.parts.filter((p) => !p.pending);
          continue;
        }
      }
      lastPrompt = promptSize(spend.stopped ? spend.usage : message.usage) || lastPrompt;
      if (lastPrompt) sharedCachedAt = Date.now();
      if (spend.stopped) {
        addUsage(usage, spend.usage);
        await spend.finish();
      } else {
        // Each request is charged as soon as it's done, so the balance moves while Claude works.
        addUsage(usage, message.usage);
        await spend.finish({ model: message.model, usage: message.usage });
        model = message.model ?? model;
      }
      // Placeholders become real parts below (or go, if the call was refused).
      live.parts = live.parts.filter((p) => !p.pending && !(p.type === "text" && !p.text));

      // Out of credits: cut off at the overdraft limit, or at the max_tokens the balance allowed.
      // The text written so far stays in the conversation; a half-written tool call never runs.
      if (spend.stopped || (spend.clamped && message.stop_reason === "max_tokens")) {
        const content = (message ?? cutOff).content.filter((b) => b.type === "text" && b.text);
        if (content.length) messages.push({ role: "assistant", content });
        live.parts.push({ type: "text", text: OUT_OF_CREDITS_NOTE, credits: "out" });
        stopReason = "out_of_credits";
        break;
      }
      stopReason = message.stop_reason;

      if (stopReason === "refusal") {
        if (message.content.length) messages.push({ role: "assistant", content: message.content });
        live.parts.push({ type: "text", text: "I can't help with that request. Try asking in a different way." });
        break;
      }
      if (stopReason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }

      const toolUses = message.content.filter((b) => b.type === "tool_use");
      if (!toolUses.length) {
        messages.push({ role: "assistant", content: message.content });
        break;
      }

      const results = [];
      for (const block of toolUses) {
        // A tool call cut off at the output limit can still parse; never act on it.
        if (stopReason === "max_tokens") {
          results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "Your input was cut off at the output limit. Send a shorter one." });
          continue;
        }
        // A change that takes a while to prepare (making a picture) says so while it runs.
        const working = toolInfo(block.name)?.working?.(block.input ?? {});
        const workingPart = working && { type: "activity", label: working, pending: true };
        if (workingPart) {
          live.parts.push(workingPart);
          onUpdate();
        }
        const outcome = await runTool(block.name, block.input, key, { beginSpend, signal, imageModel, userId }).finally(() => {
          if (workingPart) live.parts = live.parts.filter((p) => p !== workingPart);
        });
        if (outcome.error) {
          results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: outcome.error });
          continue;
        }
        if (outcome.talk) {
          live.parts.push({ type: "choices", ...outcome.talk });
          results.push({ type: "tool_result", tool_use_id: block.id, content: "Shown to the owner as buttons." });
          continue;
        }
        if (outcome.result !== undefined) {
          const info = toolInfo(block.name);
          live.parts.push({ type: "activity", label: info.activity(block.input ?? {}) });
          results.push({ type: "tool_result", tool_use_id: block.id, content: outcome.result || "(empty)" });
          continue;
        }
        const info = toolInfo(block.name);
        const action = {
          id: block.id,
          tool: block.name,
          title: info.title,
          runs: info.runs,
          ...outcome.action,
          status: "proposed",
          result: null,
          reported: false,
          createdAt: new Date().toISOString(),
        };
        actions.push(action);
        live.actions.push(action);
        live.parts.push({ type: "action", id: action.id });
        results.push({ type: "tool_result", tool_use_id: block.id, content: PROPOSED });
      }
      onUpdate();
      // The assistant turn and every result for it go in together (one message of results), so the
      // history never ends on a tool call without its result.
      messages.push({ role: "assistant", content: message.content }, { role: "user", content: results });

      if (step === MAX_STEPS - 1) {
        live.parts.push({ type: "text", text: "I've stopped here to check in. Tell me to carry on if you'd like me to continue." });
      }
    }
  }
}
