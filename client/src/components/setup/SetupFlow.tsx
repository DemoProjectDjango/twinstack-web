"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MIN_BRIEF_WORDS,
  hoursText,
  readText,
  setupBody,
  wordCount,
  type AnswerValue,
  type HoursRow,
  type Item,
  type PageAction,
  type PagePlan,
  type SetupAnswers,
  type SetupGroup,
  type SetupPlan,
  type Skill,
} from "@/lib/setup";
import { SetupFields } from "./SetupFields";
import { Button, ErrorText, Spinner, inputClass } from "../site/ui";

// A new site's setup, in a modal: what the business does, a brief for the website, then the AI's
// analysis (POST /api/setup/plan): it reads any web address the owner gave or looks at similar
// businesses, plans the pages (each to create, rewrite or keep, and the header and footer) and writes
// the questions for this business, at most 5 to ask now. Then those questions, and a review of what
// gets saved and built. Every step can be skipped. Under the first steps, a line says what the AI has
// understood so far.
// Create a new site (CreateSite.tsx) shows it inside its own window (embedded) before the site
// exists; the editor (FirstRunSetup.tsx) shows it, with the name as its first step, for a site that
// opened without answers.

type Step = "name" | "what" | "brief" | "analysis" | "review" | `q:${string}`;
type Analysis =
  | { state: "idle" }
  | { state: "running"; phase: number; signature: string }
  | { state: "failed"; signature: string; error: unknown }
  | { state: "done"; signature: string; result: SetupPlan };
type Preview = { config: unknown; profile: string; request: string };
type Status = "ask" | "later" | "skipped";

const PHASES = ["Reading what you told it", "Looking at the web", "Planning your pages", "Writing your questions"];
const STATUS: Record<Status, [string, string]> = {
  ask: ["Will ask", "bg-foreground text-background"],
  later: ["Claude asks later", "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300"],
  skipped: ["Skipped: Claude asks later", "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300"],
};
const ACTION: Record<PageAction, [string, string]> = {
  create: ["New page", "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"],
  update: ["Rewrite", "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300"],
  keep: ["Keep", "bg-zinc-100 text-zinc-500 dark:bg-zinc-900"],
};
// A brief may be a web address to work from ("Rebuild https://…") rather than ten words.
const HAS_URL = /https?:\/\/\S+|www\.\S+\.\S+/i;
const briefOk = (text: string) => wordCount(text) >= MIN_BRIEF_WORDS || HAS_URL.test(text);

async function call<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? data.error ?? `The server answered ${res.status}.`);
  return data as T;
}

function asText(value: AnswerValue): string {
  if (!Array.isArray(value)) return value;
  if (!value.length) return "";
  if (typeof value[0] === "string") return (value as string[]).join(", ");
  if ("day" in (value[0] as object)) return hoursText(value as HoursRow[]);
  return (value as Item[]).filter((i) => i.name).map((i) => i.name).join(", ");
}

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{children}</span>;
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
  const [readAfter, setReadAfter] = useState<"name" | "what" | "brief" | null>(givenName.trim() ? "name" : null);
  const [analysis, setAnalysis] = useState<Analysis>({ state: "idle" });
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [fromBrief, setFromBrief] = useState<Set<string>>(new Set());
  const [logo, setLogo] = useState<File | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  // Questions planned for later that the owner chose to answer now.
  const [extraAsk, setExtraAsk] = useState<Set<string>>(new Set());
  const [step, setStep] = useState(0);
  const [tab, setTab] = useState<"pages" | "profile" | "config" | "request">("pages");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    call<{ skills: Skill[] }>("/api/setup/skills")
      .then((data) => setSkills(data.skills))
      .catch(() => setSkills([]));
  }, []);

  const signature = `${name}\n${what}\n${brief}`;
  const result = analysis.state === "done" && analysis.signature === signature ? analysis.result : null;
  const live = useMemo(() => {
    const text = readAfter === "name" ? name : readAfter === "what" ? `${name} ${what}` : `${name} ${what} ${brief}`;
    return readText(skills, text);
  }, [skills, readAfter, name, what, brief]);

  // The AI's questions: those it asks now, in its order, then the later ones the owner chose to answer now.
  const questions: SetupGroup[] = result?.questions ?? [];
  const statusOf = (q: SetupGroup): "ask" | "later" => (q.status === "ask" || extraAsk.has(q.id) ? "ask" : "later");
  const asked = questions.filter((q) => statusOf(q) === "ask");
  const steps: Step[] = [...(askName ? (["name"] as const) : []), "what", "brief", "analysis", ...asked.map((q) => `q:${q.id}` as const), "review"];
  const current = steps[Math.min(step, steps.length - 1)];
  const group = current.startsWith("q:") ? questions.find((q) => q.id === current.slice(2)) : undefined;

  // The analysis runs on reaching its step, again whenever the name, what you do or the brief changed
  // (`texts`: what they are as the step is reached, a skipped brief already cleared). The latest
  // request wins; the phases tick on while it runs.
  const request = useRef(0);
  const ticker = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => () => clearInterval(ticker.current), []);
  function runAnalysis(texts: { name: string; what: string; brief: string }, force = false) {
    const sig = `${texts.name}\n${texts.what}\n${texts.brief}`;
    if (!force && (analysis.state === "running" || analysis.state === "done") && analysis.signature === sig) return;
    const id = ++request.current;
    setAnalysis({ state: "running", phase: 0, signature: sig });
    clearInterval(ticker.current);
    ticker.current = setInterval(() => setAnalysis((a) => (a.state === "running" && a.phase < PHASES.length - 1 ? { ...a, phase: a.phase + 1 } : a)), 3000);
    call<SetupPlan>(planUrl, { name: texts.name, what: texts.what, brief: briefOk(texts.brief) ? texts.brief : "" })
      .then((plan) => {
        if (id !== request.current) return;
        // New questions: new answers, starting from what the AI could fill in.
        setAnswers(plan.prefill);
        setFromBrief(new Set(Object.keys(plan.prefill)));
        setSkipped(new Set());
        setExtraAsk(new Set());
        setAnalysis({ state: "done", signature: sig, result: plan });
      })
      .catch((err) => id === request.current && setAnalysis({ state: "failed", signature: sig, error: err }))
      .finally(() => id === request.current && clearInterval(ticker.current));
  }

  const setup = (): SetupAnswers => ({
    name: name.trim(),
    what: what.trim(),
    brief: briefOk(brief) ? brief.trim() : "",
    type: result?.type ?? live.skill?.id ?? "generic",
    by: result?.by ?? "keywords",
    questions: questions.map((q) => ({ ...q, status: statusOf(q) })),
    answers,
    skipped: [...skipped].filter((id) => asked.some((q) => q.id === id)),
    pages: result?.pages ?? [],
    chrome: result?.chrome ?? "design",
    known: result?.known ?? [],
    findings: result?.findings ?? [],
    logo,
    photos,
  });

  // The review's preview of what gets saved, from the server's own composition.
  useEffect(() => {
    if (current !== "review") return;
    const timer = setTimeout(() => {
      call<Preview>("/api/setup/preview", setupBody(setup(), { logo: logo ? "/assets/img/brand/logo" : undefined, photos: photos.map((_, i) => `/assets/img/uploads/photo-${i + 1}`) }))
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, answers, skipped, extraAsk, logo, photos, name, what, brief, result]);

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
    if (group) setSkipped((s) => new Set([...s].filter((id) => id !== group.id)));
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
    const nextAsked = questions.filter((q) => q.id === id || statusOf(q) === "ask");
    go(steps.indexOf("analysis") + 1 + nextAsked.findIndex((q) => q.id === id));
  }

  const canContinue =
    current === "name" ? Boolean(name.trim()) : current === "what" ? Boolean(what.trim()) : current === "brief" ? briefOk(brief) : current === "analysis" ? Boolean(result) : !finishing;
  const questionIndex = group ? asked.indexOf(group) : -1;
  const skipLabel = current === "analysis" ? "Skip the questions" : group ? "Skip this question" : current === "review" ? null : "Skip";
  const known = Boolean(result) || current === "review";
  const briefWords = wordCount(brief);

  const body = (
    <>
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {Array.from({ length: known ? steps.length + 1 : step + 3 }, (_, i) => (
          <span key={i} className={`h-1 flex-1 rounded-full ${i <= step + 1 ? "bg-foreground" : "bg-zinc-200 dark:bg-zinc-800"}`} />
        ))}
      </div>
      <p className="mt-5 text-xs font-medium text-zinc-500">
        Step {step + 2}
        {known && ` of ${steps.length + 1}`}
        {questionIndex >= 0 && ` · Question ${questionIndex + 1} of ${asked.length}`}
      </p>

      {current === "name" && (
        <>
          <h2 id="setup-step-title" className="mt-1 text-2xl font-semibold tracking-tight">
            What&apos;s your business called?
          </h2>
          <p className="mt-2 text-sm text-zinc-500">It goes at the top of every page.</p>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Harbour Street Bakery" aria-label="Business name" className={`${inputClass} mt-5 py-3 text-base`} autoFocus />
        </>
      )}

      {current === "what" && (
        <>
          <h2 id="setup-step-title" className="mt-1 text-2xl font-semibold tracking-tight">
            What does {name.trim() || "your business"} do?
          </h2>
          <p className="mt-2 text-sm text-zinc-500">One or two sentences, the way you&apos;d tell a customer. It goes under your name on the homepage and in search results.</p>
          <textarea value={what} onChange={(e) => setWhat(e.target.value)} rows={3} maxLength={600} placeholder="A family bakery making sourdough, pastries and celebration cakes every morning." aria-label="What the business does" className={`${inputClass} mt-5 resize-none py-3 text-base`} autoFocus />
        </>
      )}

      {current === "brief" && (
        <>
          <h2 id="setup-step-title" className="mt-1 text-2xl font-semibold tracking-tight">
            Tell us about your website
          </h2>
          <p className="mt-2 text-sm text-zinc-500">Who it&apos;s for, the pages you want and the feel you&apos;re after. Have a website you like, or an old one to rebuild? Paste its address and the AI looks at it.</p>
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
            {HAS_URL.test(brief) ? "The AI will look at the address you gave." : briefWords >= MIN_BRIEF_WORDS ? `${briefWords} words. More detail gives the AI more to go on.` : `At least ${MIN_BRIEF_WORDS} words, or a web address: ${MIN_BRIEF_WORDS - briefWords} more words to go. Or skip it.`}
          </p>
        </>
      )}

      {current === "analysis" && <AnalysisStep analysis={analysis} result={result} statusOf={statusOf} onRetry={() => runAnalysis({ name, what, brief }, true)} />}

      {group && (
        <>
          <h2 id="setup-step-title" className="mt-1 text-2xl font-semibold tracking-tight">
            {group.title}
          </h2>
          {group.lead && <p className="mt-2 text-sm text-zinc-500">{group.lead}</p>}
          {skipped.has(group.id) && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">You skipped this. Answer it now, or Claude asks you later.</p>}
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
            photos={photos}
            onPhotos={setPhotos}
            onError={setError}
          />
        </>
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
          statusOf={(q) => (skipped.has(q.id) && statusOf(q) === "ask" ? "skipped" : statusOf(q))}
          onChange={(id) => go(steps.indexOf(id === "basics" ? "what" : (`q:${id}` as Step)))}
          onAnswerNow={answerNow}
          tab={tab}
          onTab={setTab}
          preview={preview}
        />
      )}

      {(current === "what" || current === "brief") && <AiRead readAfter={readAfter} live={live} />}
      <div className="mt-4">
        <ErrorText error={error} />
      </div>
      {current === "review" && finishNote && <p className="text-sm text-zinc-500">{finishNote}</p>}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {step > 0 || onBack ? (
          <Button onClick={() => (step > 0 ? go(step - 1) : onBack?.())} className="px-4 py-2" disabled={finishing}>
            Back
          </Button>
        ) : (
          <Button variant="ghost" onClick={onCancel} className="px-4 py-2 text-zinc-500">
            Cancel
          </Button>
        )}
        {skipLabel && !(current === "analysis" && analysis.state === "running") && (
          <Button variant="ghost" onClick={skip} className="ml-auto px-4 py-2 text-zinc-500">
            {skipLabel}
          </Button>
        )}
        <Button variant="primary" onClick={next} disabled={!canContinue} className={`px-5 py-2 ${skipLabel ? "" : "ml-auto"}`}>
          {finishing ? <Spinner /> : current === "review" ? finishLabel : current === "analysis" ? (asked.length ? `Answer ${asked.length} question${asked.length === 1 ? "" : "s"}` : "Continue") : "Continue"}
        </Button>
      </div>
    </>
  );

  // Inside Create a new site's own window, so the look doesn't change after the name.
  if (embedded) return body;
  return (
    // Scrolls as a whole when the window is taller than the screen (the review step can be).
    <div id="setup-flow" className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4 text-foreground backdrop-blur-[2px]">
      <div className="flex min-h-full items-center justify-center">
        <section role="dialog" aria-modal="true" aria-labelledby="setup-step-title" className="w-full max-w-lg rounded-xl border border-zinc-200 bg-background p-6 shadow-xl dark:border-zinc-800">
          <div className="mb-5 flex items-start gap-3">
            <h1 className="text-lg font-semibold">{title}</h1>
            <button type="button" onClick={onCancel} aria-label="Close" className="-mr-2 -mt-1 ml-auto grid size-8 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-900">
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
function AiRead({ readAfter, live }: { readAfter: "name" | "what" | "brief" | null; live: ReturnType<typeof readText> }) {
  if (!readAfter) return null;
  return (
    <p className="mt-4 rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400" aria-live="polite">
      <span className="font-semibold text-foreground">The AI understands: </span>
      {live.skill ? `a ${live.skill.label.toLowerCase()} website (${live.confidence})` : readAfter === "name" ? "not sure yet, the name alone could be many kinds of business" : "not sure yet, it works it out from your brief"}
      {live.evidence.length > 0 && `, from "${live.evidence.join(", ")}"`}
      {live.facts.length > 0 && `. ${live.facts.map(([k, v]) => `${k}: ${v}`).join("; ")}`}.
    </p>
  );
}

/** The page plan: each page with what happens to it, and the header and footer. */
function PagesPlan({ pages, chrome }: { pages: PagePlan[]; chrome: "design" | "keep" }) {
  return (
    <ul className="mt-2 grid gap-2">
      {pages.map((p) => (
        <li key={p.address} className="grid grid-cols-[1fr_auto] items-start gap-x-3 gap-y-0.5">
          <span>
            <b className="font-medium">{p.title}</b> <span className="text-xs text-zinc-400">{p.address}</span>
          </span>
          <Pill tone={ACTION[p.action][1]}>{ACTION[p.action][0]}</Pill>
          {p.purpose && <span className="col-span-2 text-zinc-500">{p.purpose}</span>}
        </li>
      ))}
      <li className="grid grid-cols-[1fr_auto] items-start gap-x-3">
        <b className="font-medium">Header and footer</b>
        <Pill tone={chrome === "design" ? ACTION.update[1] : ACTION.keep[1]}>{chrome === "design" ? "New design" : "Keep"}</Pill>
      </li>
    </ul>
  );
}

function AnalysisStep({ analysis, result, statusOf, onRetry }: { analysis: Analysis; result: SetupPlan | null; statusOf: (q: SetupGroup) => "ask" | "later"; onRetry: () => void }) {
  const heading = (
    <>
      <h2 id="setup-step-title" className="mt-1 text-2xl font-semibold tracking-tight">
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
            <li key={p} className={`flex items-center gap-3 ${i > phase ? "text-zinc-400" : ""}`}>
              <span className="grid size-5 place-items-center">{i < phase ? <span className="grid size-5 place-items-center rounded-full bg-emerald-500 text-xs text-white">✓</span> : i === phase ? <Spinner /> : <span className="size-2 rounded-full bg-zinc-300 dark:bg-zinc-700" />}</span>
              <span className={i === phase ? "font-medium" : ""}>{p}</span>
            </li>
          ))}
        </ol>
      </>
    );
  }
  const asking = result.questions.filter((q) => statusOf(q) === "ask");
  const later = result.questions.filter((q) => statusOf(q) === "later");
  const looked = result.fetched ? `It read the website you gave${result.searched ? " and searched the web" : ""}.` : result.searched ? "It looked at similar websites." : null;
  return (
    <>
      {heading}
      <div className="mt-5 grid gap-3 text-sm">
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <h3 className="font-semibold">What it understood</h3>
          <p className="mt-1">
            <b>{result.label}</b> website <span className="text-zinc-500">({result.confidence})</span>
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
                    {f.text} {f.changes && <span className="text-zinc-500">→ {f.changes}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.by === "keywords" && <p className="mt-2 text-zinc-500">The AI wasn&apos;t available, so our guide for this kind of business made the plan.</p>}
        </div>
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <h3 className="font-semibold">Pages it will make</h3>
          <PagesPlan pages={result.pages} chrome={result.chrome} />
        </div>
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <h3 className="font-semibold">{asking.length ? `Questions for you: ${asking.length}` : "No questions needed"}</h3>
          <ul className="mt-2 grid gap-2">
            {[...asking, ...later].map((q) => (
              <li key={q.id} className="grid grid-cols-[1fr_auto] items-start gap-x-3 gap-y-0.5">
                <b className="font-medium">{q.title}</b>
                <Pill tone={STATUS[statusOf(q)][1]}>{STATUS[statusOf(q)][0]}</Pill>
                {q.why && <span className="col-span-2 text-zinc-500">{q.why}</span>}
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
}) {
  const missing = <span className="text-amber-700 dark:text-amber-300">Not given</span>;
  const tabs = {
    pages: ["Pages", "What Claude makes, rewrites or keeps"],
    profile: ["Site profile", "knowledge/notes.md: Claude reads it before every request"],
    config: ["Site details", "site.config.json: name, contact details and links"],
    request: ["Build request", "Sent to Ask Claude once your site opens"],
  } as const;
  const tabText = !preview ? "" : tab === "config" ? JSON.stringify(preview.config, null, 2) : tab === "profile" ? preview.profile : preview.request;
  return (
    <>
      <h2 id="setup-step-title" className="mt-1 text-2xl font-semibold tracking-tight">
        Check your answers
      </h2>
      <p className="mt-2 text-sm text-zinc-500">Everything below is saved into your new site, then Claude builds it.</p>
      <div className="mt-5 grid gap-2.5 text-sm">
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">The basics</h3>
            <button type="button" onClick={() => onChange("basics")} className="ml-auto text-xs text-zinc-500 underline">
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
            .map((f) => [f, f.type === "logo" ? (logo ? logo.name : undefined) : f.type === "photos" ? (photos.length ? `${photos.length} photo${photos.length === 1 ? "" : "s"}` : undefined) : answers[f.id] !== undefined ? asText(answers[f.id]) : undefined] as const)
            .filter(([, v]) => v);
          return (
            <div key={q.id} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{q.title}</h3>
                {status !== "ask" && <Pill tone={STATUS[status][1]}>{STATUS[status][0]}</Pill>}
                <button type="button" onClick={() => (status === "later" ? onAnswerNow(q.id) : onChange(q.id))} className="ml-auto text-xs text-zinc-500 underline">
                  {status === "ask" ? "Change" : "Answer it now"}
                </button>
              </div>
              {rows.length > 0 && (
                <dl className="mt-1 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5">
                  {rows.map(([f, v]) => (
                    <div key={f.id} className="contents">
                      <dt className="text-zinc-500">{f.label.replace(/ \((optional|pick any)\)$/, "")}</dt>
                      <dd className="wrap-break-word">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          );
        })}
      </div>
      <div role="tablist" className="mt-5 grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1 text-xs sm:grid-cols-4 dark:bg-zinc-900">
        {(Object.keys(tabs) as (keyof typeof tabs)[]).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => onTab(id)} className={`rounded-md px-2 py-1.5 ${tab === id ? "bg-background font-semibold shadow-sm" : "text-zinc-500"}`}>
            {tabs[id][0]}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-500">{tabs[tab][1]}</p>
      {tab === "pages" ? (
        result?.pages.length ? (
          <div className="mt-1 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <PagesPlan pages={result.pages} chrome={result.chrome} />
          </div>
        ) : (
          <p className="mt-1 text-sm text-zinc-500">No plan yet: Claude designs your homepage and asks what else you need.</p>
        )
      ) : (
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">{tabText || "Preparing…"}</pre>
      )}
    </>
  );
}
