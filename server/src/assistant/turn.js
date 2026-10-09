import Anthropic from "@anthropic-ai/sdk";
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

const PROPOSED = "Shown to the owner as a card. It is NOT applied yet: they'll apply or skip it, and the next message will tell you which.";

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
 * `onMessage(message)` is called after each request (to record and charge it), and before each
 * request after the first `canContinue()` says whether the account can still pay for one.
 */
export async function runTurn({
  client,
  key,
  model: requested,
  history,
  live,
  onUpdate = () => {},
  onMessage = async () => {},
  canContinue = async () => true,
  signal,
}) {
  const messages = [...history];
  const start = history.length;
  const usage = emptyUsage();
  const actions = [];
  let model = requested;
  let stopReason = null;

  try {
    await loop();
  } catch (err) {
    // Whatever finished before the error (complete steps only) is still part of the conversation.
    err.partial = { appended: messages.slice(start), actions, usage, model };
    throw err;
  }
  onUpdate();
  return { appended: messages.slice(start), actions, usage, model, stopReason };

  async function loop() {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (step > 0 && !(await canContinue())) {
        live.parts.push({ type: "text", text: "I've stopped here because your Claude credits have run out. Buy more credits, then tell me to carry on." });
        stopReason = "out_of_credits";
        break;
      }
      const stream = client.beta.messages.stream(
        {
          model: requested,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          tools: TOOL_DEFINITIONS,
          messages,
          output_config: { effort: "medium" },
          cache_control: CACHE,
          context_management: { edits: CONTEXT_EDITS },
          fallbacks: "default",
          betas: BETAS,
        },
        { signal },
      );

      // Text streams into the current text part; a tool call shows as "Reading the site plan".
      const blockParts = new Map();
      stream.on("streamEvent", (event) => {
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
            } else if (info) {
              live.parts.push({ type: "activity", label: "Preparing a change", pending: true });
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
        // With eager input streaming, a tool input that isn't valid JSON rejects the stream. Ask
        // again (the failed request added nothing to the history); API errors go to the caller.
        if (err instanceof Anthropic.APIError || err instanceof Anthropic.APIUserAbortError || step === MAX_STEPS - 1) throw err;
        live.parts = live.parts.filter((p) => !p.pending);
        continue;
      }
      addUsage(usage, message.usage);
      await onMessage(message);
      model = message.model ?? model;
      stopReason = message.stop_reason;
      // Placeholders become real parts below (or go, if the call was refused).
      live.parts = live.parts.filter((p) => !p.pending && !(p.type === "text" && !p.text));

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
        const outcome = await runTool(block.name, block.input, key);
        if (outcome.error) {
          results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: outcome.error });
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
