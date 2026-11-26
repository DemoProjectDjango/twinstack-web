// The site agent (GET/PUT/POST …/agent, server/src/site-agent.js): the chat helper on the published
// site. Only the site's creator gets any of it (like Visitors): everyone else gets 404.

export type AgentTone = "friendly" | "professional" | "playful" | "calm";

/** How quickly the agent speaks up (PACES in server/src/site-agent-rules.js). */
export type AgentPace = "gentle" | "balanced" | "eager";

/** Where the agent steers visitors: a name ("Donate") and one of the site's pages. */
export type AgentGoal = { label: string; path: string; note: string };

export type AgentSettings = {
  name: string;
  greeting: string;
  tone: AgentTone;
  goals: AgentGoal[];
  /** Credits the agent may spend in any 24 hours. */
  dailyCredits: number;
  /** Offer visitors to be remembered on their device (they choose; `rememberDays` in the view). */
  remember: boolean;
  pace: AgentPace;
  /** The free hello bubble a few seconds into a visit. */
  greet: boolean;
  /** The chat button: "#rrggbb", or "" for the site's brand colour. */
  color: string;
  position: "right" | "left";
  icon: AgentIcon;
  /** Text beside the icon ("" for the icon alone), at most 24 characters. */
  label: string;
};

/** The chat button's icons (agent.js draws them; "logo" is the site's logo mark). */
export type AgentIcon = "chat" | "sparkle" | "question" | "wave" | "heart" | "logo";

/** One kind of request's cost: the last 30 days' average when `measured`, else an estimate. */
export type AgentCost = { credits: number | null; tokens: number; requests: number; measured: boolean };

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
  /** How long a returning visitor who said yes is remembered after their last visit. */
  rememberDays: number;
  /** Each pace's times (ms) and suggestions per visit. */
  paces: Record<AgentPace, { goalRest: number; linkRest: number; gap: number; perVisit: number }>;
  costs: { suggestion: AgentCost; answer: AgentCost };
  icons: AgentIcon[];
};

export type AgentOutcome = "accepted" | "dismissed" | "ignored" | "pending";

export type AgentSuggestion = {
  at: string;
  path: string;
  /** What made the agent speak up: "goal-hover", "link-hover", "repeat-clicks", "leaving", "browsing", "reading". */
  trigger: string;
  text: string;
  target: string;
  label: string;
  outcome: AgentOutcome;
  /** The visitor opened the suggested page later in the visit. */
  reached: boolean;
};

export type AgentQuestion = {
  at: string;
  path: string;
  question: string;
  answer: string | null;
  target: string | null;
  /** Outside the website (or a try to take the agent off its job): the fixed reply was given. */
  offTopic: boolean;
};

export type AgentSession = {
  /** A short label for the anonymous visitor, not their session id. */
  id: string;
  startedAt: string;
  lastSeenAt: string;
  device: string;
  /** A returning visitor's visit number (2 and up), or null for a first or unremembered visit. */
  visit: number | null;
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
    /** Visits by returning visitors who said yes to being remembered. */
    returning: number;
    /** accepted / shown, or null with nothing shown. */
    acceptance: number | null;
    credits: number;
  };
  sessions: AgentSession[];
  /** Pass as `before` for the next (older) page, or null at the end. */
  next: string | null;
};
