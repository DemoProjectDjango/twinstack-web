"use client";

import Link from "next/link";
import { useRef, useState } from "react";

// A hands-on tour of the builder on a pretend site: each stop is one feature to try in a few
// seconds, and every change made joins "What's changed" for the last stop to publish. Nothing here
// talks to the API. The stops' names follow the site editor's labels (SiteManager's MAIN,
// MoreToolsPanel's MORE_TOOLS): rename one there, rename it here too.

type StopId = "edit" | "phone" | "ai" | "look" | "details" | "pages" | "google" | "publish";

const STOPS: { id: StopId; label: string; title: string; text: string; try: string }[] = [
  {
    id: "edit",
    label: "Edit site",
    title: "Click any words and type",
    text: "Your site, exactly as visitors see it. Change the words right where they are.",
    try: "Click the big headline, type something new, then press Enter.",
  },
  {
    id: "phone",
    label: "Phone preview",
    title: "Check it on a phone",
    text: "Most visitors use a phone. Switch any time to see how your site looks there.",
    try: "Press Phone above the site.",
  },
  {
    id: "ai",
    label: "Chat with the AI",
    title: "Tell the AI what you want",
    text: "Write in your own words and the AI does the work. You can also attach photos, a menu or a design you like.",
    try: "Pick a request below, or type your own.",
  },
  {
    id: "look",
    label: "Look & logo",
    title: "Your colours and header",
    text: "Pick a colour and the button at the top. It changes on every page at once.",
    try: "Choose a colour and a button.",
  },
  {
    id: "details",
    label: "Business info",
    title: "Change it once, updated everywhere",
    text: "Phone, email, address, hours and social links live in one place.",
    try: "Change the phone number and watch the header and footer.",
  },
  {
    id: "pages",
    label: "Pages",
    title: "Add a page, three ways",
    text: "Write it yourself, give the AI a few notes, or bring a page from your old website.",
    try: "Add a page and see it join the menu.",
  },
  {
    id: "google",
    label: "Google & domain",
    title: "Get found on Google",
    text: "See how your page shows up in search, with a score. Use your own web address too.",
    try: "Let the AI write the search text, then switch on your own domain.",
  },
  {
    id: "publish",
    label: "Publish",
    title: "Nothing goes live until you say so",
    text: "Every change waits here in plain words. Undo what you don't want, then publish.",
    try: "Look over your changes and press Publish.",
  },
];

const ACCENTS = [
  { name: "Teal", hex: "#0d9488" },
  { name: "Rose", hex: "#e11d48" },
  { name: "Amber", hex: "#c2410c" },
  { name: "Indigo", hex: "#4f46e5" },
];

type ButtonKind = "order" | "call" | "none";
type Section = "hours" | "gallery";

const FIRST_HEADLINE = "Fresh bread, every morning";
const FRIENDLY_HEADLINE = "Warm bread and big smiles, from 7am";
const SEO_TEXT = "Sourdough, pastries and celebration cakes, baked fresh every morning in Leeds. Order a cake online.";

const MORE = [
  ["Visitors", "How many people visit, which pages they read and where they come from."],
  ["Planned posts", "The AI writes new blog posts on the dates you choose."],
  ["Files", "Add a PDF menu or price list for people to download."],
  ["Old web addresses", "Send visitors from your old site's links to the new pages."],
  ["Earlier versions", "Go back to any of your last 5 published versions."],
  ["Custom code", "Add Google Analytics or a chat widget."],
];

type Change = { key: string; text: string; undo: () => void };

export function FeatureTour({ signedIn }: { signedIn: boolean }) {
  const [stop, setStop] = useState<StopId>("edit");
  const [tried, setTried] = useState<Set<StopId>>(new Set());

  // The pretend site.
  const [headline, setHeadline] = useState(FIRST_HEADLINE);
  const [device, setDevice] = useState<"computer" | "phone">("computer");
  const [accent, setAccent] = useState(ACCENTS[0].hex);
  const [button, setButton] = useState<ButtonKind>("order");
  const [phone, setPhone] = useState("0113 496 0123");
  const [pages, setPages] = useState(["Home", "Menu", "About"]);
  const [sections, setSections] = useState<Section[]>([]);
  const [seoText, setSeoText] = useState("");
  const [ownDomain, setOwnDomain] = useState(false);
  const [changes, setChanges] = useState<Change[]>([]);
  const [published, setPublished] = useState(0);

  const index = STOPS.findIndex((s) => s.id === stop);
  const current = STOPS[index];
  const address = ownDomain ? "www.rosiesbakery.co.uk" : "rosie.github.io/bakery";

  function markTried(id: StopId) {
    setTried((t) => (t.has(id) ? t : new Set(t).add(id)));
  }

  /** Records a change for "What's changed". A second change of the same thing keeps the first undo. */
  function addChange(key: string, text: string, undo: () => void) {
    setChanges((list) => {
      const old = list.find((c) => c.key === key);
      if (old) return list.map((c) => (c.key === key ? { ...c, text } : c));
      return [...list, { key, text, undo }];
    });
  }

  function undoChange(change: Change) {
    change.undo();
    setChanges((list) => list.filter((c) => c.key !== change.key));
  }

  function go(id: StopId) {
    setStop(id);
  }

  // Actions, shared by the stops and the site itself.
  const actions = {
    markTried,
    headline(text: string) {
      const before = headline;
      const clean = text.trim();
      if (!clean || clean === before) return;
      setHeadline(clean);
      addChange("headline", `Changed the homepage headline to “${clean}”`, () => setHeadline(before));
      markTried("edit");
    },
    device(d: "computer" | "phone") {
      setDevice(d);
      if (d === "phone") markTried("phone");
    },
    accent(hex: string) {
      const before = accent;
      if (hex === before) return;
      setAccent(hex);
      addChange("accent", `New brand colour: ${ACCENTS.find((a) => a.hex === hex)?.name}`, () => setAccent(before));
      markTried("look");
    },
    button(kind: ButtonKind) {
      const before = button;
      if (kind === before) return;
      setButton(kind);
      const label = kind === "order" ? "Order a cake" : kind === "call" ? "Call us" : "no button";
      addChange("button", `Header button: ${label}`, () => setButton(before));
      markTried("look");
    },
    phone(value: string, before: string) {
      if (value === before) return;
      addChange("phone", `Phone number changed to ${value}`, () => setPhone(before));
      markTried("details");
    },
    addPage(name: string, how: string) {
      if (pages.includes(name)) return;
      setPages((p) => [...p, name]);
      addChange(`page-${name}`, `Added the ${name} page (${how})`, () => setPages((p) => p.filter((x) => x !== name)));
      markTried("pages");
    },
    section(s: Section, text: string) {
      if (sections.includes(s)) return;
      setSections((list) => [...list, s]);
      addChange(`section-${s}`, text, () => setSections((list) => list.filter((x) => x !== s)));
      markTried("ai");
    },
    seo() {
      setSeoText(SEO_TEXT);
      addChange("seo", "Wrote the homepage's Google description", () => setSeoText(""));
      markTried("google");
    },
    domain(on: boolean) {
      setOwnDomain(on);
      addChange("domain", on ? "Using www.rosiesbakery.co.uk" : "Back to the free address", () => setOwnDomain(!on));
      markTried("google");
    },
    publish() {
      setChanges([]);
      setPublished((n) => n + 1);
      markTried("publish");
    },
  };

  return (
    <div className="lg:grid lg:grid-cols-[22rem_minmax(0,1fr)] lg:gap-8">
      {/* Steps and the current stop's card */}
      <div className="space-y-4">
        <Progress tried={tried.size} />
        <ol className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:grid lg:grid-cols-2 lg:overflow-visible lg:px-0">
          {STOPS.map((s, i) => (
            <li key={s.id} className="shrink-0">
              <button
                type="button"
                onClick={() => go(s.id)}
                aria-current={s.id === stop ? "step" : undefined}
                className={`flex w-full items-center gap-2 rounded-full border px-3 py-1.5 text-left text-sm transition ${
                  s.id === stop
                    ? "border-foreground bg-foreground text-background"
                    : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                }`}
              >
                <span
                  className={`grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                    tried.has(s.id) ? "bg-emerald-500 text-white" : s.id === stop ? "bg-background/20" : "bg-zinc-100 dark:bg-zinc-800"
                  }`}
                  aria-hidden
                >
                  {tried.has(s.id) ? "✓" : i + 1}
                </span>
                <span className="whitespace-nowrap">{s.label}</span>
                {tried.has(s.id) && <span className="sr-only">(tried)</span>}
              </button>
            </li>
          ))}
        </ol>

        <section aria-live="polite" className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            {index + 1} of {STOPS.length} · {current.label}
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">{current.title}</h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{current.text}</p>
          <p className="mt-4 flex gap-2 rounded-md bg-violet-50 px-3 py-2 text-sm text-violet-900 dark:bg-violet-950/50 dark:text-violet-200">
            <span aria-hidden>👉</span>
            <span>
              <span className="font-medium">Try it: </span>
              {current.try}
            </span>
          </p>

          <div className="mt-4">
            <StopControls
              stop={stop}
              actions={actions}
              state={{ accent, button, phone, setPhone, pages, sections, headline, seoText, ownDomain, changes, published, device }}
              undoChange={undoChange}
            />
          </div>

          <div className="mt-5 flex items-center justify-between border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => go(STOPS[index - 1].id)}
              disabled={index === 0}
              className="text-sm text-zinc-500 hover:text-foreground disabled:invisible"
            >
              ← Back
            </button>
            {index < STOPS.length - 1 ? (
              <button
                type="button"
                onClick={() => go(STOPS[index + 1].id)}
                className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
              >
                {tried.has(stop) ? "Next →" : "Skip →"}
              </button>
            ) : (
              <Link
                href={signedIn ? "/dashboard" : "/register"}
                className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
              >
                {signedIn ? "Go to your sites" : "Build your own"}
              </Link>
            )}
          </div>
        </section>
      </div>

      {/* The pretend site */}
      <div className="mt-6 lg:mt-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div
            role="group"
            aria-label="Preview size"
            className={`inline-flex rounded-lg border p-0.5 text-sm ${
              stop === "phone" ? "border-violet-500 ring-2 ring-violet-500/30" : "border-zinc-200 dark:border-zinc-800"
            }`}
          >
            {(["computer", "phone"] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={device === d}
                onClick={() => actions.device(d)}
                className={`rounded-md px-3 py-1 capitalize ${device === d ? "bg-foreground text-background" : "text-zinc-600 dark:text-zinc-400"}`}
              >
                {d}
              </button>
            ))}
          </div>
          <span className="text-xs text-zinc-500">
            {changes.length > 0 ? `${changes.length} change${changes.length === 1 ? "" : "s"} not live yet` : published ? "✓ Everything is live" : "A pretend site to play with"}
          </span>
        </div>

        <PretendSite
          stop={stop}
          device={device}
          address={address}
          accent={accent}
          headline={headline}
          onHeadline={actions.headline}
          button={button}
          phone={phone}
          pages={pages}
          sections={sections}
        />
      </div>

      {/* What else, once they've reached the end */}
      {stop === "publish" && (
        <section className="mt-10 lg:col-span-2">
          <h2 className="text-lg font-semibold tracking-tight">And when you need them</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {MORE.map(([title, text]) => (
              <li key={title} className="rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
                <p className="font-medium">{title}</p>
                <p className="mt-1 text-zinc-500">{text}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Progress({ tried }: { tried: number }) {
  const all = STOPS.length;
  return (
    <div>
      <div className="flex justify-between text-xs text-zinc-500">
        <span>{tried === all ? "You've tried everything 🎉" : `${tried} of ${all} tried`}</span>
        <span>About 2 minutes</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className="h-full rounded-full bg-emerald-500 transition-all duration-500" style={{ width: `${(tried / all) * 100}%` }} />
      </div>
    </div>
  );
}

type Actions = {
  markTried(id: StopId): void;
  headline(text: string): void;
  accent(hex: string): void;
  button(kind: ButtonKind): void;
  phone(value: string, before: string): void;
  addPage(name: string, how: string): void;
  section(s: Section, text: string): void;
  seo(): void;
  domain(on: boolean): void;
  publish(): void;
};

type StopState = {
  accent: string;
  button: ButtonKind;
  phone: string;
  setPhone(v: string): void;
  pages: string[];
  sections: Section[];
  headline: string;
  seoText: string;
  ownDomain: boolean;
  changes: Change[];
  published: number;
  device: string;
};

const chip =
  "rounded-full border border-zinc-200 px-3 py-1.5 text-sm hover:border-zinc-400 disabled:cursor-default disabled:opacity-50 dark:border-zinc-700 dark:hover:border-zinc-500";

function StopControls({ stop, actions, state, undoChange }: { stop: StopId; actions: Actions; state: StopState; undoChange(c: Change): void }) {
  switch (stop) {
    case "edit":
      return <p className="text-sm text-zinc-500">Enter or clicking away saves. Esc puts it back.</p>;
    case "phone":
      return (
        <p className="text-sm text-zinc-500">
          {state.device === "phone" ? "The menu folds into ☰ and everything stacks. You didn't have to do a thing." : "The switch is just above the site."}
        </p>
      );
    case "ai":
      return <AiChat actions={actions} state={state} />;
    case "look":
      return (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium">Colour</p>
            <div className="mt-2 flex gap-2">
              {ACCENTS.map((a) => (
                <button
                  key={a.hex}
                  type="button"
                  onClick={() => actions.accent(a.hex)}
                  aria-label={a.name}
                  aria-pressed={state.accent === a.hex}
                  className={`size-9 rounded-full transition ${state.accent === a.hex ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : "hover:scale-110"}`}
                  style={{ background: a.hex }}
                />
              ))}
            </div>
          </div>
          <div>
            <p className="text-sm font-medium">Button at the top</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(
                [
                  ["order", "Order a cake"],
                  ["call", "Call us"],
                  ["none", "None"],
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={state.button === kind}
                  onClick={() => actions.button(kind)}
                  className={`${chip} ${state.button === kind ? "border-foreground font-medium dark:border-zinc-300" : ""}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      );
    case "details":
      return <PhoneField actions={actions} state={state} />;
    case "pages":
      return (
        <div className="grid gap-2">
          {(
            [
              ["Contact", "Write it yourself", "✍️"],
              ["Celebration cakes", "The AI writes it from your notes", "✨"],
              ["Prices", "Bring it from your old website", "📥"],
            ] as const
          ).map(([name, how, icon]) => {
            const added = state.pages.includes(name);
            return (
              <button
                key={name}
                type="button"
                disabled={added}
                onClick={() => actions.addPage(name, how.toLowerCase())}
                className="flex items-center gap-3 rounded-lg border border-zinc-200 p-3 text-left text-sm hover:border-zinc-400 disabled:opacity-60 dark:border-zinc-700"
              >
                <span aria-hidden className="text-lg">
                  {icon}
                </span>
                <span className="flex-1">
                  <span className="block font-medium">{how}</span>
                  <span className="text-zinc-500">{added ? `✓ ${name} is in your menu` : `Adds a “${name}” page`}</span>
                </span>
              </button>
            );
          })}
        </div>
      );
    case "google":
      return <GoogleStop actions={actions} state={state} />;
    case "publish":
      return <PublishStop actions={actions} state={state} undoChange={undoChange} />;
  }
}

function AiChat({ actions, state }: { actions: Actions; state: StopState }) {
  const [log, setLog] = useState<{ who: "you" | "ai"; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");

  const requests = [
    {
      ask: "Add our opening hours",
      done: () => state.sections.includes("hours"),
      run: () => actions.section("hours", "Added an opening hours section"),
      reply: "Done: there's an opening hours section on your homepage, using the hours from Business info.",
    },
    {
      ask: "Make the headline friendlier",
      done: () => state.headline === FRIENDLY_HEADLINE,
      run: () => {
        actions.headline(FRIENDLY_HEADLINE);
        actions.markTried("ai");
      },
      reply: "I've warmed up the headline. Have a look!",
    },
    {
      ask: "Add a gallery of our cakes",
      done: () => state.sections.includes("gallery"),
      run: () => actions.section("gallery", "Added a cake gallery"),
      reply: "Added a gallery. In your real site, attach your photos and I'll use them.",
    },
  ];

  function send(text: string) {
    if (busy || !text.trim()) return;
    const words = text.toLowerCase();
    const match = requests.find((r) => r.ask === text) ?? requests.find((r) => r.ask.toLowerCase().split(" ").some((w) => w.length > 4 && words.includes(w)));
    setLog((l) => [...l, { who: "you", text }]);
    setDraft("");
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      if (match) {
        match.run();
        setLog((l) => [...l, { who: "ai", text: match.reply }]);
      } else {
        setLog((l) => [...l, { who: "ai", text: "In your real site I'd do exactly that. Here, try one of the suggestions." }]);
      }
    }, 1200);
  }

  return (
    <div className="space-y-3">
      {log.length > 0 && (
        <ul className="max-h-48 space-y-2 overflow-y-auto text-sm">
          {log.map((m, i) => (
            <li key={i} className={m.who === "you" ? "text-right" : ""}>
              <span
                className={`inline-block max-w-[90%] rounded-2xl px-3 py-2 ${
                  m.who === "you" ? "bg-foreground text-background" : "bg-zinc-100 dark:bg-zinc-800"
                }`}
              >
                {m.text}
              </span>
            </li>
          ))}
          {busy && (
            <li className="text-zinc-500">
              <span className="inline-flex items-center gap-2 rounded-2xl bg-zinc-100 px-3 py-2 dark:bg-zinc-800">
                <span className="size-2 animate-pulse rounded-full bg-violet-500" /> Working on it…
              </span>
            </li>
          )}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {requests.map((r) => (
          <button key={r.ask} type="button" disabled={busy || r.done()} onClick={() => send(r.ask)} className={chip}>
            {r.done() ? `✓ ${r.ask}` : r.ask}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
        className="flex gap-2 rounded-xl border border-zinc-200 p-1.5 dark:border-zinc-700"
      >
        <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-950">
          ✦
        </span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Tell the AI what to change…"
          aria-label="Message to the AI"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        <button type="submit" disabled={busy || !draft.trim()} className="rounded-lg bg-foreground px-3 text-sm font-medium text-background disabled:opacity-40">
          Send
        </button>
      </form>
    </div>
  );
}

function PhoneField({ actions, state }: { actions: Actions; state: StopState }) {
  const before = useRef(state.phone);
  return (
    <label className="block text-sm">
      <span className="font-medium">Phone</span>
      <input
        value={state.phone}
        onFocus={() => (before.current = state.phone)}
        onChange={(e) => state.setPhone(e.target.value)}
        onBlur={() => actions.phone(state.phone, before.current)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        inputMode="tel"
        className="mt-1 w-full rounded-md border border-violet-500 px-3 py-2 outline-none ring-2 ring-violet-500/30 dark:bg-zinc-900"
      />
      <span className="mt-1 block text-xs text-zinc-500">Same idea for email, address, opening hours, reviews and FAQs.</span>
    </label>
  );
}

function GoogleStop({ actions, state }: { actions: Actions; state: StopState }) {
  const [writing, setWriting] = useState(false);
  const score = state.seoText ? 94 : 55;
  const url = state.ownDomain ? "www.rosiesbakery.co.uk" : "rosie.github.io › bakery";
  return (
    <div className="space-y-4">
      <div className="flex gap-3 rounded-lg border border-zinc-200 bg-white p-3 text-left dark:border-zinc-700">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-zinc-600">{url}</p>
          <p className="truncate text-base text-[#1a0dab]">Rosie&apos;s Bakery · {state.headline}</p>
          <p className={`text-xs ${state.seoText ? "text-zinc-700" : "italic text-zinc-400"}`}>
            {state.seoText || "No description yet: Google picks some text from the page."}
          </p>
        </div>
        <div
          className="grid size-12 shrink-0 place-items-center rounded-full text-sm font-semibold transition-colors"
          style={{ background: `conic-gradient(${score > 80 ? "#10b981" : "#f59e0b"} ${score}%, #e4e4e7 0)` }}
          aria-label={`Score ${score} out of 100`}
        >
          <span className="grid size-9 place-items-center rounded-full bg-white text-zinc-900">{score}</span>
        </div>
      </div>
      <button
        type="button"
        disabled={writing || !!state.seoText}
        onClick={() => {
          setWriting(true);
          window.setTimeout(() => {
            setWriting(false);
            actions.seo();
          }, 1000);
        }}
        className={chip}
      >
        {state.seoText ? "✓ Written by the AI" : writing ? "Writing…" : "✨ Let the AI write it"}
      </button>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          <span className="block font-medium">Use your own domain</span>
          <span className="text-zinc-500">Free address now, yours when you&apos;re ready.</span>
        </span>
        <input type="checkbox" role="switch" checked={state.ownDomain} onChange={(e) => actions.domain(e.target.checked)} className="size-5 accent-violet-600" />
      </label>
    </div>
  );
}

function PublishStop({ actions, state, undoChange }: { actions: Actions; state: StopState; undoChange(c: Change): void }) {
  const [publishing, setPublishing] = useState(false);

  if (publishing) {
    return (
      <p className="flex items-center gap-2 text-sm">
        <span className="size-2 animate-pulse rounded-full bg-violet-500" /> Publishing… your live site updates in a minute or two.
      </p>
    );
  }
  if (state.changes.length === 0) {
    return state.published ? (
      <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200">
        🎉 It&apos;s live! Everyone sees your changes now. Changed your mind? Earlier versions are one click away.
      </p>
    ) : (
      <p className="text-sm text-zinc-500">No changes yet. Go back and try a stop or two, and they&apos;ll wait here.</p>
    );
  }
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-700">
        {state.changes.map((c) => (
          <li key={c.key} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0">{c.text}</span>
            <button type="button" onClick={() => undoChange(c)} className="shrink-0 text-xs text-zinc-500 underline hover:text-foreground">
              Undo
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          setPublishing(true);
          window.setTimeout(() => {
            setPublishing(false);
            actions.publish();
          }, 1500);
        }}
        className="w-full rounded-md bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-700"
      >
        Publish {state.changes.length} change{state.changes.length === 1 ? "" : "s"}
      </button>
    </div>
  );
}

/** Where the current stop is on the site, so the eye goes there. */
const spot = "outline-2 outline-dashed outline-offset-4 outline-violet-500";

function PretendSite(props: {
  stop: StopId;
  device: "computer" | "phone";
  address: string;
  accent: string;
  headline: string;
  onHeadline(text: string): void;
  button: ButtonKind;
  phone: string;
  pages: string[];
  sections: Section[];
}) {
  const { stop, device, accent, button, phone, pages, sections } = props;
  const small = device === "phone";
  const headerSpot = stop === "look" || stop === "pages" || (stop === "details" && button === "call");

  return (
    <div
      className={`mx-auto overflow-hidden rounded-xl border border-zinc-200 bg-white text-zinc-900 shadow-sm transition-all duration-500 dark:border-zinc-700 ${
        small ? "max-w-[360px]" : "max-w-full"
      }`}
    >
      {/* Browser bar */}
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2">
        <span className="flex gap-1" aria-hidden>
          <span className="size-2.5 rounded-full bg-zinc-300" />
          <span className="size-2.5 rounded-full bg-zinc-300" />
          <span className="size-2.5 rounded-full bg-zinc-300" />
        </span>
        <span className={`min-w-0 flex-1 truncate rounded bg-white px-2 py-0.5 text-center text-xs text-zinc-500 ${stop === "google" ? spot : ""}`}>
          {props.address}
        </span>
      </div>

      {/* Header */}
      <header className={`flex items-center justify-between gap-3 border-b border-zinc-100 px-5 py-3 ${headerSpot ? spot : ""}`}>
        <span className="flex items-center gap-2 font-semibold">
          <span className="grid size-7 place-items-center rounded-md text-sm text-white transition-colors" style={{ background: accent }}>
            R
          </span>
          Rosie&apos;s Bakery
        </span>
        {small ? (
          <span aria-hidden className="text-xl leading-none text-zinc-500">
            ☰
          </span>
        ) : (
          <nav className="flex items-center gap-4 text-sm text-zinc-600">
            {pages.map((p) => (
              <span key={p}>{p}</span>
            ))}
            {button !== "none" && (
              <span className="rounded-md px-3 py-1.5 text-sm font-medium text-white transition-colors" style={{ background: accent }}>
                {button === "order" ? "Order a cake" : `Call ${phone}`}
              </span>
            )}
          </nav>
        )}
      </header>

      {/* Hero */}
      <section className={`px-5 ${small ? "py-8" : "py-14"}`}>
        <h1
          key={props.headline}
          contentEditable="plaintext-only"
          suppressContentEditableWarning
          spellCheck={false}
          aria-label="Headline (click to edit)"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.currentTarget.textContent = props.headline;
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => props.onHeadline(e.currentTarget.textContent ?? "")}
          className={`cursor-text rounded font-bold tracking-tight outline-none hover:bg-violet-50 focus:bg-violet-50 ${small ? "text-3xl" : "text-5xl"} ${
            stop === "edit" ? spot : ""
          }`}
        >
          {props.headline}
        </h1>
        <p className="mt-3 max-w-md text-zinc-600">Sourdough, pastries and celebration cakes from our little shop in Leeds.</p>
        <span className="mt-6 inline-block rounded-md px-4 py-2 text-sm font-medium text-white transition-colors" style={{ background: accent }}>
          See our menu
        </span>
      </section>

      {sections.includes("hours") && (
        <section className="border-t border-zinc-100 px-5 py-8">
          <h2 className="font-semibold">Opening hours</h2>
          <dl className={`mt-3 grid gap-2 text-sm ${small ? "grid-cols-1" : "grid-cols-3"}`}>
            {[
              ["Mon – Fri", "7am – 5pm"],
              ["Saturday", "8am – 4pm"],
              ["Sunday", "Closed"],
            ].map(([d, t]) => (
              <div key={d} className="rounded-md bg-zinc-50 px-3 py-2">
                <dt className="text-zinc-500">{d}</dt>
                <dd className="font-medium">{t}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {sections.includes("gallery") && (
        <section className="border-t border-zinc-100 px-5 py-8">
          <h2 className="font-semibold">Our cakes</h2>
          <div className={`mt-3 grid gap-2 ${small ? "grid-cols-2" : "grid-cols-4"}`}>
            {["🎂", "🥐", "🍰", "🥖"].map((e) => (
              <div key={e} className="grid aspect-square place-items-center rounded-lg text-3xl" style={{ background: `${accent}1a` }}>
                {e}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Footer */}
      <footer
        className={`grid gap-4 bg-zinc-900 px-5 py-6 text-sm text-zinc-300 ${small ? "grid-cols-1" : "grid-cols-2"} ${stop === "details" ? spot : ""}`}
      >
        <div>
          <p className="font-semibold text-white">Rosie&apos;s Bakery</p>
          <p className="mt-1">12 Market Street, Leeds</p>
          <p className="transition-colors" style={{ color: stop === "details" ? "#c4b5fd" : undefined }}>
            {phone}
          </p>
        </div>
        <ul className="space-y-1">
          {pages.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </footer>
    </div>
  );
}
