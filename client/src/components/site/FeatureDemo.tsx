"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

// Small looping demos for "Learn the features" (FeatureGuide's cards): each feature shown in a
// few frames on a tiny pretend site, so the owner sees what it does before trying it. A demo plays
// only while it's on screen, stands still on its last frame for people who prefer less motion, and
// steps on a frame when clicked. Pretend content only: nothing here reads the owner's site.

export type DemoKind =
  | "words"
  | "phone"
  | "page-picker"
  | "section"
  | "links"
  | "full-size"
  | "checklist"
  | "chat"
  | "attach"
  | "panel"
  | "picture"
  | "pages-list"
  | "add-page"
  | "edit-page"
  | "page-menu"
  | "on-site"
  | "find"
  | "colors"
  | "logo"
  | "header"
  | "details"
  | "tabs"
  | "google"
  | "domain"
  | "dns"
  | "chart"
  | "table"
  | "calendar"
  | "files"
  | "notes"
  | "code"
  | "models"
  | "plan"
  | "log"
  | "changes"
  | "undo"
  | "versions"
  | "publish"
  | "updates"
  | "templates";

/** Which demo each step of the guide shows (by step id). */
export const STEP_DEMOS: Record<string, DemoKind> = {
  "edit-text": "words",
  "preview-page": "page-picker",
  "ask-section": "section",
  "try-links": "links",
  phone: "phone",
  "full-size": "full-size",
  todo: "checklist",
  ai: "chat",
  "ai-attach": "attach",
  "chat-panel": "panel",
  pictures: "picture",
  pages: "pages-list",
  "page-add": "add-page",
  "page-open": "edit-page",
  "page-menu": "page-menu",
  templates: "templates",
  "page-on-site": "on-site",
  find: "find",
  design: "colors",
  brand: "logo",
  "header-footer": "header",
  details: "details",
  "details-tab": "tabs",
  domain: "domain",
  "domain-how": "dns",
  analytics: "chart",
  "analytics-more": "table",
  seo: "google",
  schedule: "calendar",
  files: "files",
  memory: "notes",
  styles: "code",
  models: "models",
  log: "log",
  publish: "changes",
  undo: "undo",
  versions: "versions",
  "publish-button": "publish",
  updates: "updates",
};

const FRAMES: Record<DemoKind, number> = {
  words: 3,
  phone: 2,
  "page-picker": 3,
  section: 3,
  links: 3,
  "full-size": 2,
  checklist: 4,
  chat: 3,
  attach: 3,
  panel: 2,
  picture: 3,
  "pages-list": 3,
  "add-page": 3,
  "edit-page": 3,
  "page-menu": 3,
  "on-site": 2,
  find: 3,
  colors: 4,
  logo: 2,
  header: 3,
  details: 2,
  tabs: 4,
  google: 2,
  domain: 2,
  dns: 3,
  chart: 2,
  table: 2,
  calendar: 3,
  files: 2,
  notes: 2,
  code: 2,
  models: 2,
  plan: 3,
  log: 3,
  changes: 3,
  undo: 2,
  versions: 3,
  publish: 3,
  updates: 2,
  templates: 3,
};

// ——— Playing ———

function subscribeMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function usePrefersStill() {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

/** The frame on show: advancing every `ms` while on screen, or by a click. */
function useFrames(count: number, ms = 1600) {
  const ref = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(0);
  const [visible, setVisible] = useState(false);
  const [touched, setTouched] = useState(false);
  const still = usePrefersStill();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || still) return;
    const timer = window.setInterval(() => setFrame((f) => (f + 1) % count), ms);
    return () => window.clearInterval(timer);
  }, [visible, still, count, ms]);

  const next = () => {
    setTouched(true);
    setFrame((f) => (f + 1) % count);
  };
  // Less motion: the finished state, until they step through it themselves.
  return { ref, frame: still && !touched ? count - 1 : frame, next };
}

/** One step's demo. */
export function FeatureDemo({ kind, label }: { kind: DemoKind; label: string }) {
  const count = FRAMES[kind];
  const { ref, frame, next } = useFrames(count);
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={next}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          next();
        }
      }}
      aria-label={`${label}: a short demo. Press to step through it.`}
      title="Click to step through"
      className="group relative cursor-pointer select-none overflow-hidden rounded-xl border border-zinc-200 bg-gradient-to-br from-zinc-50 to-indigo-50/60 p-3 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-zinc-800 dark:from-zinc-900 dark:to-indigo-950/40"
    >
      {/* Every frame is laid out, unseen, in the same cell as the one playing, so the demo is always
          as tall as its tallest frame and the card around it never changes height. */}
      <div aria-hidden className="pointer-events-none grid">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="invisible [grid-area:1/1]">
            <Scene kind={kind} f={i} />
          </div>
        ))}
        <div className="self-start [grid-area:1/1]">
          <Scene kind={kind} f={frame} />
        </div>
      </div>
      <div aria-hidden className="mt-2 flex justify-center gap-1">
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className={clsx("h-1 rounded-full transition-all", i === frame ? "w-4 bg-indigo-500" : "w-1 bg-zinc-300 dark:bg-zinc-700")} />
        ))}
      </div>
    </div>
  );
}

// ——— Pieces of the pretend site ———

const ACCENTS = ["#4f46e5", "#0d9488", "#e11d48", "#d97706"];
const T = "transition-all duration-500";

function Bar({ w, className }: { w: string; className?: string }) {
  return <div className={clsx("h-1.5 rounded-full bg-zinc-200", className)} style={{ width: w }} />;
}

function Site({
  title = "Rosie's Bakery",
  accent = ACCENTS[0],
  narrow = false,
  button = "Order",
  logo,
  hero,
  footer,
  heroRing = false,
  className,
  children,
}: {
  title?: ReactNode;
  accent?: string;
  narrow?: boolean;
  button?: string | null;
  logo?: ReactNode;
  hero?: ReactNode;
  footer?: ReactNode;
  heroRing?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={clsx("mx-auto overflow-hidden rounded-md border border-zinc-200 bg-white text-zinc-900 shadow-sm", T, narrow ? "w-[44%]" : "w-full", className)}>
      <div className="flex items-center gap-1.5 border-b border-zinc-100 px-2 py-1.5">
        {logo ?? <div className={clsx("size-3 rounded-sm", T)} style={{ background: accent }} />}
        <Bar w="28px" className="bg-zinc-300" />
        <div className="flex-1" />
        {narrow ? (
          <div className="text-[8px] leading-none text-zinc-500">☰</div>
        ) : (
          <>
            <Bar w="12px" />
            <Bar w="12px" />
            {button && (
              <div className={clsx("rounded px-1.5 py-0.5 text-[7px] font-semibold text-white", T)} style={{ background: accent }}>
                {button}
              </div>
            )}
          </>
        )}
      </div>
      <div className={clsx("px-2 py-2.5", T, heroRing && "outline outline-2 -outline-offset-2 outline-dashed outline-indigo-500")}>
        {hero ?? (
          <>
            <div className="text-[10px] font-bold leading-tight">{title}</div>
            <Bar w="80%" className="mt-1.5" />
            <Bar w="55%" className="mt-1" />
            <div className={clsx("mt-2 inline-block rounded px-1.5 py-0.5 text-[7px] font-semibold text-white", T)} style={{ background: accent }}>
              See our menu
            </div>
          </>
        )}
      </div>
      {children}
      <div className="flex items-center gap-2 bg-zinc-800 px-2 py-1 text-[7px] text-zinc-300">{footer ?? <Bar w="30px" className="bg-zinc-600" />}</div>
    </div>
  );
}

/** A panel of the editor: a white card with a label. */
function Panel({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("rounded-md border border-zinc-200 bg-white p-2 text-[8px] text-zinc-700 shadow-sm", className)}>
      {title && <div className="mb-1.5 text-[8px] font-semibold text-zinc-900">{title}</div>}
      {children}
    </div>
  );
}

function Row({ children, on = false, className }: { children: ReactNode; on?: boolean; className?: string }) {
  return (
    <div className={clsx("flex items-center gap-1.5 rounded px-1.5 py-1", T, on ? "bg-indigo-50 text-indigo-900 ring-1 ring-indigo-300" : "", className)}>{children}</div>
  );
}

function Tick({ on }: { on: boolean }) {
  return (
    <span className={clsx("grid size-2.5 shrink-0 place-items-center rounded-full text-[6px] text-white", T, on ? "scale-100 bg-emerald-500" : "scale-90 border border-zinc-300 bg-white")}>
      {on ? "✓" : ""}
    </span>
  );
}

function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[7px] font-semibold", T, className)}>{children}</div>;
}

function Caret() {
  return <span className="ml-px inline-block h-2.5 w-px translate-y-0.5 animate-pulse bg-indigo-600" />;
}

function Bars({ heights, color = "bg-indigo-500" }: { heights: number[]; color?: string }) {
  return (
    <div className="flex h-12 items-end gap-1">
      {heights.map((h, i) => (
        <div key={i} className={clsx("flex-1 rounded-t", color, T)} style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

// ——— The scenes ———

function Scene({ kind, f }: { kind: DemoKind; f: number }) {
  switch (kind) {
    case "words":
      return (
        <Site
          hero={
            <>
              <div className={clsx("inline-block rounded px-0.5 text-[10px] font-bold leading-tight", T, f === 1 && "bg-indigo-100 ring-1 ring-indigo-400")}>
                {f === 0 ? "Fresh bread daily" : f === 1 ? (
                  <>
                    Warm bread
                    <Caret />
                  </>
                ) : (
                  "Warm bread from 7am"
                )}
              </div>
              <Bar w="80%" className="mt-1.5" />
              <Bar w="55%" className="mt-1" />
              <Pill className={clsx("mt-2", f === 2 ? "bg-emerald-100 text-emerald-800" : "opacity-0")}>✓ Saved</Pill>
            </>
          }
        />
      );
    case "phone":
      return (
        <div className="space-y-2">
          <div className="flex justify-center">
            <div className="flex rounded-md border border-zinc-200 bg-white p-0.5 text-[7px]">
              <span className={clsx("rounded px-1.5 py-0.5", T, f === 0 ? "bg-zinc-900 text-white" : "text-zinc-500")}>Computer</span>
              <span className={clsx("rounded px-1.5 py-0.5", T, f === 1 ? "bg-zinc-900 text-white" : "text-zinc-500")}>Phone</span>
            </div>
          </div>
          <Site narrow={f === 1} />
        </div>
      );
    case "templates":
      // The template choice, the gallery (searching), then the site it makes.
      return f === 0 ? (
        <div className="space-y-1.5">
          <div className="rounded-md border-2 border-zinc-900 bg-white p-2">
            <p className="text-[9px] font-semibold text-zinc-900">Use a template</p>
            <Bar w="70%" />
          </div>
          <div className="rounded-md border border-zinc-200 bg-white p-2">
            <p className="text-[9px] font-semibold text-zinc-900">Let the AI design it</p>
            <Bar w="60%" />
          </div>
        </div>
      ) : f === 1 ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-semibold text-zinc-900">Templates</span>
            <span className="flex-1 rounded border border-zinc-300 bg-white px-1 py-0.5 text-[7px] text-zinc-500">café</span>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className={clsx("rounded border bg-white p-1", i === 0 ? "border-zinc-900" : "border-zinc-200")}>
                <div className="h-6 rounded-sm bg-gradient-to-br from-teal-100 to-zinc-100" />
                <Bar w="70%" />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Site title="Rosie's Bakery" />
      );
    case "page-picker": {
      const pages = ["Home", "About us", "Our menu"];
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-1 text-[8px] text-zinc-500">
            Page
            <span className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 font-semibold text-zinc-900">{pages[f]} ▾</span>
          </div>
          <Site title={f === 0 ? "Rosie's Bakery" : pages[f]} />
        </div>
      );
    }
    case "section":
      return (
        <div className="relative">
          <Site heroRing={f >= 1} />
          <Pill className={clsx("absolute left-1/2 top-[38%] -translate-x-1/2 bg-indigo-600 text-white shadow", f === 2 ? "scale-100 opacity-100" : "scale-75 opacity-0")}>
            ✦ Ask the AI to change this section
          </Pill>
        </div>
      );
    case "links":
      return (
        <div className="space-y-2">
          <div className="flex justify-end">
            <Pill className={f === 0 ? "bg-indigo-100 text-indigo-800" : "bg-zinc-900 text-white"}>{f === 0 ? "Editing words" : "Trying links"}</Pill>
          </div>
          <div className="relative">
            <Site />
            <div className={clsx("absolute right-[22%] top-1 text-[11px]", T, f === 2 ? "opacity-100" : "translate-y-3 opacity-0")}>👆</div>
          </div>
        </div>
      );
    case "full-size":
      return f === 0 ? (
        <div className="flex gap-1.5">
          <div className="w-1/4 space-y-1 rounded bg-white p-1 shadow-sm">
            <Bar w="90%" />
            <Bar w="70%" />
            <Bar w="80%" />
          </div>
          <div className="flex-1 scale-95">
            <Site />
          </div>
        </div>
      ) : (
        <div className="relative">
          <div className="mb-1 flex items-center gap-1 rounded-t bg-zinc-200 px-1.5 py-0.5 text-[7px] text-zinc-600">
            <span className="rounded-sm bg-white px-1">Rosie&apos;s Bakery ↗</span>
          </div>
          <Site />
        </div>
      );
    case "checklist": {
      const items = ["Add your phone number", "Write the About page", "Upload your logo"];
      return (
        <Panel title={`${Math.max(0, 3 - f)} things left before you share your site`}>
          <div className="space-y-1">
            {items.map((item, i) => (
              <Row key={item}>
                <Tick on={f > i} />
                <span className={clsx(T, f > i && "text-zinc-400 line-through")}>{item}</span>
              </Row>
            ))}
          </div>
        </Panel>
      );
    }
    case "chat":
      return (
        <Panel className="space-y-1.5">
          <div className="flex justify-end">
            <div className="rounded-xl rounded-br-sm bg-zinc-900 px-2 py-1 text-white">Add our opening hours</div>
          </div>
          <div className={clsx(T, f >= 1 ? "opacity-100" : "opacity-0")}>
            {f === 1 ? (
              <div className="inline-flex gap-0.5 rounded-xl bg-zinc-100 px-2 py-1.5">
                <span className="size-1 animate-bounce rounded-full bg-zinc-400" />
                <span className="size-1 animate-bounce rounded-full bg-zinc-400 [animation-delay:150ms]" />
                <span className="size-1 animate-bounce rounded-full bg-zinc-400 [animation-delay:300ms]" />
              </div>
            ) : (
              <div className="space-y-1">
                <div className="inline-block rounded-xl rounded-bl-sm bg-zinc-100 px-2 py-1">Done! They&apos;re on your homepage.</div>
                <Row on>
                  <Tick on />
                  Homepage: added opening hours
                </Row>
              </div>
            )}
          </div>
        </Panel>
      );
    case "attach":
      return (
        <Panel className="space-y-1.5">
          <div className="flex min-h-4 flex-wrap gap-1">
            <Pill className={clsx("bg-zinc-100 text-zinc-700", f >= 1 ? "opacity-100" : "scale-75 opacity-0")}>📄 menu.pdf</Pill>
            <Pill className={clsx("bg-zinc-100 text-zinc-700", f >= 2 ? "opacity-100" : "scale-75 opacity-0")}>🖼️ cakes.jpg</Pill>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-200 px-1.5 py-1">
            <span className="text-indigo-600">✦</span>
            <span className="flex-1 text-zinc-400">Make a Prices page from this…</span>
            <span className={clsx("grid size-3.5 place-items-center rounded border text-[8px]", T, f === 0 ? "border-indigo-500 text-indigo-600 ring-2 ring-indigo-200" : "border-zinc-300 text-zinc-500")}>+</span>
          </div>
        </Panel>
      );
    case "panel":
      return (
        <div className="relative overflow-hidden rounded-md">
          <Site />
          <div className={clsx("absolute inset-y-0 right-0 w-[45%] space-y-1 border-l border-zinc-200 bg-white p-1.5 shadow-lg", T, f === 1 ? "translate-x-0" : "translate-x-full")}>
            <div className="text-[7px] font-semibold">Chat with the AI</div>
            <div className="ml-auto w-3/4 rounded bg-zinc-900 p-1">
              <Bar w="100%" className="bg-zinc-600" />
            </div>
            <div className="w-3/4 rounded bg-zinc-100 p-1">
              <Bar w="100%" />
            </div>
            <div className="flex items-center gap-1 text-[6px] text-zinc-500">
              <span className="h-1.5 w-2.5 rounded-full bg-indigo-500" /> Make changes automatically
            </div>
          </div>
        </div>
      );
    case "picture":
      return (
        <Site
          hero={
            <div
              className={clsx("grid h-16 place-items-center rounded text-[8px]", T, f === 0 && "bg-zinc-100 text-zinc-400", f === 1 && "animate-pulse bg-indigo-100 text-indigo-700")}
              style={f === 2 ? { background: "linear-gradient(135deg,#fde68a,#fb923c 55%,#be123c)" } : undefined}
            >
              {f === 0 ? "No photo yet" : f === 1 ? "✨ Making the picture…" : <span className="text-xl">☕</span>}
            </div>
          }
        />
      );
    case "pages-list": {
      const pages = ["Home", "About us", "Contact"];
      return (
        <Panel title="Pages">
          <div className="space-y-1">
            {pages.map((p, i) => (
              <Row key={p} on={f === i}>
                <span>📄</span>
                <span className="flex-1">{p}</span>
                {i === 0 && <Pill className="bg-zinc-100 text-zinc-600">Homepage</Pill>}
              </Row>
            ))}
          </div>
        </Panel>
      );
    }
    case "add-page": {
      const ways = [
        ["✍️", "Write it yourself"],
        ["✨", "The AI writes it"],
        ["📥", "From your old site"],
      ];
      return (
        <Panel title="Add a page">
          <div className="grid grid-cols-3 gap-1">
            {ways.map(([icon, text], i) => (
              <div key={text} className={clsx("rounded border p-1 text-center", T, f === i ? "border-indigo-400 bg-indigo-50 ring-1 ring-indigo-300" : "border-zinc-200")}>
                <div className="text-[11px]">{icon}</div>
                <div className="mt-0.5 leading-tight">{text}</div>
              </div>
            ))}
          </div>
        </Panel>
      );
    }
    case "edit-page":
      return (
        <Panel title="About us">
          <div className="space-y-1">
            <Bar w="95%" />
            <Bar w={f === 2 ? "60%" : "88%"} />
            <Bar w={f === 2 ? "0%" : "92%"} className={f === 2 ? "opacity-0" : ""} />
          </div>
          <div className={clsx("mt-1.5 flex items-center gap-1 rounded border px-1 py-0.5", T, f >= 1 ? "border-indigo-300 opacity-100" : "opacity-0")}>
            <span className="text-indigo-600">✦</span>
            <span className="flex-1">Make it shorter</span>
            {f === 2 && <Pill className="bg-indigo-600 text-white">Keep</Pill>}
          </div>
        </Panel>
      );
    case "page-menu":
      return (
        <Panel title="Pages">
          <Row on={f === 1}>
            <span>📄</span>
            <span className="flex-1">Gallery</span>
            {f === 2 && <Pill className="bg-amber-100 text-amber-800">Hidden</Pill>}
            <span className="text-zinc-500">⋯</span>
          </Row>
          <div className={clsx("ml-auto mt-1 w-2/3 space-y-0.5 rounded border border-zinc-200 bg-white p-1 shadow", T, f === 1 ? "opacity-100" : "pointer-events-none -translate-y-1 opacity-0")}>
            <div>Show in the menu</div>
            <div className="rounded bg-indigo-50 text-indigo-900">Hide from visitors</div>
            <div className="text-rose-600">Delete</div>
          </div>
        </Panel>
      );
    case "on-site":
      return f === 0 ? (
        <Panel title="Pages">
          <Row on>
            <span>📄</span>
            <span className="flex-1">About us</span>
            <Pill className="bg-white text-zinc-900 ring-1 ring-zinc-300">Edit on site</Pill>
          </Row>
        </Panel>
      ) : (
        <Site title="About us" />
      );
    case "find": {
      const typed = ["", "co", "con"][f];
      return (
        <Panel>
          <div className="flex items-center gap-1 rounded border border-indigo-300 px-1.5 py-1">
            🔍
            <span className="flex-1">
              {typed || <span className="text-zinc-400">Find a page</span>}
              <Caret />
            </span>
            <span className="rounded border border-zinc-200 px-0.5 text-[6px] text-zinc-500">Ctrl K</span>
          </div>
          <div className="mt-1 space-y-0.5">
            {["Contact", "Cookies", "About us"]
              .filter((p) => p.toLowerCase().startsWith(typed))
              .map((p, i) => (
                <Row key={p} on={i === 0 && f > 0}>
                  📄 {p}
                </Row>
              ))}
          </div>
        </Panel>
      );
    }
    case "colors":
      return (
        <div className="space-y-2">
          <div className="flex justify-center gap-1.5">
            {ACCENTS.map((c, i) => (
              <span key={c} className={clsx("size-3 rounded-full", T, i === f && "ring-2 ring-zinc-900 ring-offset-1")} style={{ background: c }} />
            ))}
          </div>
          <Site accent={ACCENTS[f]} />
        </div>
      );
    case "logo":
      return (
        <div>
          <div className="mb-1 flex items-center gap-1 text-[7px] text-zinc-600">
            <span className="flex items-center gap-1 rounded-t bg-white px-1.5 py-0.5 shadow-sm">
              <span className={clsx("grid size-2.5 place-items-center rounded-sm text-[6px]", f === 1 ? "bg-amber-100" : "bg-indigo-600 text-white")}>{f === 1 ? "🥐" : "R"}</span>
              Rosie&apos;s Bakery
            </span>
          </div>
          <Site
            logo={
              f === 1 ? (
                <span className="grid size-4 place-items-center rounded-full bg-amber-100 text-[9px]">🥐</span>
              ) : (
                <span className="grid size-3 place-items-center rounded-sm bg-indigo-600 text-[7px] font-bold text-white">R</span>
              )
            }
          />
        </div>
      );
    case "header":
      return <Site button={["Book now", "Call us", "Contact"][f]} footer={<>
        <span>Visit us</span>
        <span>Opening hours</span>
        <span>📷 f</span>
      </>} />;
    case "details": {
      const phone = f === 0 ? "0113 496 0123" : "0113 496 9999";
      const flash = f === 1 ? "bg-amber-200 text-zinc-900" : "";
      return (
        <div className="space-y-2">
          <Panel>
            <div className="flex items-center gap-1">
              Phone
              <span className={clsx("flex-1 rounded border px-1 py-0.5", T, f === 1 ? "border-indigo-400 ring-1 ring-indigo-200" : "border-zinc-200")}>{phone}</span>
            </div>
          </Panel>
          <Site
            button={null}
            hero={
              <>
                <div className="text-[10px] font-bold">Rosie&apos;s Bakery</div>
                <Pill className={clsx("mt-1.5 bg-indigo-600 text-white", flash)}>📞 {phone}</Pill>
              </>
            }
            footer={<span className={clsx("rounded px-0.5", T, flash)}>{phone}</span>}
          />
        </div>
      );
    }
    case "tabs": {
      const tabs = ["About", "Contact", "Social", "Reviews"];
      return (
        <Panel>
          <div className="flex gap-2 border-b border-zinc-200">
            {tabs.map((t, i) => (
              <span key={t} className={clsx("-mb-px border-b-2 pb-1", T, i === f ? "border-indigo-600 font-semibold text-indigo-800" : "border-transparent text-zinc-500")}>
                {t}
              </span>
            ))}
          </div>
          <div className="mt-1.5 space-y-1">
            <Bar w={`${60 + f * 10}%`} />
            <Bar w={`${85 - f * 8}%`} />
            <Bar w={`${50 + f * 7}%`} />
          </div>
        </Panel>
      );
    }
    case "google": {
      const score = f === 0 ? 55 : 94;
      return (
        <Panel className="flex gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[6px] text-zinc-500">rosiesbakery.co.uk</div>
            <div className="text-[9px] text-[#1a0dab]">Rosie&apos;s Bakery · Fresh bread in Leeds</div>
            <div className={clsx("text-[7px] leading-tight", T, f === 0 ? "italic text-zinc-400" : "text-zinc-700")}>
              {f === 0 ? "No description yet." : "Sourdough, pastries and cakes, baked every morning."}
            </div>
          </div>
          <div className={clsx("grid size-8 shrink-0 place-items-center rounded-full", T)} style={{ background: `conic-gradient(${score > 80 ? "#10b981" : "#f59e0b"} ${score}%, #e4e4e7 0)` }}>
            <span className="grid size-6 place-items-center rounded-full bg-white text-[8px] font-bold">{score}</span>
          </div>
        </Panel>
      );
    }
    case "domain":
      return (
        <div>
          <div className="mb-1 flex items-center gap-1 rounded bg-white px-1.5 py-0.5 text-[8px] shadow-sm">
            {f === 1 && <span>🔒</span>}
            <span className={clsx(T, f === 1 ? "font-semibold text-zinc-900" : "text-zinc-500")}>{f === 0 ? "rosie.github.io/bakery" : "www.rosiesbakery.co.uk"}</span>
          </div>
          <Site />
        </div>
      );
    case "dns": {
      const rows = ["CNAME  www", "A  @"];
      return (
        <Panel title="www.rosiesbakery.co.uk">
          <div className="space-y-0.5 font-mono">
            {rows.map((r, i) => (
              <Row key={r}>
                <Tick on={f > i} />
                {r}
              </Row>
            ))}
          </div>
          <Pill className={clsx("mt-1", f === 2 ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-500")}>{f === 2 ? "🔒 Secure (HTTPS) on" : "Checking…"}</Pill>
        </Panel>
      );
    }
    case "chart":
      return (
        <Panel title="Visitors">
          <Bars heights={f === 0 ? [10, 14, 8, 12, 9, 15, 11] : [30, 52, 41, 68, 57, 85, 74]} />
          <div className="mt-1 flex justify-between text-[6px] text-zinc-400">
            <span>Mon</span>
            <span>Sun</span>
          </div>
        </Panel>
      );
    case "table":
      return (
        <Panel title="Where visitors come from">
          {[
            ["Google", "64%"],
            ["Instagram", "22%"],
            ["Typed it", "14%"],
          ].map(([s, v], i) => (
            <Row key={s} on={f === 1 && i === 1} className={clsx(f === 1 && i !== 1 && "opacity-40")}>
              <span className="flex-1">{s}</span>
              <span>{v}</span>
            </Row>
          ))}
          <Pill className={clsx("mt-1 bg-zinc-100 text-zinc-600", f === 1 ? "opacity-100" : "opacity-0")}>⬇ PDF · Spreadsheet</Pill>
        </Panel>
      );
    case "calendar":
      return (
        <Panel title="Planned posts">
          <div className="grid grid-cols-7 gap-0.5">
            {Array.from({ length: 14 }, (_, i) => {
              const planned = (i === 3 && f >= 0) || (i === 8 && f >= 1) || (i === 12 && f >= 2);
              return (
                <div key={i} className={clsx("grid aspect-square place-items-center rounded-sm text-[6px]", T, planned ? "bg-indigo-500 text-white" : "bg-zinc-100 text-zinc-400")}>
                  {planned ? "✎" : i + 1}
                </div>
              );
            })}
          </div>
        </Panel>
      );
    case "files":
      return (
        <Panel title="assets / files">
          <Row>📁 menus</Row>
          <Row on={f === 1} className={clsx(f === 1 ? "opacity-100" : "-translate-y-1 opacity-0")}>
            📄 <span className="flex-1">price-list.pdf</span>
            <span className="text-zinc-500">120 KB</span>
          </Row>
        </Panel>
      );
    case "notes":
      return (
        <Panel title="AI notes about your site">
          <div className="space-y-1">
            <Row>• Our customers are local families</Row>
            <Row on={f === 1} className={clsx(f === 1 ? "opacity-100" : "opacity-0")}>
              • Always write in British English
            </Row>
          </div>
        </Panel>
      );
    case "code":
      return (
        <Panel title="Custom code">
          <div className="rounded bg-zinc-900 p-1.5 font-mono text-[7px] leading-relaxed text-emerald-300">
            &lt;script src=&quot;gtag.js?id=G-…&quot;&gt;
            <br />
            &lt;/script&gt;
          </div>
          <Pill className={clsx("mt-1", f === 1 ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-500")}>{f === 1 ? "✓ On every page" : "Adding…"}</Pill>
        </Panel>
      );
    case "models":
      return (
        <Panel title="AI settings">
          <Row>
            <span className="flex-1">Writes your pages</span>
            <span className="rounded border border-zinc-300 px-1">{f === 0 ? "Fast ▾" : "Best ▾"}</span>
          </Row>
          <Row>
            <span className="flex-1">Makes your pictures</span>
            <span className="rounded border border-zinc-300 px-1">Standard ▾</span>
          </Row>
        </Panel>
      );
    case "plan": {
      const pages = ["Home", "About us", "Our menu"];
      return (
        <Panel title="Page plan">
          {pages.map((p, i) => (
            <Row key={p}>
              <Tick on={i === 0 || f > i} />
              <span className={clsx(T, i === 0 || f > i ? "" : "text-zinc-400")}>{p}</span>
              {i > 0 && f <= i && <Pill className="ml-auto bg-zinc-100 text-zinc-500">planned</Pill>}
            </Row>
          ))}
        </Panel>
      );
    }
    case "log":
      return (
        <Panel title="Technical log">
          <div className="space-y-0.5 font-mono text-[7px]">
            {["Building your site", "Checking links", "All good"].map((l, i) => (
              <div key={l} className={clsx(T, f >= i ? "opacity-100" : "opacity-0")}>
                <span className={i === 2 ? "text-emerald-600" : "text-zinc-500"}>{i === 2 ? "✓" : "$"}</span> {l}
              </div>
            ))}
          </div>
        </Panel>
      );
    case "changes":
      return (
        <Panel title={`What's changed · ${f + 1} not live yet`}>
          {["Homepage headline", "New Contact page", "Phone number"].map((c, i) => (
            <Row key={c} on={i === f} className={clsx(i > f && "opacity-0")}>
              <span className="flex-1">{c}</span>
              <span className="text-zinc-400 underline">Undo</span>
            </Row>
          ))}
        </Panel>
      );
    case "undo":
      return (
        <Panel title="What's changed">
          <Row>
            <span className="flex-1">New Contact page</span>
            <span className="text-zinc-400 underline">Undo</span>
          </Row>
          <Row on={f === 0} className={clsx(f === 1 && "h-0 overflow-hidden py-0 opacity-0")}>
            <span className="flex-1">Deleted the Gallery</span>
            <span className="font-semibold text-indigo-700 underline">Undo</span>
          </Row>
          <Pill className={clsx("mt-1 bg-emerald-100 text-emerald-800", f === 1 ? "opacity-100" : "opacity-0")}>↩ Gallery is back</Pill>
        </Panel>
      );
    case "versions":
      return (
        <Panel title="Earlier versions">
          {["Today", "Last week", "2 weeks ago"].map((v, i) => (
            <Row key={v} on={f >= 1 && i === 1}>
              <span className="flex-1">{v}</span>
              {f === 2 && i === 1 ? <Pill className="bg-emerald-100 text-emerald-800">Restored</Pill> : i > 0 && <span className="text-zinc-400 underline">Restore</span>}
            </Row>
          ))}
        </Panel>
      );
    case "publish":
      return (
        <div className="space-y-2">
          <div className="flex justify-end">
            <div
              className={clsx(
                "rounded-md px-2 py-1 text-[8px] font-semibold text-white",
                T,
                f === 0 && "bg-violet-600",
                f === 1 && "animate-pulse bg-violet-400",
                f === 2 && "bg-emerald-600",
              )}
            >
              {["Publish", "Publishing…", "✓ It's live"][f]}
            </div>
          </div>
          <Site />
        </div>
      );
    case "updates":
      return (
        <div className="space-y-2">
          <div className={clsx("flex items-center gap-1 rounded border border-zinc-200 bg-white px-1.5 py-1 text-[7px]", T, f === 1 ? "opacity-100" : "-translate-y-1 opacity-0")}>
            <span className="flex-1">Your site was updated with new features.</span>
            <span className="underline">Undo</span>
          </div>
          <div className="flex justify-end">
            <Pill className="bg-white text-zinc-700 ring-1 ring-zinc-200">⚡ {f === 0 ? "10,000" : "9,870"} credits</Pill>
          </div>
        </div>
      );
  }
}
