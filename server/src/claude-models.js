// The Claude models an account can choose in Settings. The choice is used by the "Ask Claude"
// assistant (assistant/turn.js) and handed to the site's scripts as TWINSTACK_MODEL (jobEnv in
// commands.js). Every model here must accept the assistant's request as it is (adaptive thinking,
// effort, server-side fallbacks "default", context management), so only add current 5.x models.

export const CLAUDE_MODELS = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    description: "Recommended. High-quality pages and changes at a fair price.",
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    description: "Faster and about half the price. Good for everyday edits.",
  },
  {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    description: "The most capable, for the hardest work. About 2.5 times the price of Opus.",
  },
];

const IDS = new Set(CLAUDE_MODELS.map((m) => m.id));

/** True when `id` is one of the models an account can choose. */
export const isClaudeModel = (id) => typeof id === "string" && IDS.has(id);

// ASSISTANT_MODEL (server env) changes the default for accounts that haven't chosen one.
export const DEFAULT_MODEL = isClaudeModel(process.env.ASSISTANT_MODEL) ? process.env.ASSISTANT_MODEL : "claude-opus-5-5";

// The "Ask Claude" assistant has its own choice (users.assistantModel), because it mostly reads the
// site and plans while the page writer does the designing: Sonnet does that well at half Opus's
// price. ASSISTANT_CHAT_MODEL (server env) changes the default.
export const DEFAULT_ASSISTANT_MODEL = isClaudeModel(process.env.ASSISTANT_CHAT_MODEL) ? process.env.ASSISTANT_CHAT_MODEL : "claude-sonnet-5-5";
