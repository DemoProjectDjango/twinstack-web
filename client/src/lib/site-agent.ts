// The site agent (GET/PUT/POST …/agent, server/src/site-agent.js): the chat helper on the published
// site. Only the site's creator gets any of it (like Visitors): everyone else gets 404.

export type AgentTone = "friendly" | "professional" | "playful" | "calm";

/** Where the agent steers visitors: a name ("Donate") and one of the site's pages. */
export type AgentGoal = { label: string; path: string; note: string };

export type AgentSettings = {
  name: string;
  greeting: string;
  tone: AgentTone;
  goals: AgentGoal[];
  /** Credits the agent may spend in any 24 hours. */
  dailyCredits: number;
};

export type AgentView = {
  /** The copy's base.html loads the widget (else it needs the site update). */
  supported: boolean;
  enabled: boolean;
  /** The working copy's site.config.json has the widget as it is now: once published, it's live. */
  configured: boolean;
  /** The server has no PUBLIC_API_URL, so published pages can't reach it. */
  localEndpoint: boolean;
  hosts: string[];
  siteUrl: string | null;
  settings: AgentSettings;
  /** The site's published pages, for choosing goals. */
  pages: { url: string; title: string }[];
  usage: { creditsLast24h: number; balance: number };
  /** The AI can write suggestions and answers now (a model, and credits left). */
  canAnswer: boolean;
  limits: { dailyCredits: { min: number; default: number; max: number }; suggestionsPerSession: number; questionsPerSession: number };
  lastActivityAt: string | null;
  retentionDays: number;
};

export type AgentOutcome = "accepted" | "dismissed" | "ignored" | "pending";

export type AgentSuggestion = {
  at: string;
  path: string;
  /** What made the agent speak up: "goal-hover", "repeat-clicks", "leaving", "browsing", "reading". */
  trigger: string;
  text: string;
  target: string;
  label: string;
  outcome: AgentOutcome;
  /** The visitor opened the suggested page later in the visit. */
  reached: boolean;
};

export type AgentQuestion = { at: string; path: string; question: string; answer: string | null; target: string | null };

export type AgentSession = {
  /** A short label for the anonymous visitor, not their session id. */
  id: string;
  startedAt: string;
  lastSeenAt: string;
  device: string;
  pages: string[];
  suggestions: AgentSuggestion[];
  questions: AgentQuestion[];
};

export type AgentHistory = {
  from: string;
  to: string;
  totals: {
    sessions: number;
    shown: number;
    accepted: number;
    dismissed: number;
    ignored: number;
    reached: number;
    questions: number;
    /** accepted / shown, or null with nothing shown. */
    acceptance: number | null;
    credits: number;
  };
  sessions: AgentSession[];
  /** Pass as `before` for the next (older) page, or null at the end. */
  next: string | null;
};
