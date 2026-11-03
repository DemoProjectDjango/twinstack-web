"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ACCENTS,
  DEFAULT_CHROME,
  MAX_FOOTER_COLUMNS,
  MAX_MENU_ITEMS,
  MIN_BRIEF_WORDS,
  contrastWithWhite,
  defaultColumns,
  isLegalPage,
  newId,
  syncMenu,
  hoursText,
  readText,
  setupBody,
  wordCount,
  type AnswerValue,
  type ChromeChoice,
  type FooterColumn,
  type HeaderButton,
  type MenuEntry,
  type HoursRow,
  type Item,
  type PageAction,
  type PagePlan,
  type SetupAnswers,
  type SetupGroup,
  type SetupPlan,
  type Skill,
} from "@/lib/setup";
import {
  ChromePreview,
  type ChromePreviewData,
  type PreviewPick,
} from "./ChromePreview";
import { LogoAndIcon, SetupFields } from "./SetupFields";
import { Button, ErrorText, Spinner, inputClass } from "../site/ui";

// A new site's setup, in a modal: what the business does, a brief for the website, then the AI's
// analysis (POST /api/setup/plan): it reads any web address the owner gave or looks at similar
// businesses, plans the pages (each to create, rewrite or keep, and the header and footer) and writes
// the questions for this business, at most 5 to ask now. Then those questions, the header and footer
// (when the plan gives the site new ones: the standard design or the AI's, its button and what the
// footer shows), and a review of what gets saved and built. Every step can be skipped. Under the first steps, a line says what the AI has
// understood so far.
// Create a new site (CreateSite.tsx) shows it inside its own window (embedded) before the site
// exists; the editor (FirstRunSetup.tsx) shows it, with the name as its first step, for a site that
// opened without answers.

type Step =
  | "name"
  | "what"
  | "brief"
  | "analysis"
  | "chrome"
  | "review"
  | `q:${string}`;
type ButtonOption = { id: HeaderButton; label: string; note: string };
type Analysis =
  | { state: "idle" }
  | { state: "running"; phase: number; signature: string }
  | { state: "failed"; signature: string; error: unknown }
  | { state: "done"; signature: string; result: SetupPlan };
type Preview = { config: unknown; profile: string; request: string };
type Status = "ask" | "later" | "skipped";

const PHASES = [
  "Reading what you told it",
  "Looking at the web",
  "Planning your pages",
  "Writing your questions",
];
const STATUS: Record<Status, [string, string]> = {
  ask: ["Will ask", "bg-foreground text-background"],
  later: [
    "Claude asks later",
    "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  ],
  skipped: [
    "Skipped: Claude asks later",
    "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  ],
};
const ACTION: Record<PageAction, [string, string]> = {
  create: [
    "New page",
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  ],
  update: [
    "Rewrite",
    "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  ],
  keep: ["Keep", "bg-zinc-100 text-zinc-500 dark:bg-zinc-900"],
  later: [
    "Later",
    "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  ],
};
/** A planned page the owner may leave for later: any but the homepage that would be made or rewritten. */
const optional = (p: PagePlan) =>
  p.address !== "/" && (p.action === "create" || p.action === "update");
// A brief may be a web address to work from ("Rebuild https://…") rather than ten words.
const HAS_URL = /https?:\/\/\S+|www\.\S+\.\S+/i;
const briefOk = (text: string) =>
  wordCount(text) >= MIN_BRIEF_WORDS || HAS_URL.test(text);

async function call<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      data.message ?? data.error ?? `The server answered ${res.status}.`,
    );
  return data as T;
}

function asText(value: AnswerValue): string {
  if (!Array.isArray(value)) return value;
  if (!value.length) return "";
  if (typeof value[0] === "string") return (value as string[]).join(", ");
  if ("day" in (value[0] as object)) return hoursText(value as HoursRow[]);
  return (value as Item[])
    .filter((i) => i.name)
    .map((i) => i.name)
    .join(", ");
}

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}
    >
      {children}
    </span>
  );
}

export function SetupFlow({
  name: givenName,
  askName = false,
  embedded = false,
  planUrl = "/api/setup/plan",
  title = "Create a new site",
  finishLabel,
  finishNote,
  onBack,
  onCancel,
  onDone,
}: {
  name: string;
  /** Ask the name as the first step (a site opened without answers). */
  askName?: boolean;
  /** Only the steps, for a window that already has its title and close button (Create a new site's). */
  embedded?: boolean;
  planUrl?: string;
  title?: string;
  finishLabel: string;
  finishNote?: string;
  /** Back from the first step. */
  onBack?: () => void;
  onCancel: () => void;
  onDone: (setup: SetupAnswers) => void | Promise<void>;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [name, setName] = useState(givenName);
  const [what, setWhat] = useState("");
  const [brief, setBrief] = useState("");
  const [readAfter, setReadAfter] = useState<"name" | "what" | "brief" | null>(
    givenName.trim() ? "name" : null,
  );
  const [analysis, setAnalysis] = useState<Analysis>({ state: "idle" });
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [fromBrief, setFromBrief] = useState<Set<string>>(new Set());
  const [logo, setLogo] = useState<File | null>(null);
  // The browser-tab icon, when the owner chose one other than the logo.
  const [favicon, setFavicon] = useState<File | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  // Questions planned for later that the owner chose to answer now.
  const [extraAsk, setExtraAsk] = useState<Set<string>>(new Set());
  // The header and footer: the design and what they show; the button picked (null: the best one there is).
  const [chromeOptions, setChromeOptions] =
    useState<Omit<ChromeChoice, "button">>(DEFAULT_CHROME);
  const [buttonPick, setButtonPick] = useState<HeaderButton | null>(null);
  // The planned pages (by address) the owner chose to have made now; the homepage always is.
  const [pagesNow, setPagesNow] = useState<Set<string>>(new Set());
  const togglePage = (address: string) =>
    setPagesNow((now) => {
      const next = new Set(now);
      if (!next.delete(address)) next.add(address);
      return next;
    });
  const [step, setStep] = useState(0);
  const [tab, setTab] = useState<"pages" | "profile" | "config" | "request">(
    "pages",
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    call<{ skills: Skill[] }>("/api/setup/skills")
      .then((data) => setSkills(data.skills))
      .catch(() => setSkills([]));
  }, []);

  const signature = `${name}\n${what}\n${brief}`;
  const result =
    analysis.state === "done" && analysis.signature === signature
      ? analysis.result
      : null;
  const live = useMemo(() => {
    const text =
      readAfter === "name"
        ? name
        : readAfter === "what"
          ? `${name} ${what}`
          : `${name} ${what} ${brief}`;
    return readText(skills, text);
  }, [skills, readAfter, name, what, brief]);

  // The AI's questions: those it asks now, in its order, then the later ones the owner chose to answer now.
  const questions: SetupGroup[] = result?.questions ?? [];
  const statusOf = (q: SetupGroup): "ask" | "later" =>
    q.status === "ask" || extraAsk.has(q.id) ? "ask" : "later";
  const asked = questions.filter((q) => statusOf(q) === "ask");
  const newChrome = result?.chrome === "design";
  const steps: Step[] = [
    ...(askName ? (["name"] as const) : []),
    "what",
    "brief",
    "analysis",
    ...asked.map((q) => `q:${q.id}` as const),
    ...(newChrome ? (["chrome"] as const) : []),
    "review",
  ];
  const current = steps[Math.min(step, steps.length - 1)];
  const group = current.startsWith("q:")
    ? questions.find((q) => q.id === current.slice(2))
    : undefined;

  // The analysis runs on reaching its step, again whenever the name, what you do or the brief changed
  // (`texts`: what they are as the step is reached, a skipped brief already cleared). The latest
  // request wins; the phases tick on while it runs.
  const request = useRef(0);
  const ticker = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => () => clearInterval(ticker.current), []);
  function runAnalysis(
    texts: { name: string; what: string; brief: string },
    force = false,
  ) {
    const sig = `${texts.name}\n${texts.what}\n${texts.brief}`;
    if (
      !force &&
      (analysis.state === "running" || analysis.state === "done") &&
      analysis.signature === sig
    )
      return;
    const id = ++request.current;
    setAnalysis({ state: "running", phase: 0, signature: sig });
    clearInterval(ticker.current);
    ticker.current = setInterval(
      () =>
        setAnalysis((a) =>
          a.state === "running" && a.phase < PHASES.length - 1
            ? { ...a, phase: a.phase + 1 }
            : a,
        ),
      3000,
    );
    call<SetupPlan>(planUrl, {
      name: texts.name,
      what: texts.what,
      brief: briefOk(texts.brief) ? texts.brief : "",
    })
      .then((plan) => {
        if (id !== request.current) return;
        // New questions: new answers, starting from what the AI could fill in.
        setAnswers(plan.prefill);
        setFromBrief(new Set(Object.keys(plan.prefill)));
        setSkipped(new Set());
        setExtraAsk(new Set());
        setPagesNow(new Set());
        setAnalysis({ state: "done", signature: sig, result: plan });
      })
      .catch(
        (err) =>
          id === request.current &&
          setAnalysis({ state: "failed", signature: sig, error: err }),
      )
      .finally(() => id === request.current && clearInterval(ticker.current));
  }

  const fieldsAll = questions.flatMap((q) => q.fields);
  const answered = (saveTo: string) => {
    const field = fieldsAll.find((f) => f.saveTo === saveTo);
    const value = field ? answers[field.id] : undefined;
    return typeof value === "string" ? value.trim() : "";
  };
  const contactPage = (result?.pages ?? []).find(
    (p) =>
      /^\/contact(-us)?\.html$/.test(p.address) &&
      (!optional(p) || pagesNow.has(p.address)),
  );
  const buttons: ButtonOption[] = [
    ...(answered("contact.bookingUrl")
      ? [
          {
            id: "book" as const,
            label: answered("contact.bookingLabel") || "Book now",
            note: "Opens your booking link",
          },
        ]
      : []),
    ...(answered("contact.phone")
      ? [
          {
            id: "call" as const,
            label: "Call us",
            note: answered("contact.phone"),
          },
        ]
      : []),
    ...(contactPage
      ? [
          {
            id: "contact" as const,
            label: "Contact us",
            note: `Opens your ${contactPage.title} page`,
          },
        ]
      : []),
    {
      id: "custom",
      label: chromeOptions.customLabel.trim() || "Your own button",
      note: "Your own words and link",
    },
    { id: "none", label: "No button", note: "Just your logo and menu" },
  ];
  const button = buttons.find((b) => b.id === buttonPick)?.id ?? buttons[0].id;
  const buttonLabel =
    button === "none"
      ? null
      : button === "custom"
        ? chromeOptions.customLabel.trim() || null
        : (buttons.find((b) => b.id === button)?.label ?? null);
  // The pages made now (the legal ones go in the footer's last line), the header's menu for them (kept
  // in step with the pages ticked, with the owner's edits), and the footer's columns (from the answers
  // until edited).
  const madeNow = (result?.pages ?? []).filter(
    (p) => p.address !== "/" && (!optional(p) || pagesNow.has(p.address)),
  );
  const legalPage = (p: PagePlan) => isLegalPage(p.address);
  const menu = syncMenu(chromeOptions.menu, madeNow);
  const columns = chromeOptions.columns.length
    ? chromeOptions.columns
    : defaultColumns({
        bookingUrl: answered("contact.bookingUrl"),
        bookingLabel: answered("contact.bookingLabel"),
        address: answered("contact.address"),
        phone: answered("contact.phone"),
      });
  const chromeChoice: ChromeChoice = {
    ...chromeOptions,
    button,
    menu,
    columns,
  };
  const hours = fieldsAll.find((f) => f.saveTo === "contact.hours");
  const hoursValue = hours ? answers[hours.id] : undefined;
  const chromePreview: ChromePreviewData = {
    name: name.trim(),
    tagline: what.trim(),
    pages: madeNow.filter((p) => !legalPage(p)).map((p) => p.title),
    button: buttonLabel,
    contact: {
      phone: answered("contact.phone"),
      email: answered("contact.email"),
      address: answered("contact.address"),
      hours:
        Array.isArray(hoursValue) &&
        hoursValue.length &&
        typeof hoursValue[0] === "object" &&
        "day" in hoursValue[0]
          ? hoursText(hoursValue as HoursRow[])
          : typeof hoursValue === "string"
            ? hoursValue
            : "",
    },
    social: fieldsAll
      .filter((f) => f.saveTo?.startsWith("social.") && answered(f.saveTo))
      .map((f) => f.saveTo!.slice("social.".length)),
    legal: [...madeNow.filter(legalPage).map((p) => p.title), "Sitemap"],
    logo,
  };

  const setup = (): SetupAnswers => ({
    name: name.trim(),
    what: what.trim(),
    brief: briefOk(brief) ? brief.trim() : "",
    type: result?.type ?? live.skill?.id ?? "generic",
    by: result?.by ?? "keywords",
    questions: questions.map((q) => ({ ...q, status: statusOf(q) })),
    answers,
    skipped: [...skipped].filter((id) => asked.some((q) => q.id === id)),
    pages: (result?.pages ?? []).map((p) =>
      optional(p) && !pagesNow.has(p.address)
        ? { ...p, action: "later" as const }
        : p,
    ),
    chrome: result?.chrome ?? "design",
    chromeChoice,
    known: result?.known ?? [],
    findings: result?.findings ?? [],
    logo,
    favicon,
    photos,
  });

  // The review's preview of what gets saved, from the server's own composition.
  useEffect(() => {
    if (current !== "review") return;
    const timer = setTimeout(() => {
      call<Preview>(
        "/api/setup/preview",
        setupBody(setup(), {
          logo: logo ? "/assets/img/brand/logo" : undefined,
          photos: photos.map((_, i) => `/assets/img/uploads/photo-${i + 1}`),
        }),
      )
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    current,
    answers,
    skipped,
    extraAsk,
    pagesNow,
    chromeOptions,
    buttonPick,
    logo,
    favicon,
    photos,
    name,
    what,
    brief,
    result,
  ]);

  /** Moves to step `next`; reaching the analysis runs it for `texts` (the owner's words as they stand). */
  function go(next: number, texts = { name, what, brief }) {
    const target = Math.max(0, Math.min(next, steps.length - 1));
    setError(null);
    setStep(target);
    if (steps[target] === "analysis") runAnalysis(texts);
    document.getElementById("setup-flow")?.scrollTo({ top: 0 });
  }

  function leave() {
    if (current === "name") setReadAfter("name");
    if (current === "what") setReadAfter("what");
    if (current === "brief") setReadAfter("brief");
  }

  async function finish() {
    setFinishing(true);
    setError(null);
    try {
      await onDone(setup());
    } catch (err) {
      setError(err);
    } finally {
      setFinishing(false);
    }
  }

  function next() {
    if (current === "review") return void finish();
    if (group)
      setSkipped((s) => new Set([...s].filter((id) => id !== group.id)));
    leave();
    go(step + 1);
  }

  function skip() {
    const texts = { name, what, brief };
    if (current === "name") setName((texts.name = ""));
    if (current === "brief" && !briefOk(brief)) setBrief((texts.brief = ""));
    if (current === "analysis") {
      // No questions now: straight to the review, each one left for Claude to ask in the editor.
      setSkipped(new Set(asked.map((q) => q.id)));
      return go(steps.length - 1);
    }
    if (group) setSkipped((s) => new Set([...s, group.id]));
    leave();
    go(step + 1, texts);
  }

  function answerNow(id: string) {
    setExtraAsk((s) => new Set([...s, id]));
    setSkipped((s) => new Set([...s].filter((x) => x !== id)));
    // Its step comes after the questions already asked, in the plan's order.
    const nextAsked = questions.filter(
      (q) => q.id === id || statusOf(q) === "ask",
    );
    go(steps.indexOf("analysis") + 1 + nextAsked.findIndex((q) => q.id === id));
  }

  const canContinue =
    current === "name"
      ? Boolean(name.trim())
      : current === "what"
        ? Boolean(what.trim())
        : current === "brief"
          ? briefOk(brief)
          : current === "analysis"
            ? Boolean(result)
            : !finishing;
  const questionIndex = group ? asked.indexOf(group) : -1;
  const skipLabel =
    current === "analysis"
      ? "Skip the questions"
      : group
        ? "Skip this question"
        : current === "chrome"
          ? null
          : current === "review"
            ? null
            : "Skip";
  const known = Boolean(result) || current === "review";
  const briefWords = wordCount(brief);

  const body = (
    <>
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {Array.from({ length: known ? steps.length + 1 : step + 3 }, (_, i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full ${i <= step + 1 ? "bg-foreground" : "bg-zinc-200 dark:bg-zinc-800"}`}
          />
        ))}
      </div>
      <p className="mt-5 text-xs font-medium text-zinc-500">
        Step {step + 2}
        {known && ` of ${steps.length + 1}`}
        {questionIndex >= 0 &&
          ` · Question ${questionIndex + 1} of ${asked.length}`}
      </p>

      {current === "name" && (
        <>
          <h2
            id="setup-step-title"
            className="mt-1 text-2xl font-semibold tracking-tight"
          >
            What&apos;s your business called?
          </h2>
          <p className="mt-2 text-sm text-zinc-500">
            It goes at the top of every page.
          </p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder="Harbour Street Bakery"
            aria-label="Business name"
            className={`${inputClass} mt-5 py-3 text-base`}
            autoFocus
          />
        </>
      )}

      {current === "what" && (
        <>
          <h2
            id="setup-step-title"
            className="mt-1 text-2xl font-semibold tracking-tight"
          >
            What does {name.trim() || "your business"} do?
          </h2>
          <p className="mt-2 text-sm text-zinc-500">
            One or two sentences, the way you&apos;d tell a customer. It goes
            under your name on the homepage and in search results.
          </p>
          <textarea
            value={what}
            onChange={(e) => setWhat(e.target.value)}
            rows={3}
            maxLength={600}
            placeholder="A family bakery making sourdough, pastries and celebration cakes every morning."
            aria-label="What the business does"
            className={`${inputClass} mt-5 resize-none py-3 text-base`}
            autoFocus
          />
        </>
      )}

      {current === "brief" && (
        <>
          <h2
            id="setup-step-title"
            className="mt-1 text-2xl font-semibold tracking-tight"
          >
            Tell us about your website
          </h2>
          <p className="mt-2 text-sm text-zinc-500">
            Who it&apos;s for, the pages you want and the feel you&apos;re
            after. Have a website you like, or an old one to rebuild? Paste its
            address and the AI looks at it.
          </p>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={5}
            maxLength={1500}
            placeholder="For local families and offices ordering cakes. A warm, homely look with lots of photos. Pages for our menu, celebration cakes, about us and how to order."
            aria-label="A brief for the website"
            className={`${inputClass} mt-5 resize-none py-3 text-base`}
            autoFocus
          />
          <p className="mt-1.5 text-xs text-zinc-500" aria-live="polite">
            {HAS_URL.test(brief)
              ? "The AI will look at the address you gave."
              : briefWords >= MIN_BRIEF_WORDS
                ? `${briefWords} words. More detail gives the AI more to go on.`
                : `At least ${MIN_BRIEF_WORDS} words, or a web address: ${MIN_BRIEF_WORDS - briefWords} more words to go. Or skip it.`}
          </p>
        </>
      )}

      {current === "analysis" && (
        <AnalysisStep
          analysis={analysis}
          result={result}
          statusOf={statusOf}
          pagesNow={pagesNow}
          onTogglePage={togglePage}
          onRetry={() => runAnalysis({ name, what, brief }, true)}
        />
      )}

      {group && (
        <>
          <h2
            id="setup-step-title"
            className="mt-1 text-2xl font-semibold tracking-tight"
          >
            {group.title}
          </h2>
          {group.lead && (
            <p className="mt-2 text-sm text-zinc-500">{group.lead}</p>
          )}
          {skipped.has(group.id) && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              You skipped this. Answer it now, or Claude asks you later.
            </p>
          )}
          <SetupFields
            group={group}
            answers={answers}
            onAnswer={(id, value) => {
              setAnswers((prev) => {
                const next = { ...prev };
                if (value === undefined) delete next[id];
                else next[id] = value;
                return next;
              });
              setFromBrief((s) => new Set([...s].filter((x) => x !== id)));
            }}
            fromBrief={fromBrief}
            logo={logo}
            onLogo={setLogo}
            favicon={favicon}
            onFavicon={setFavicon}
            siteName={name.trim()}
            accent={chromeOptions.accent}
            photos={photos}
            onPhotos={setPhotos}
            onError={setError}
          />
        </>
      )}

      {current === "chrome" && (
        <ChromeStep
          choice={chromeChoice}
          onChange={(patch) => setChromeOptions((o) => ({ ...o, ...patch }))}
          buttons={buttons}
          onButton={setButtonPick}
          preview={chromePreview}
          logo={logo}
          onLogo={setLogo}
          favicon={favicon}
          onFavicon={setFavicon}
          onError={setError}
          onUseDefault={() => {
            setChromeOptions(DEFAULT_CHROME);
            setButtonPick(null);
            next();
          }}
        />
      )}

      {current === "review" && (
        <ReviewStep
          name={name}
          what={what}
          brief={briefOk(brief) ? brief : ""}
          result={result}
          answers={answers}
          logo={logo}
          photos={photos}
          statusOf={(q) =>
            skipped.has(q.id) && statusOf(q) === "ask" ? "skipped" : statusOf(q)
          }
          onChange={(id) =>
            go(steps.indexOf(id === "basics" ? "what" : (`q:${id}` as Step)))
          }
          onAnswerNow={answerNow}
          tab={tab}
          onTab={setTab}
          preview={preview}
          pagesNow={pagesNow}
          onTogglePage={togglePage}
          chromeChoice={newChrome ? chromeChoice : null}
          buttonLabel={buttons.find((b) => b.id === button)?.label ?? ""}
          onChangeChrome={() => go(steps.indexOf("chrome"))}
        />
      )}

      {(current === "what" || current === "brief") && (
        <AiRead readAfter={readAfter} live={live} />
      )}
      <div className="mt-4">
        <ErrorText error={error} />
      </div>
      {current === "review" && finishNote && (
        <p className="text-sm text-zinc-500">{finishNote}</p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {step > 0 || onBack ? (
          <Button
            onClick={() => (step > 0 ? go(step - 1) : onBack?.())}
            className="px-4 py-2"
            disabled={finishing}
          >
            Back
          </Button>
        ) : (
          <Button
            variant="ghost"
            onClick={onCancel}
            className="px-4 py-2 text-zinc-500"
          >
            Cancel
          </Button>
        )}
        {skipLabel &&
          !(current === "analysis" && analysis.state === "running") && (
            <Button
              variant="ghost"
              onClick={skip}
              className="ml-auto px-4 py-2 text-zinc-500"
            >
              {skipLabel}
            </Button>
          )}
        <Button
          variant="primary"
          onClick={next}
          disabled={!canContinue}
          className={`px-5 py-2 ${skipLabel ? "" : "ml-auto"}`}
        >
          {finishing ? (
            <Spinner />
          ) : current === "review" ? (
            finishLabel
          ) : current === "analysis" ? (
            asked.length ? (
              `Answer ${asked.length} question${asked.length === 1 ? "" : "s"}`
            ) : (
              "Continue"
            )
          ) : (
            "Continue"
          )}
        </Button>
      </div>
    </>
  );

  // Inside Create a new site's own window, so the look doesn't change after the name.
  if (embedded) return body;
  return (
    // Scrolls as a whole when the window is taller than the screen (the review step can be).
    <div
      id="setup-flow"
      className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4 text-foreground backdrop-blur-[2px]"
    >
      <div className="flex min-h-full items-center justify-center">
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="setup-step-title"
          className="w-full max-w-xl rounded-xl border border-zinc-200 bg-background p-6 shadow-xl dark:border-zinc-800"
        >
          <div className="mb-5 flex items-start gap-3">
            <h1 className="text-lg font-semibold">{title}</h1>
            <button
              type="button"
              onClick={onCancel}
              aria-label="Close"
              className="-mr-2 -mt-1 ml-auto grid size-8 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-900"
            >
              ×
            </button>
          </div>
          {body}
        </section>
      </div>
    </div>
  );
}

/** One line of what the AI has read so far, under the "what you do" and brief steps. */
function AiRead({
  readAfter,
  live,
}: {
  readAfter: "name" | "what" | "brief" | null;
  live: ReturnType<typeof readText>;
}) {
  if (!readAfter) return null;
  return (
    <p
      className="mt-4 rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
      aria-live="polite"
    >
      <span className="font-semibold text-foreground">
        The AI understands:{" "}
      </span>
      {live.skill
        ? `a ${live.skill.label.toLowerCase()} website (${live.confidence})`
        : readAfter === "name"
          ? "not sure yet, the name alone could be many kinds of business"
          : "not sure yet, it works it out from your brief"}
      {live.evidence.length > 0 && `, from "${live.evidence.join(", ")}"`}
      {live.facts.length > 0 &&
        `. ${live.facts.map(([k, v]) => `${k}: ${v}`).join("; ")}`}
      .
    </p>
  );
}

/**
 * The page plan: each page with what happens to it, and the header and footer. The homepage is
 * always made; every other page to make or rewrite has a "Make it now" box (`pagesNow`), unticked
 * by default, and is left for later otherwise.
 */
function PagesPlan({
  pages,
  chrome,
  chromeMode,
  pagesNow,
  onTogglePage,
}: {
  pages: PagePlan[];
  chrome: "design" | "keep";
  /** The design chosen for new ones, once the owner has had the choice. */
  chromeMode?: ChromeChoice["mode"];
  pagesNow: Set<string>;
  onTogglePage: (address: string) => void;
}) {
  const choices = pages.filter(optional);
  return (
    <>
      {choices.length > 0 && (
        <p className="mt-1 text-zinc-500">
          Your homepage is made now. Tick any other page you want made now too;
          the rest are saved, and the AI offers them once your homepage is
          ready.
        </p>
      )}
      <ul className="mt-2 grid gap-2">
        {pages.map((p) => {
          const choice = optional(p);
          const action =
            choice && !pagesNow.has(p.address) ? "later" : p.action;
          const name = (
            <span>
              <b className="font-medium">{p.title}</b>{" "}
              <span className="text-xs text-zinc-400">{p.address}</span>
            </span>
          );
          return (
            <li
              key={p.address}
              className="grid grid-cols-[1fr_auto] items-start gap-x-3 gap-y-0.5"
            >
              {choice ? (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={pagesNow.has(p.address)}
                    onChange={() => onTogglePage(p.address)}
                    className="mt-1 size-4 shrink-0"
                    aria-label={`Make the ${p.title} page now`}
                  />
                  {name}
                </label>
              ) : (
                name
              )}
              <Pill tone={ACTION[action][1]}>{ACTION[action][0]}</Pill>
              {p.purpose && (
                <span
                  className={`col-span-2 text-zinc-500 ${choice ? "pl-6" : ""}`}
                >
                  {p.purpose}
                </span>
              )}
            </li>
          );
        })}
        <li className="grid grid-cols-[1fr_auto] items-start gap-x-3">
          <b className="font-medium">Header and footer</b>
          <Pill tone={chrome === "design" ? ACTION.update[1] : ACTION.keep[1]}>
            {chrome !== "design"
              ? "Keep"
              : chromeMode === "design"
                ? "Designed by the AI"
                : chromeMode === "standard"
                  ? "Standard design"
                  : "New"}
          </Pill>
        </li>
      </ul>
    </>
  );
}

function AnalysisStep({
  analysis,
  result,
  statusOf,
  pagesNow,
  onTogglePage,
  onRetry,
}: {
  analysis: Analysis;
  result: SetupPlan | null;
  statusOf: (q: SetupGroup) => "ask" | "later";
  pagesNow: Set<string>;
  onTogglePage: (address: string) => void;
  onRetry: () => void;
}) {
  const heading = (
    <>
      <h2
        id="setup-step-title"
        className="mt-1 text-2xl font-semibold tracking-tight"
      >
        {result ? "Here's the plan" : "Planning your site"}
      </h2>
      <p className="mt-2 text-sm text-zinc-500">
        {result
          ? "What the AI understood, the pages it will make, and what it still needs to ask you."
          : "The AI reads what you told it, looks at the website you gave or at similar businesses, plans your pages and writes the questions it still needs: at most 5."}
      </p>
    </>
  );
  if (analysis.state === "failed") {
    return (
      <>
        {heading}
        <div className="mt-5 grid gap-3">
          <ErrorText error={analysis.error} />
          <Button onClick={onRetry} className="justify-self-start px-4 py-2">
            Try again
          </Button>
        </div>
      </>
    );
  }
  if (!result) {
    const phase = analysis.state === "running" ? analysis.phase : 0;
    return (
      <>
        {heading}
        <ol className="mt-6 grid gap-3 text-sm">
          {PHASES.map((p, i) => (
            <li
              key={p}
              className={`flex items-center gap-3 ${i > phase ? "text-zinc-400" : ""}`}
            >
              <span className="grid size-5 place-items-center">
                {i < phase ? (
                  <span className="grid size-5 place-items-center rounded-full bg-emerald-500 text-xs text-white">
                    ✓
                  </span>
                ) : i === phase ? (
                  <Spinner />
                ) : (
                  <span className="size-2 rounded-full bg-zinc-300 dark:bg-zinc-700" />
                )}
              </span>
              <span className={i === phase ? "font-medium" : ""}>{p}</span>
            </li>
          ))}
        </ol>
      </>
    );
  }
  const asking = result.questions.filter((q) => statusOf(q) === "ask");
  const later = result.questions.filter((q) => statusOf(q) === "later");
  const looked = result.fetched
    ? `It read the website you gave${result.searched ? " and searched the web" : ""}.`
    : result.searched
      ? "It looked at similar websites."
      : null;
  return (
    <>
      {heading}
      <div className="mt-5 grid gap-3 text-sm">
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <h3 className="font-semibold">What it understood</h3>
          <p className="mt-1">
            <b>{result.label}</b> website{" "}
            <span className="text-zinc-500">({result.confidence})</span>
          </p>
          {result.known.length > 0 && (
            <dl className="mt-1.5 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-0.5">
              {result.known.map((k) => (
                <div key={k.label} className="contents">
                  <dt className="text-zinc-500">{k.label}</dt>
                  <dd>{k.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {(looked || result.findings.length > 0) && (
            <>
              {looked && <p className="mt-2 text-zinc-500">{looked}</p>}
              <ul className="mt-1 grid list-disc gap-1 pl-5">
                {result.findings.map((f, i) => (
                  <li key={i}>
                    {f.text}{" "}
                    {f.changes && (
                      <span className="text-zinc-500">→ {f.changes}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.by === "keywords" && (
            <p className="mt-2 text-zinc-500">
              The AI wasn&apos;t available, so our guide for this kind of
              business made the plan.
            </p>
          )}
        </div>
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <h3 className="font-semibold">Your pages</h3>
          <PagesPlan
            pages={result.pages}
            chrome={result.chrome}
            pagesNow={pagesNow}
            onTogglePage={onTogglePage}
          />
        </div>
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <h3 className="font-semibold">
            {asking.length
              ? `Questions for you: ${asking.length}`
              : "No questions needed"}
          </h3>
          <ul className="mt-2 grid gap-2">
            {[...asking, ...later].map((q) => (
              <li
                key={q.id}
                className="grid grid-cols-[1fr_auto] items-start gap-x-3 gap-y-0.5"
              >
                <b className="font-medium">{q.title}</b>
                <Pill tone={STATUS[statusOf(q)][1]}>
                  {STATUS[statusOf(q)][0]}
                </Pill>
                {q.why && (
                  <span className="col-span-2 text-zinc-500">{q.why}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

function ReviewStep({
  name,
  what,
  brief,
  result,
  answers,
  logo,
  photos,
  statusOf,
  onChange,
  onAnswerNow,
  tab,
  onTab,
  preview,
  pagesNow,
  onTogglePage,
  chromeChoice,
  buttonLabel,
  onChangeChrome,
}: {
  name: string;
  what: string;
  brief: string;
  result: SetupPlan | null;
  answers: Record<string, AnswerValue>;
  logo: File | null;
  photos: File[];
  statusOf: (q: SetupGroup) => Status;
  onChange: (id: string) => void;
  onAnswerNow: (id: string) => void;
  tab: "pages" | "profile" | "config" | "request";
  onTab: (tab: "pages" | "profile" | "config" | "request") => void;
  preview: Preview | null;
  pagesNow: Set<string>;
  onTogglePage: (address: string) => void;
  /** The header and footer choices, when the site gets new ones. */
  chromeChoice: ChromeChoice | null;
  buttonLabel: string;
  onChangeChrome: () => void;
}) {
  const missing = (
    <span className="text-amber-700 dark:text-amber-300">Not given</span>
  );
  const tabs = {
    pages: ["Pages", "What Claude makes, rewrites or keeps"],
    profile: [
      "Site profile",
      "knowledge/notes.md: Claude reads it before every request",
    ],
    config: [
      "Site details",
      "site.config.json: name, contact details and links",
    ],
    request: ["Build request", "Sent to Ask Claude once your site opens"],
  } as const;
  const tabText = !preview
    ? ""
    : tab === "config"
      ? JSON.stringify(preview.config, null, 2)
      : tab === "profile"
        ? preview.profile
        : preview.request;
  return (
    <>
      <h2
        id="setup-step-title"
        className="mt-1 text-2xl font-semibold tracking-tight"
      >
        Check your answers
      </h2>
      <p className="mt-2 text-sm text-zinc-500">
        Everything below is saved into your new site, then Claude builds it.
      </p>
      <div className="mt-5 grid gap-2.5 text-sm">
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">The basics</h3>
            <button
              type="button"
              onClick={() => onChange("basics")}
              className="ml-auto text-xs text-zinc-500 underline"
            >
              Change
            </button>
          </div>
          <dl className="mt-1 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5">
            <dt className="text-zinc-500">Name</dt>
            <dd>{name.trim() || "My Website (name it later)"}</dd>
            <dt className="text-zinc-500">What you do</dt>
            <dd>{what.trim() || missing}</dd>
            <dt className="text-zinc-500">Brief</dt>
            <dd>{brief ? `${wordCount(brief)} words` : "Skipped"}</dd>
            <dt className="text-zinc-500">Kind of website</dt>
            <dd>{result?.label ?? "Worked out from your answers"}</dd>
          </dl>
        </div>
        {(result?.questions ?? []).map((q) => {
          const status = statusOf(q);
          const rows = q.fields
            .map(
              (f) =>
                [
                  f,
                  f.type === "logo"
                    ? logo
                      ? logo.name
                      : undefined
                    : f.type === "photos"
                      ? photos.length
                        ? `${photos.length} photo${photos.length === 1 ? "" : "s"}`
                        : undefined
                      : answers[f.id] !== undefined
                        ? asText(answers[f.id])
                        : undefined,
                ] as const,
            )
            .filter(([, v]) => v);
          return (
            <div
              key={q.id}
              className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{q.title}</h3>
                {status !== "ask" && (
                  <Pill tone={STATUS[status][1]}>{STATUS[status][0]}</Pill>
                )}
                <button
                  type="button"
                  onClick={() =>
                    status === "later" ? onAnswerNow(q.id) : onChange(q.id)
                  }
                  className="ml-auto text-xs text-zinc-500 underline"
                >
                  {status === "ask" ? "Change" : "Answer it now"}
                </button>
              </div>
              {rows.length > 0 && (
                <dl className="mt-1 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5">
                  {rows.map(([f, v]) => (
                    <div key={f.id} className="contents">
                      <dt className="text-zinc-500">
                        {f.label.replace(/ \((optional|pick any)\)$/, "")}
                      </dt>
                      <dd className="wrap-break-word">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          );
        })}
        {chromeChoice && (
          <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">Header and footer</h3>
              <button
                type="button"
                onClick={onChangeChrome}
                className="ml-auto text-xs text-zinc-500 underline"
              >
                Change
              </button>
            </div>
            <dl className="mt-1 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5">
              <dt className="text-zinc-500">Design</dt>
              <dd>
                {chromeChoice.mode === "design"
                  ? "Designed by the AI"
                  : "Standard design"}
              </dd>
              <dt className="text-zinc-500">Menu</dt>
              <dd>
                {chromeChoice.menu
                  .filter((m) => m.on)
                  .map((m) => m.label)
                  .join(", ") || "No links"}
              </dd>
              <dt className="text-zinc-500">Header button</dt>
              <dd>{chromeChoice.button === "none" ? "None" : buttonLabel}</dd>
              <dt className="text-zinc-500">Footer shows</dt>
              <dd>{footerList(chromeChoice) || "Only its links"}</dd>
              <dt className="text-zinc-500">Footer columns</dt>
              <dd>
                {chromeChoice.columns.map((c) => c.title).join(", ") || "None"}
              </dd>
            </dl>
          </div>
        )}
      </div>
      <div
        role="tablist"
        className="mt-5 grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1 text-xs sm:grid-cols-4 dark:bg-zinc-900"
      >
        {(Object.keys(tabs) as (keyof typeof tabs)[]).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => onTab(id)}
            className={`rounded-md px-2 py-1.5 ${tab === id ? "bg-background font-semibold shadow-sm" : "text-zinc-500"}`}
          >
            {tabs[id][0]}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-500">{tabs[tab][1]}</p>
      {tab === "pages" ? (
        result?.pages.length ? (
          <div className="mt-1 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <PagesPlan
              pages={result.pages}
              chrome={result.chrome}
              chromeMode={chromeChoice?.mode}
              pagesNow={pagesNow}
              onTogglePage={onTogglePage}
            />
          </div>
        ) : (
          <p className="mt-1 text-sm text-zinc-500">
            No plan yet: Claude designs your homepage and asks what else you
            need.
          </p>
        )
      ) : (
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
          {tabText || "Preparing…"}
        </pre>
      )}
    </>
  );
}

/** What the footer shows, in words. */
function footerList(choice: ChromeChoice) {
  return [
    choice.tagline && "a short description",
    choice.contact && "contact details and hours",
    choice.social && "social links",
    choice.cta && choice.button !== "none" && "a call to action",
  ]
    .filter(Boolean)
    .join(", ");
}

/** A row of choices that look like a segmented control (radio buttons underneath). */
function Segments<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string;
  name: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1 text-xs font-medium text-zinc-500">
        {label}
      </legend>
      <div className="flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-900">
        {options.map((o) => (
          <label
            key={o.id}
            className="flex-1 cursor-pointer whitespace-nowrap rounded-md px-2 py-1.5 text-center text-xs text-zinc-500 has-checked:bg-background has-checked:font-semibold has-checked:text-foreground has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-foreground/30"
          >
            <input
              type="radio"
              name={name}
              checked={value === o.id}
              onChange={() => onChange(o.id)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A small square button for moving or removing a row. */
function RowButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid size-8 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-zinc-900"
    >
      {children}
    </button>
  );
}

const HEX = /^#[0-9a-f]{6}$/i;
const moved = <T,>(list: T[], index: number, by: number) => {
  const next = [...list];
  const to = index + by;
  if (to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to], next[index]];
  return next;
};

/**
 * The header and footer, in three tabs beside a live preview: the colour (presets or the owner's own,
 * with a check that white text reads on it), the header (logo, look, menu links, button, scrolling)
 * and the footer (look, the business's own column, link columns, the strip above it, the copyright
 * line). "Use the default design" takes the defaults and moves on; clicking a part of the preview
 * opens its controls. The AI's own design stays a choice at the end.
 */
function ChromeStep({
  choice,
  onChange,
  buttons,
  onButton,
  preview,
  logo,
  onLogo,
  favicon,
  onFavicon,
  onError,
  onUseDefault,
}: {
  choice: ChromeChoice;
  onChange: (patch: Partial<ChromeChoice>) => void;
  buttons: ButtonOption[];
  onButton: (button: HeaderButton) => void;
  preview: ChromePreviewData;
  logo: File | null;
  onLogo: (file: File | null) => void;
  favicon: File | null;
  onFavicon: (file: File | null) => void;
  onError: (error: Error | null) => void;
  onUseDefault: () => void;
}) {
  const [tab, setTab] = useState<"colour" | "header" | "footer">("colour");
  const [hex, setHex] = useState(choice.accent);
  const [newLink, setNewLink] = useState({ label: "", url: "" });
  // A control to bring into view once its tab has rendered (a click in the preview): the id waits in
  // a ref, and bumping `jump` runs the effect that shows it.
  const focus = useRef<string | null>(null);
  const [jump, setJump] = useState(0);
  useEffect(() => {
    const id = focus.current;
    focus.current = null;
    if (!id) return;
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      (
        el.querySelector(
          "input:not([type=checkbox])",
        ) as HTMLInputElement | null
      )?.focus({ preventScroll: true });
      el.animate(
        [
          { boxShadow: "0 0 0 3px rgb(245 158 11)" },
          { boxShadow: "0 0 0 0 transparent" },
        ],
        { duration: 1200 },
      );
    }
  }, [jump, tab]);

  function onPick(pick: PreviewPick) {
    const where: Record<
      PreviewPick["kind"],
      ["colour" | "header" | "footer", string]
    > = {
      logo: ["header", "chrome-logo"],
      menu: ["header", `chrome-menu-${pick.id}`],
      button: ["header", "chrome-button"],
      column: ["footer", `chrome-col-${pick.id}`],
      brand: ["footer", "chrome-business"],
      cta: ["footer", "chrome-strip"],
      copyright: ["footer", "chrome-copyright"],
    };
    const [nextTab, id] = where[pick.kind];
    focus.current = id;
    setTab(nextTab);
    setJump((n) => n + 1);
  }

  const setMenu = (menu: MenuEntry[]) => onChange({ menu });
  const setColumns = (columns: FooterColumn[]) => onChange({ columns });
  const setColumn = (id: string, patch: Partial<FooterColumn>) =>
    setColumns(
      choice.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    );
  const addLink = () => {
    if (!newLink.label.trim() || choice.menu.length >= MAX_MENU_ITEMS) return;
    setMenu([
      ...choice.menu,
      {
        id: newId("m"),
        label: newLink.label.trim(),
        url: newLink.url.trim() || "/",
        on: true,
      },
    ]);
    setNewLink({ label: "", url: "" });
  };
  const ratio = HEX.test(choice.accent) ? contrastWithWhite(choice.accent) : 21;
  const isDefault =
    choice.menu.every((m) => m.on && m.page) &&
    !(Object.keys(DEFAULT_CHROME) as (keyof ChromeChoice)[]).some(
      (k) =>
        k !== "button" &&
        k !== "menu" &&
        k !== "columns" &&
        choice[k] !== DEFAULT_CHROME[k],
    );
  const sectionTitle = "mt-6 text-sm font-semibold";
  const hint = "mt-1 text-xs text-zinc-500";
  const small = `${inputClass} py-1.5 text-sm`;
  const check = (
    key:
      | "sticky"
      | "shrink"
      | "transparent"
      | "tagline"
      | "contact"
      | "social"
      | "cta",
    label: string,
    note?: string,
  ) => (
    <label className="mt-2 flex cursor-pointer items-start gap-2.5 text-sm">
      <input
        type="checkbox"
        checked={choice[key]}
        onChange={(e) => onChange({ [key]: e.target.checked })}
        className="mt-0.5 size-4 shrink-0"
      />
      <span>
        {label}
        {note && <span className="block text-xs text-zinc-500">{note}</span>}
      </span>
    </label>
  );

  return (
    <>
      <h2
        id="setup-step-title"
        className="mt-1 text-2xl font-semibold tracking-tight"
      >
        Your header and footer
      </h2>
      <p className="mt-2 text-sm text-zinc-500">
        They&apos;re on every page. Make them yours here, or use the default
        design. You can change all of it later on Look &amp; logo.
      </p>

      <div className="mt-5">
        <ChromePreview data={preview} choice={choice} onPick={onPick} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-zinc-50 p-3 dark:bg-zinc-900/60">
        <p className="min-w-0 flex-1 text-sm text-zinc-600 dark:text-zinc-400">
          {isDefault
            ? "This is the default design: a clean, modern look."
            : "Happy with the default? It's one click away."}
        </p>
        <Button variant="primary" onClick={onUseDefault} className="px-4 py-2">
          Use the default design
        </Button>
      </div>

      <div
        role="tablist"
        aria-label="Header and footer settings"
        className="sticky top-0 z-10 mt-5 flex gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-900"
      >
        {(
          [
            ["colour", "Colour"],
            ["header", "Header"],
            ["footer", "Footer"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex-1 rounded-lg px-2 py-2 text-sm font-semibold ${tab === id ? "bg-background shadow-sm" : "text-zinc-500"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "colour" && (
        <section aria-label="Your colour">
          <p className={sectionTitle}>Your colour</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {ACCENTS.map((a) => (
              <button
                key={a.hex}
                type="button"
                title={a.name}
                aria-label={a.name}
                aria-pressed={choice.accent === a.hex}
                onClick={() => {
                  onChange({ accent: a.hex });
                  setHex(a.hex);
                }}
                className="rounded-full p-0.5 ring-2 ring-transparent aria-pressed:ring-foreground"
              >
                <span
                  className="block size-8 rounded-full"
                  style={{ background: a.hex }}
                />
              </button>
            ))}
          </div>
          <div
            className={`mt-3 gap-3 space-y-2 rounded-xl border p-2.5 ${ACCENTS.some((a) => a.hex === choice.accent) ? "border-zinc-200 dark:border-zinc-800" : "border-foreground"}`}
          >
            <div className="flex gap-4 items-center">
              <input
                type="color"
                value={HEX.test(choice.accent) ? choice.accent : "#0f766e"}
                onChange={(e) => {
                  onChange({ accent: e.target.value });
                  setHex(e.target.value);
                }}
                aria-label="Pick your own colour"
                className="size-10 shrink-0 cursor-pointer rounded-lg border-0 bg-transparent p-0"
              />
              <span className="min-w-0 flex-1 text-sm">
                <b className="font-medium">Your own colour</b>
                <span className="block text-xs text-zinc-500">
                  Your brand&apos;s exact colour, or anything you like
                </span>
              </span>
            </div>
            <input
              value={hex}
              maxLength={7}
              spellCheck={false}
              aria-label="Colour as a hex code"
              onChange={(e) => {
                const value = e.target.value
                  .trim()
                  .replace(/^([^#])/, "#$1")
                  .toLowerCase();
                setHex(value);
                if (HEX.test(value)) onChange({ accent: value });
              }}
              className={`${small} w-28 font-mono`}
            />
          </div>
          <p className="mt-2 flex items-center gap-2 text-xs">
            <span
              className="shrink-0 whitespace-nowrap rounded-full px-3 py-1 font-semibold text-white"
              style={{ background: choice.accent }}
            >
              {buttons.find((b) => b.id === choice.button)?.label ?? "Button"}
            </span>
            {ratio >= 4.5 ? (
              <span className="text-emerald-700 dark:text-emerald-400">
                ✓ White text reads well on it.
              </span>
            ) : (
              <span className="text-amber-700 dark:text-amber-300">
                White text is hard to read on this colour ({ratio.toFixed(1)}
                :1). Pick a darker shade.
              </span>
            )}
          </p>
          <p className={hint}>
            Used for buttons and highlights across your site, and by the AI when
            it designs your pages.
          </p>
        </section>
      )}

      {tab === "header" && (
        <section aria-label="Header">
          <div id="chrome-logo" className="rounded-xl">
            <p className={sectionTitle}>Logo</p>
            <div className="mt-2">
              <Segments
                label="Show"
                name="chrome-logo"
                value={choice.logo}
                onChange={(logoMode) => onChange({ logo: logoMode })}
                options={[
                  { id: "mark", label: "Mark and name" },
                  { id: "name", label: "Name only" },
                  { id: "image", label: "Your logo" },
                ]}
              />
            </div>
            <div className="mt-3">
              <LogoAndIcon
                name={preview.name}
                accent={choice.accent}
                logo={logo}
                onLogo={(file) => {
                  onLogo(file);
                  // A logo chosen here is the one the header shows.
                  if (file) onChange({ logo: "image" });
                }}
                favicon={favicon}
                onFavicon={onFavicon}
                onError={onError}
              />
            </div>
            {choice.logo === "image" && !logo && <p className={hint}>Until you add a logo, your name shows.</p>}
          </div>

          <p className={sectionTitle}>Look</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <Segments
              label="Colour"
              name="chrome-header-theme"
              value={choice.headerTheme}
              onChange={(headerTheme) => onChange({ headerTheme })}
              options={[
                { id: "light", label: "Light" },
                { id: "dark", label: "Dark" },
                { id: "brand", label: "Colour" },
              ]}
            />
            <Segments
              label="Style"
              name="chrome-header-style"
              value={choice.headerStyle}
              onChange={(headerStyle) => onChange({ headerStyle })}
              options={[
                { id: "floating", label: "Floating" },
                { id: "bar", label: "Wide" },
              ]}
            />
            <Segments
              label="Menu"
              name="chrome-header-layout"
              value={choice.headerLayout}
              onChange={(headerLayout) => onChange({ headerLayout })}
              options={[
                { id: "left", label: "Left" },
                { id: "center", label: "Centre" },
                { id: "right", label: "Right" },
              ]}
            />
          </div>

          <p className={sectionTitle}>Menu</p>
          <p className={hint}>
            Rename, reorder or hide links; your pages are listed for you. Click
            a link in the preview to jump to it.
          </p>
          <div className="mt-2 grid gap-1.5">
            {choice.menu.map((m, i) => (
              <div
                key={m.id}
                id={`chrome-menu-${m.id}`}
                className={`flex items-center gap-1 rounded-lg ${m.on ? "" : "opacity-60"}`}
              >
                <input
                  type="checkbox"
                  checked={m.on}
                  onChange={(e) =>
                    setMenu(
                      choice.menu.map((x) =>
                        x.id === m.id ? { ...x, on: e.target.checked } : x,
                      ),
                    )
                  }
                  aria-label={`Show ${m.label}`}
                  className="mx-1.5 size-4 shrink-0"
                />
                <input
                  value={m.label}
                  maxLength={60}
                  onChange={(e) =>
                    setMenu(
                      choice.menu.map((x) =>
                        x.id === m.id ? { ...x, label: e.target.value } : x,
                      ),
                    )
                  }
                  aria-label={`Menu link ${i + 1}`}
                  className={small}
                />
                {m.page && (
                  <span className="shrink-0 rounded border border-zinc-200 px-1.5 text-[10px] text-zinc-500 dark:border-zinc-800">
                    page
                  </span>
                )}
                <RowButton
                  label="Move up"
                  disabled={i === 0}
                  onClick={() => setMenu(moved(choice.menu, i, -1))}
                >
                  ↑
                </RowButton>
                <RowButton
                  label="Move down"
                  disabled={i === choice.menu.length - 1}
                  onClick={() => setMenu(moved(choice.menu, i, 1))}
                >
                  ↓
                </RowButton>
                {m.page ? (
                  <span className="size-8 shrink-0" />
                ) : (
                  <RowButton
                    label={`Remove ${m.label}`}
                    onClick={() =>
                      setMenu(choice.menu.filter((x) => x.id !== m.id))
                    }
                  >
                    ✕
                  </RowButton>
                )}
              </div>
            ))}
            {!choice.menu.length && (
              <p className="text-xs text-zinc-500">
                No pages besides your homepage yet: add a link of your own
                below.
              </p>
            )}
          </div>
          {choice.menu.length < MAX_MENU_ITEMS && (
            <div className="mt-2 flex gap-1.5">
              <input
                value={newLink.label}
                onChange={(e) =>
                  setNewLink({ ...newLink, label: e.target.value })
                }
                onKeyDown={(e) =>
                  e.key === "Enter" && (e.preventDefault(), addLink())
                }
                maxLength={60}
                placeholder="Link text, e.g. Catering"
                aria-label="New link's text"
                className={small}
              />
              <input
                value={newLink.url}
                onChange={(e) =>
                  setNewLink({ ...newLink, url: e.target.value })
                }
                onKeyDown={(e) =>
                  e.key === "Enter" && (e.preventDefault(), addLink())
                }
                placeholder="Address or web link"
                aria-label="New link's address"
                className={small}
              />
              <Button
                onClick={addLink}
                disabled={!newLink.label.trim()}
                className="shrink-0 px-3 py-1.5 text-sm"
              >
                Add
              </Button>
            </div>
          )}

          <fieldset
            id="chrome-button"
            className="mt-6 grid gap-2 rounded-xl sm:grid-cols-2"
          >
            <legend className="mb-2 text-sm font-semibold">Button</legend>
            {buttons.map((b) => (
              <label
                key={b.id}
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 p-2.5 transition-colors has-checked:border-foreground has-focus-visible:ring-2 has-focus-visible:ring-foreground/30 dark:border-zinc-800"
              >
                <input
                  type="radio"
                  name="chrome-button"
                  checked={choice.button === b.id}
                  onChange={() => onButton(b.id)}
                  className="mt-1 size-4 shrink-0"
                />
                <span className="min-w-0 text-sm">
                  <b className="font-medium">{b.label}</b>
                  <span className="mt-0.5 block wrap-break-word text-xs text-zinc-500">
                    {b.note}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {choice.button === "custom" && (
            <div className="mt-2 flex gap-1.5">
              <input
                value={choice.customLabel}
                maxLength={24}
                onChange={(e) => onChange({ customLabel: e.target.value })}
                placeholder="Button text, e.g. Order online"
                aria-label="Button text"
                className={small}
              />
              <input
                value={choice.customUrl}
                onChange={(e) => onChange({ customUrl: e.target.value })}
                placeholder="Link"
                aria-label="Button link"
                className={small}
              />
            </div>
          )}

          <p className={sectionTitle}>When visitors scroll</p>
          {check("sticky", "Keep the header at the top")}
          {check(
            "shrink",
            "Make it slimmer once they scroll",
            "Try “Scrolled” above the preview.",
          )}
          {check(
            "transparent",
            "See-through over the top of the page",
            "It turns solid once they scroll.",
          )}
        </section>
      )}

      {tab === "footer" && (
        <section aria-label="Footer">
          <p className={sectionTitle}>Look</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Segments
              label="Colour"
              name="chrome-footer-theme"
              value={choice.footerTheme}
              onChange={(footerTheme) => onChange({ footerTheme })}
              options={[
                { id: "dark", label: "Dark" },
                { id: "light", label: "Light" },
                { id: "brand", label: "Colour" },
              ]}
            />
            <Segments
              label="Layout"
              name="chrome-footer-layout"
              value={choice.footerLayout}
              onChange={(footerLayout) => onChange({ footerLayout })}
              options={[
                { id: "columns", label: "Columns" },
                { id: "centered", label: "Centred" },
                { id: "minimal", label: "Minimal" },
              ]}
            />
          </div>

          <div id="chrome-business" className="rounded-xl">
            <p className={sectionTitle}>Your business</p>
            <p className={hint}>The first column: your name and these.</p>
            {check("tagline", "A short description")}
            {check("contact", "Contact details and opening hours")}
            {check("social", "Links to your social media")}
          </div>

          <p className={sectionTitle}>Link columns</p>
          <p className={hint}>
            Rename, reorder or remove links; up to {MAX_FOOTER_COLUMNS} columns.
            Click a column in the preview to jump to it.
          </p>
          {choice.columns.map((col, ci) => (
            <div
              key={col.id}
              id={`chrome-col-${col.id}`}
              className="mt-2.5 rounded-xl border border-zinc-200 p-2.5 dark:border-zinc-800"
            >
              <div className="flex items-center gap-1">
                <input
                  value={col.title}
                  maxLength={60}
                  onChange={(e) => setColumn(col.id, { title: e.target.value })}
                  aria-label={`Column ${ci + 1} heading`}
                  className={`${small} font-semibold`}
                />
                <RowButton
                  label="Move left"
                  disabled={ci === 0}
                  onClick={() => setColumns(moved(choice.columns, ci, -1))}
                >
                  ←
                </RowButton>
                <RowButton
                  label="Move right"
                  disabled={ci === choice.columns.length - 1}
                  onClick={() => setColumns(moved(choice.columns, ci, 1))}
                >
                  →
                </RowButton>
                <RowButton
                  label={`Remove the ${col.title || "untitled"} column`}
                  onClick={() =>
                    setColumns(choice.columns.filter((c) => c.id !== col.id))
                  }
                >
                  ✕
                </RowButton>
              </div>
              {col.auto && (
                <p className="mx-0.5 mt-1.5 text-xs text-zinc-500">
                  Lists your pages by itself: Home
                  {preview.pages.map((p) => `, ${p}`).join("")}.
                </p>
              )}
              <div className="mt-1.5 grid gap-1.5">
                {col.links.map((link, li) => (
                  <div key={li} className="flex items-center gap-1">
                    <input
                      value={link.label}
                      maxLength={60}
                      onChange={(e) =>
                        setColumn(col.id, {
                          links: col.links.map((l, j) =>
                            j === li ? { ...l, label: e.target.value } : l,
                          ),
                        })
                      }
                      aria-label={`Link ${li + 1} text`}
                      className={small}
                    />
                    <input
                      value={link.url}
                      onChange={(e) =>
                        setColumn(col.id, {
                          links: col.links.map((l, j) =>
                            j === li ? { ...l, url: e.target.value } : l,
                          ),
                        })
                      }
                      aria-label={`Link ${li + 1} address`}
                      placeholder="Address or web link"
                      className={small}
                    />
                    <RowButton
                      label="Move up"
                      disabled={li === 0}
                      onClick={() =>
                        setColumn(col.id, { links: moved(col.links, li, -1) })
                      }
                    >
                      ↑
                    </RowButton>
                    <RowButton
                      label="Move down"
                      disabled={li === col.links.length - 1}
                      onClick={() =>
                        setColumn(col.id, { links: moved(col.links, li, 1) })
                      }
                    >
                      ↓
                    </RowButton>
                    <RowButton
                      label="Remove link"
                      onClick={() =>
                        setColumn(col.id, {
                          links: col.links.filter((_, j) => j !== li),
                        })
                      }
                    >
                      ✕
                    </RowButton>
                  </div>
                ))}
              </div>
              {col.links.length < 12 && (
                <button
                  type="button"
                  onClick={() =>
                    setColumn(col.id, {
                      links: [...col.links, { label: "New link", url: "/" }],
                    })
                  }
                  className="mt-2 text-sm underline"
                >
                  + Add a link
                </button>
              )}
            </div>
          ))}
          {choice.columns.length < MAX_FOOTER_COLUMNS ? (
            <Button
              onClick={() =>
                setColumns([
                  ...choice.columns,
                  {
                    id: newId("c"),
                    title: "New column",
                    links: [{ label: "A link", url: "/" }],
                  },
                ])
              }
              className="mt-2.5 px-3 py-1.5 text-sm"
            >
              + Add a column
            </Button>
          ) : (
            <p className={hint}>That&apos;s the most a footer holds neatly.</p>
          )}

          <div id="chrome-strip" className="rounded-xl">
            <p className={sectionTitle}>Above and below</p>
            {check(
              "cta",
              "A call to action above the footer",
              choice.button === "none"
                ? "Uses the header's button, so pick one on the Header tab."
                : undefined,
            )}
          </div>
          <label
            id="chrome-copyright"
            className="mt-3 block rounded-xl text-sm"
          >
            <span className="font-medium">Copyright line</span>
            <input
              value={choice.copyright}
              maxLength={120}
              onChange={(e) => onChange({ copyright: e.target.value })}
              placeholder={`${preview.name || "Your site"}. All rights reserved.`}
              className={`${small} mt-1`}
            />
          </label>
        </section>
      )}

      <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl border border-dashed border-zinc-300 p-3 has-checked:border-solid has-checked:border-foreground dark:border-zinc-700">
        <input
          type="checkbox"
          checked={choice.mode === "design"}
          onChange={(e) =>
            onChange({ mode: e.target.checked ? "design" : "standard" })
          }
          className="mt-0.5 size-4 shrink-0"
        />
        <span className="text-sm">
          <b className="font-medium">
            Have the AI design a one-of-a-kind header and footer instead
          </b>
          <span className="mt-0.5 block text-zinc-500">
            Made to match your homepage, keeping your colour, menu, button and
            footer choices. Adds a few minutes to the build.
          </span>
        </span>
      </label>
    </>
  );
}
