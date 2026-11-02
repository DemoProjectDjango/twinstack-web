// A new site's setup (components/setup/SetupFlow.tsx): asked in Create a new site before the site
// exists, then applied by the editor once it opens (site/FirstRunSetup.tsx). The answers are handed
// over in this module's memory, not storage: the move to the editor is a client-side navigation,
// and the logo and photos are File objects too big for sessionStorage. A reload loses them, and the
// editor then asks again.
//
// The analysis (POST /api/setup/plan, server/src/site-setup.js) writes the questions for this
// business and plans its pages; the skills (server/src/site-types/*.json, GET /api/setup/skills)
// only guide it, and give the browser the words to read the owner's answers by as they type.

export type FieldType = "choice" | "multi" | "yesno" | "text" | "tel" | "email" | "url" | "textarea" | "hours" | "items" | "logo" | "photos";

export type SetupField = {
  id: string;
  type: FieldType;
  label: string;
  choices?: string[];
  /** A choice field that takes the owner's own words too. */
  other?: boolean;
  /** Where the answer is saved: "profile", "contact.<field>", "social.<field>", "brand.logo" or "photos". */
  saveTo: string;
  hint?: string;
  placeholder?: string;
  itemLabel?: string;
  descLabel?: string;
  max?: number;
  noPrice?: boolean;
  showIf?: { field: string; equals: string };
};

/** A question the AI wrote: asked now ("ask") or by Claude in the editor ("later"). */
export type SetupGroup = { id: string; title: string; lead: string; why: string; status: "ask" | "later"; fields: SetupField[] };

/** A kind of business, for reading the owner's words as they type: its keywords and its choices' hint words. */
export type Skill = { id: string; version: number; label: string; keywords: string[]; hints: { label: string; multi: boolean; hints: Record<string, string[]> }[] };

export type PageAction = "update" | "create" | "keep";
export type PagePlan = { title: string; address: string; action: PageAction; purpose: string };
export type Finding = { text: string; changes: string };
export type Known = { label: string; value: string };

export type SetupPlan = {
  type: string;
  label: string;
  version: number;
  by: "claude" | "keywords";
  confidence: "sure" | "likely" | "not sure";
  evidence: string[];
  searched: number;
  fetched: number;
  findings: Finding[];
  known: Known[];
  pages: PagePlan[];
  chrome: "design" | "keep";
  questions: SetupGroup[];
  prefill: Record<string, AnswerValue>;
};

export type HoursRow = { day: string; open: string; close: string; closed: boolean };
export type Item = { name: string; desc: string; price: string; sample?: boolean };
export type AnswerValue = string | string[] | HoursRow[] | Item[];

/** Everything the setup collected; the editor saves it (POST …/setup) and uploads the files. */
export type SetupAnswers = {
  name: string;
  what: string;
  brief: string;
  type: string;
  by: "claude" | "keywords";
  /** Every question the owner saw, with "ask" for those answered now. */
  questions: SetupGroup[];
  answers: Record<string, AnswerValue>;
  skipped: string[];
  pages: PagePlan[];
  chrome: "design" | "keep";
  known: Known[];
  findings: Finding[];
  logo: File | null;
  photos: File[];
};

export const MAX_PHOTOS = 6;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const PHOTO_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const LOGO_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
// The website brief needs at least this many words when it's given (the server's MIN_BRIEF_WORDS).
export const MIN_BRIEF_WORDS = 10;
export const MAX_QUESTIONS = 5;
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const DEFAULT_HOURS: HoursRow[] = DAYS.map((day) => ({ day, open: "09:00", close: "17:00", closed: false }));

export const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Opening hours as one line, the way the site shows them (server/src/site-setup.js's hoursText). */
export function hoursText(hours: HoursRow[]) {
  const groups: { key: string; days: string[] }[] = [];
  for (const h of hours) {
    const key = h.closed ? "closed" : `${h.open}–${h.close}`;
    const last = groups.at(-1);
    if (last && last.key === key) last.days.push(h.day);
    else groups.push({ key, days: [h.day] });
  }
  return groups.map((g) => `${g.days.length > 1 ? `${g.days[0]}–${g.days.at(-1)}` : g.days[0]} ${g.key}`).join(", ");
}

export type TextRead = { skill: Skill | null; evidence: string[]; confidence: "sure" | "likely" | "not sure yet"; facts: [string, string][] };

/**
 * What the owner's words give away before the analysis runs: the skill whose keywords they use most,
 * and the choices their words hint at.
 */
export function readText(skills: Skill[], text: string): TextRead {
  const lower = ` ${text.toLowerCase()} `;
  const found = new Set(lower.match(/[\p{L}']+/gu) ?? []);
  let best: { skill: Skill | null; hits: string[] } = { skill: null, hits: [] };
  for (const skill of skills) {
    const hits = skill.keywords.filter((k) => found.has(k));
    if (hits.length > best.hits.length) best = { skill, hits };
  }
  const facts: [string, string][] = [];
  for (const field of best.skill?.hints ?? []) {
    const matched = Object.entries(field.hints)
      .filter(([, list]) => list.some((w) => lower.includes(w.toLowerCase())))
      .map(([choice]) => choice);
    if (matched.length) facts.push([field.label.replace(/ \((optional|pick any)\)$/, "").replace(/\?$/, ""), field.multi ? matched.join(", ") : matched[0]]);
  }
  return { skill: best.skill, evidence: best.hits.slice(0, 6), confidence: best.hits.length >= 3 ? "sure" : best.hits.length ? "likely" : "not sure yet", facts };
}

export function readAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

const pending = new Map<string, SetupAnswers>();
const pendingKey = (owner: string, repo: string) => `${owner.toLowerCase()}/${repo.toLowerCase()}`;

/** Keeps a new site's answers for the editor; call just before navigating to it. */
export function setPendingSetup(owner: string, repo: string, setup: SetupAnswers) {
  pending.set(pendingKey(owner, repo), setup);
}

/** The answers waiting for this site, if any. Doesn't remove them: see `clearPendingSetup`. */
export const peekPendingSetup = (owner: string, repo: string) => pending.get(pendingKey(owner, repo)) ?? null;

export function clearPendingSetup(owner: string, repo: string) {
  pending.delete(pendingKey(owner, repo));
}

/**
 * The setup as the server takes it (POST /api/setup/preview, POST …/setup): the logo and photos as
 * the paths they were saved at, under their questions' fields.
 */
export function setupBody(setup: Omit<SetupAnswers, "logo" | "photos">, files: { logo?: string; photos?: string[] } = {}) {
  const { name, what, brief, type, by, questions, answers, skipped, pages, chrome, known, findings } = setup;
  const fields = questions.flatMap((q) => q.fields);
  const logoField = fields.find((f) => f.type === "logo");
  const photosField = fields.find((f) => f.type === "photos");
  return {
    name,
    what,
    brief,
    type,
    by,
    questions,
    skipped,
    pages,
    chrome,
    known,
    findings,
    answers: {
      ...answers,
      ...(logoField && files.logo && { [logoField.id]: files.logo }),
      ...(photosField && files.photos?.length && { [photosField.id]: files.photos }),
    },
  };
}
