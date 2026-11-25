"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, isHomePage, workspacePath, type WorkspaceStatus } from "@/lib/site-api";
import { useAssistant } from "./assistant/AssistantProvider";
import { noteFeature } from "./FeatureGuide";
import { useSite } from "./site-context";
import { Button, ErrorText, Notice, Spinner } from "./ui";

// The site preview, with click-to-edit: the preview's own script (server/src/preview/inline-edit.js,
// added by the preview route) makes the text the owner clicks editable and sends it here, and this
// saves it with POST …/pages/text. No AI, no credits: the automatic preview rebuilds afterwards.
// Editing is on from the start. While it's on, the script stops links and buttons inside the page
// body from acting (the header menu still works), so it can be switched off to try them.
// The frame waits for the owner to finish typing before it reloads, and comes back to the page and
// scroll position it was showing. "Page" picks another page, as does "Edit on site" in Pages
// (`previewTarget` in the context). While editing, the frame's "Ask the AI to change this section"
// opens the AI's conversation with that request started (`ask-section`: the section's heading,
// first words and place), for the owner to finish. The page shown is the AI's open page.
// "Refresh preview" reloads only the frame, on the same page and scroll position. Switching between
// computer and phone loads the page again at the new width too: a page's own script that sizes things
// once when it loads (a slider, a carousel, a "phone or not" check) would otherwise keep the old
// width's layout, which a real phone never shows.

const SOURCE = "twinstack-preview";
// The width "Computer" shows the site at: a common laptop screen, wide enough for desktop menus.
const DESKTOP_WIDTH = 1280;

type FrameMessage =
  | { type: "ready"; path: string }
  // `ratio`: the share of the page scrolled (0 at the top, 1 at the end).
  | { type: "scroll"; path: string; y: number; ratio?: number }
  | { type: "typing"; on: boolean }
  | { type: "edit"; id: number; path: string; before: string; after: string; index: number; count: number; tag?: string }
  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y pressed in the frame while nothing is being typed: undo or redo the owner's last edit.
  | { type: "history"; direction: "undo" | "redo" }
  // The style bar (bold/italic/underline on picked words, alignment or colour): POST …/pages/style, no AI.
  | {
      type: "style";
      id: number;
      path: string;
      text: string;
      index: number;
      count: number;
      tag: string;
      selection: { start: number; end: number } | null;
      style: { kind: "bold" | "italic" | "underline" | "align" | "color"; value?: string };
    }
  | { type: "not-editable" }
  | { type: "ask-section"; path: string; heading: string; start: string; position: number; count: number };

type Note = { tone: "info" | "saving" | "saved" | "error"; text?: string; error?: unknown };

type SaveResult = {
  file: string | null;
  where?: "page" | "shared" | "details" | "other";
  label?: string | null;
  title?: string | null;
  status: WorkspaceStatus;
};

/** What the saved message says, by where the text was kept (server/src/text-edit.js). */
function savedText({ where, label, title }: SaveResult) {
  const after = " The preview shows it in a moment; publish when you're ready.";
  if (where === "shared") return `Saved. This text is shared across your site, so it changed everywhere it appears.${after}`;
  if (where === "details") return `Saved. It's part of your business info, so it changed everywhere it appears.${after}`;
  if (where === "other") {
    const field = label === "title" ? "title" : label === "description" ? "description" : "text";
    return `Saved. It's the ${field} of the page “${title ?? "another page"}”, so it changed there too.${after}`;
  }
  return `Saved.${after}`;
}

function post(frame: HTMLIFrameElement | null, message: Record<string, unknown>) {
  frame?.contentWindow?.postMessage({ source: SOURCE, ...message }, "*");
}

/**
 * A path without a folder's index.html or its trailing slash, so "/x/", "/x" and "/x/index.html"
 * (and the homepage: "/" and "/index.html") match.
 */
const bare = (path: string) => path.replace(/\/index\.html$/i, "").replace(/\/+$/, "");

/** `onPath`: the preview address of the page shown, so "Open full size" opens that page. */
export function EditablePreview({ dimmed, phone, onPath }: { dimmed: boolean; phone: boolean; onPath?: (path: string) => void }) {
  const { owner, repo, status, overview, version, claude, setStatus, previewTarget, setShownPage, showSection } = useSite();
  const { fillDraft } = useAssistant();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [editing, setEditing] = useState(true);
  const [typing, setTyping] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  // Undo and redo of the owner's own edits here (server/src/undo-history.js), by button or Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
  const [history, setHistory] = useState<{ canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null } | null>(null);
  const stepping = useRef(false);
  // The frame's script says "ready" before the page's load event. A load without it means the script
  // never ran: the page is broken (a tag never closed hides the rest of it, the script included), so
  // editing can't work there and the owner is told instead of clicks doing nothing.
  const readySinceLoad = useRef(false);
  const [silent, setSilent] = useState(false);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (loadTimer.current) clearTimeout(loadTimer.current);
  }, []);
  function frameLoaded() {
    if (loadTimer.current) clearTimeout(loadTimer.current);
    // A moment's grace: the message can arrive just after the load event.
    loadTimer.current = setTimeout(() => {
      const ran = readySinceLoad.current;
      readySinceLoad.current = false;
      setSilent(!ran);
      if (!ran) {
        setFramePath("");
        setReloading(false);
      }
    }, 800);
  }
  // The page the frame shows (its full path, preview prefix included).
  const [framePath, setFramePath] = useState("");
  // The frame reloads with each new build, but never under someone's typing. Only a new build: after
  // every command (the AI's work going on behind "See it") it kept reloading and never settled.
  // Servers too old to say when it was built fall back to every change.
  const build = status.builtAt === undefined ? `v${version}` : `b${status.builtAt}`;
  const [shownVersion, setShownVersion] = useState(build);
  if (shownVersion !== build && !typing) setShownVersion(build);

  // Where the frame is (the page's path and scroll), and where a reloaded frame should go back to.
  // A restore with a `ratio` scrolls to that share of the page instead of to `y`.
  const place = useRef<{ path: string; y: number; ratio?: number }>({ path: "", y: 0 });
  const restore = useRef<{ path: string; y: number; ratio?: number; went: boolean } | null>(null);
  useEffect(() => {
    restore.current = place.current.path ? { path: place.current.path, y: place.current.y, went: false } : null;
  }, [shownVersion]);

  // "Refresh preview" (and a switch of width) loads a new frame: `reload` is part of its key.
  const [reload, setReload] = useState(0);
  const [reloading, setReloading] = useState(false);
  function refreshFrame() {
    restore.current = place.current.path ? { path: place.current.path, y: place.current.y, went: false } : null;
    setTyping(false);
    setReloading(true);
    setReload((n) => n + 1);
  }
  // Computer ↔ phone: the frame's key has the width in it, so the page loads afresh at the new
  // width. The same place on the page is a different y there, so it goes back by share of the page.
  const device = phone ? "phone" : "computer";
  const [shownDevice, setShownDevice] = useState(device);
  if (shownDevice !== device) {
    setShownDevice(device);
    setTyping(false);
    setReloading(true);
  }
  useEffect(() => {
    const { path, ratio } = place.current;
    restore.current = path ? { path, y: 0, ratio: ratio ?? 0, went: false } : null;
  }, [device]);

  const previewUrl = status.previewUrl;

  // The preview box's size. On a computer, the site is laid out at DESKTOP_WIDTH and scaled to the box,
  // since the editor's column is narrower than most screens and sites switch to a phone menu below it.
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setBox({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [previewUrl]);
  const scale = !phone && box.width > 0 && box.width < DESKTOP_WIDTH ? box.width / DESKTOP_WIDTH : 1;
  // The frame keeps the AI's section button readable at this scale (sent again on every "ready").
  const scaleRef = useRef(scale);
  useEffect(() => {
    scaleRef.current = scale;
    post(frameRef.current, { type: "scale", value: scale });
  }, [scale]);
  // Without its trailing slash: the homepage is served at …/<signature> too (Next.js drops the slash).
  const base = useMemo(() => (previewUrl ? bare(new URL(previewUrl, "http://x").pathname) : ""), [previewUrl]);
  const editingRef = useRef(editing);
  useEffect(() => {
    editingRef.current = editing;
    post(frameRef.current, { type: "mode", editing });
  }, [editing]);

  // The site's pages, for "Page": the homepage first, then by title. Hidden pages are in the preview too.
  const pages = useMemo(
    () =>
      (overview?.collections.flatMap((c) => c.pages) ?? [])
        .filter((p) => isHomePage(p) || p.address || p.url)
        .map((p) => ({ file: p.file, title: p.title, url: isHomePage(p) ? "/" : ((p.address ?? p.url) as string), home: isHomePage(p), draft: p.draft }))
        .sort((a, b) => Number(b.home) - Number(a.home) || a.title.localeCompare(b.title)),
    [overview],
  );
  const shownPage = pages.find((p) => bare(`${base}${p.url}`) === bare(framePath));
  const pageAt = (path: string) => pages.find((p) => bare(`${base}${p.url}`) === bare(path));

  // The AI's open page is the one shown here, while Edit site is open.
  const shownFile = shownPage?.file ?? null;
  useEffect(() => {
    if (framePath) onPath?.(framePath);
  }, [framePath, onPath]);
  useEffect(() => {
    setShownPage(shownFile);
  }, [shownFile, setShownPage]);
  useEffect(() => () => setShownPage(null), [setShownPage]);

  // "Ask the AI to change this section": the request is started, and the owner says what to change.
  // A ref, so the frame's listener (set up once per preview) always has the latest pages and access.
  const askAbout = useRef<(message: Extract<FrameMessage, { type: "ask-section" }>) => void>(() => {});
  useEffect(() => {
    askAbout.current = (message) => {
      if (!claude.ready) {
        setNote({ tone: "info", text: claude.reason || "The AI isn't set up for this site yet." });
        return;
      }
      const page = pageAt(message.path);
      const address = message.path.startsWith(base) ? message.path.slice(base.length) || "/" : message.path;
      const where = page ? `the “${page.title}” page (${page.url})` : `the page at ${address}`;
      const which = message.heading ? `the section headed “${message.heading}”` : `the section that starts “${message.start}”`;
      const place = message.count > 1 ? ` (section ${message.position} of ${message.count})` : "";
      fillDraft(`On ${where}, change ${which}${place}: `);
    };
  });

  function go(url: string) {
    if (!base) return;
    const path = `${base}${url}`;
    // If the frame is still loading, it goes there once it's ready.
    restore.current = { path, y: 0, went: false };
    post(frameRef.current, { type: "go", path });
  }

  // "Edit on site" from another screen.
  const target = previewTarget?.n ?? 0;
  // Each request moves the frame once: the preview going missing for a moment during a rebuild (base
  // "" and back) mustn't send the owner back there after they've moved on.
  const wentTo = useRef(0);
  useEffect(() => {
    if (previewTarget && base && wentTo.current !== previewTarget.n) {
      wentTo.current = previewTarget.n;
      go(previewTarget.url);
    }
    // Only a new request moves the frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, base]);

  const loadHistory = useCallback(() => {
    api<{ history: NonNullable<typeof history> }>(workspacePath(owner, repo, "/pages/history"))
      .then((data) => setHistory(data.history))
      .catch(() => {});
  }, [owner, repo]);
  useEffect(() => {
    loadHistory();
  }, [loadHistory, version]);

  const stepHistory = useCallback(
    async (direction: "undo" | "redo") => {
      if (stepping.current) return;
      stepping.current = true;
      setNote({ tone: "saving" });
      try {
        const result = await api<{ label: string; history: NonNullable<typeof history>; status: WorkspaceStatus }>(workspacePath(owner, repo, `/pages/${direction}`), { method: "POST", body: {} });
        setHistory(result.history);
        setStatus(result.status);
        setNote({ tone: "saved", text: `${direction === "undo" ? "Undid" : "Redid"} the ${result.label}. The preview updates by itself.` });
      } catch (err) {
        setNote({ tone: "error", error: err });
        loadHistory();
      } finally {
        stepping.current = false;
      }
    },
    [owner, repo, setStatus, loadHistory],
  );

  // The frame's messages are handled in an effect set up once per preview: it reaches the latest through this.
  const stepHistoryRef = useRef(stepHistory);
  useEffect(() => {
    stepHistoryRef.current = stepHistory;
  }, [stepHistory]);

  // Ctrl+Z (Cmd+Z on a Mac) undoes, Ctrl+Shift+Z or Ctrl+Y redoes, while the editor itself has the
  // keyboard (not a box being typed in, which keeps its own undo). The frame sends the same keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      const direction = key === "z" ? (event.shiftKey ? "redo" : "undo") : key === "y" ? "redo" : null;
      if (!direction) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
      if (el?.closest?.("dialog[open]")) return;
      event.preventDefault();
      void stepHistory(direction);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepHistory]);

  useEffect(() => {
    if (!previewUrl) return;

    async function save(message: Extract<FrameMessage, { type: "edit" }>) {
      if (message.path !== base && !message.path.startsWith(`${base}/`)) {
        post(frameRef.current, { type: "result", id: message.id, ok: false });
        setNote({ tone: "error", text: "That page isn't part of this preview, so the change wasn't saved. Reload the page and try again." });
        return;
      }
      const address = message.path.slice(base.length) || "/";
      setNote({ tone: "saving" });
      try {
        const result = await api<SaveResult>(workspacePath(owner, repo, "/pages/text"), {
          method: "POST",
          body: { address, before: message.before, after: message.after, index: message.index, count: message.count, tag: message.tag },
        });
        post(frameRef.current, { type: "result", id: message.id, ok: true });
        if (result.file) {
          setStatus(result.status);
          setNote({ tone: "saved", text: savedText(result) });
          noteFeature("edit-text");
          loadHistory();
        } else {
          setNote(null);
        }
      } catch (err) {
        post(frameRef.current, { type: "result", id: message.id, ok: false });
        setNote({ tone: "error", error: err });
      }
    }

    async function saveStyle(message: Extract<FrameMessage, { type: "style" }>) {
      if (message.path !== base && !message.path.startsWith(`${base}/`)) {
        post(frameRef.current, { type: "result", id: message.id, ok: false });
        return;
      }
      const address = message.path.slice(base.length) || "/";
      setNote({ tone: "saving" });
      try {
        const result = await api<{ file: string; status: WorkspaceStatus }>(workspacePath(owner, repo, "/pages/style"), {
          method: "POST",
          body: { address, text: message.text, index: message.index, count: message.count, tag: message.tag, selection: message.selection, style: message.style },
        });
        post(frameRef.current, { type: "result", id: message.id, ok: true });
        setStatus(result.status);
        setNote({ tone: "saved", text: "Saved. The preview updates by itself, and it goes live when you publish." });
        loadHistory();
        noteFeature("edit-text");
      } catch (err) {
        post(frameRef.current, { type: "result", id: message.id, ok: false });
        setNote({ tone: "error", error: err });
      }
    }

    function onMessage(event: MessageEvent) {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as (FrameMessage & { source?: string }) | null;
      if (!data || data.source !== SOURCE) return;
      if (data.type === "ready") {
        readySinceLoad.current = true;
        setSilent(false);
        const wanted = restore.current;
        if (wanted && !wanted.went && bare(wanted.path) !== bare(data.path)) {
          wanted.went = true;
          post(frameRef.current, { type: "go", path: wanted.path });
          return;
        }
        restore.current = null;
        setReloading(false);
        const here = wanted && bare(wanted.path) === bare(data.path);
        const back = here ? wanted.y : 0;
        place.current = { path: data.path, y: back, ratio: here ? wanted.ratio : undefined };
        setFramePath(data.path);
        if (here && wanted.ratio) post(frameRef.current, { type: "scroll", ratio: wanted.ratio });
        else if (back) post(frameRef.current, { type: "scroll", y: back });
        post(frameRef.current, { type: "mode", editing: editingRef.current });
        post(frameRef.current, { type: "scale", value: scaleRef.current });
      } else if (data.type === "scroll") {
        place.current = { path: data.path, y: data.y, ratio: typeof data.ratio === "number" ? data.ratio : undefined };
      } else if (data.type === "typing") {
        setTyping(data.on);
      } else if (data.type === "edit") {
        if (editingRef.current) void save(data);
      } else if (data.type === "style") {
        if (editingRef.current) void saveStyle(data);
      } else if (data.type === "history") {
        void stepHistoryRef.current(data.direction);
      } else if (data.type === "ask-section") {
        askAbout.current(data);
        noteFeature("ask-section");
      } else if (data.type === "not-editable") {
        setNote({ tone: "info", text: "That part can't be typed into. Click a heading, a paragraph or a button's words, or ask the AI below to change it." });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [owner, repo, previewUrl, base, setStatus, loadHistory]);

  if (!previewUrl) return null;
  // Text the server couldn't place (the design's own words, text in two places…): the AI can still change it.
  const refused = note?.tone === "error" && note.error instanceof ApiError && note.error.status < 500;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {pages.length > 0 && (
          <div data-tour="page-picker" className="flex min-w-0 items-center gap-2 text-sm">
            <span className="text-zinc-500">Page</span>
            <PagePicker
              pages={pages}
              shown={shownPage ?? null}
              onPick={(url) => {
                go(url);
                noteFeature("preview-page");
              }}
            />
          </div>
        )}
        <p className="min-w-0 flex-1 text-sm text-zinc-500">
          {editing
            ? "Click any words on your site and type: Enter or clicking away saves, Esc puts it back. To change more, use \"Ask the AI to change this section\"."
            : "Links and buttons work as they do on your live site."}
        </p>
        <Button
          variant="ghost"
          title="Refresh preview"
          aria-label="Refresh preview"
          aria-busy={reloading}
          onClick={refreshFrame}
          className="inline-flex items-center gap-1.5 text-zinc-600 hover:text-foreground dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className={`size-4 ${reloading ? "animate-spin" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </Button>
        <Button
          variant="ghost"
          title={history?.undoLabel ? `Undo the ${history.undoLabel} (Ctrl+Z)` : "Nothing to undo (Ctrl+Z)"}
          disabled={!history?.canUndo}
          onClick={() => void stepHistory("undo")}
        >
          ↶ Undo
        </Button>
        <Button
          variant="ghost"
          title={history?.redoLabel ? `Redo the ${history.redoLabel} (Ctrl+Shift+Z)` : "Nothing to redo (Ctrl+Shift+Z)"}
          disabled={!history?.canRedo}
          onClick={() => void stepHistory("redo")}
        >
          ↷ Redo
        </Button>
        <Button
          variant="ghost"
          data-tour="try-links"
          aria-pressed={!editing}
          onClick={() => {
            setEditing(!editing);
            if (editing) noteFeature("try-links");
            if (editing) setTyping(false);
            setNote(null);
          }}
        >
          {editing ? "Stop editing to try links" : "Edit words"}
        </Button>
      </div>
      <div aria-live="polite">
        {note?.tone === "saving" && (
          <Notice>
            <span className="flex items-center gap-2">
              <Spinner /> Saving your change…
            </span>
          </Notice>
        )}
        {note?.tone === "saved" && <Notice tone="success">{note.text}</Notice>}
        {note?.tone === "info" && <Notice>{note.text}</Notice>}
        {note?.tone === "error" && (
          <Notice tone="warning">
            <ErrorText error={note.error ?? note.text} />
            {refused && <p className="mt-1 text-sm">To change these words, tell the AI below what they should say.</p>}
          </Notice>
        )}
      </div>
      {silent && (
        <Notice tone="warning">
          <span className="font-medium">Editing doesn&apos;t work on this page.</span> Something in it is broken (often the page stops
          part-way through), so the editor can&apos;t attach to it. What&apos;s changed lists what&apos;s wrong, with a way to fix it.{" "}
          <Button variant="ghost" className="ml-1 underline" onClick={() => showSection("publish")}>
            See what&apos;s wrong
          </Button>
        </Notice>
      )}
      {/* The box keeps the editor's size; on a computer the site inside it is laid out at a real
          desktop width and scaled down to fit, so it shows its desktop menu and columns. */}
      <div
        ref={boxRef}
        className={`relative mx-auto h-[calc(100vh-16rem)] min-h-128 overflow-hidden rounded-md border bg-white dark:border-zinc-800 ${
          editing ? "border-blue-300 ring-2 ring-blue-500/15" : "border-zinc-200"
        } ${phone ? "w-[390px] max-w-full" : "w-full"} ${dimmed && !typing ? "opacity-60" : ""}`}
      >
        {/* Sandboxed without allow-same-origin: the site's scripts can't act as the user on this app. */}
        <iframe
          ref={frameRef}
          key={`${shownVersion}:${device}:${reload}`}
          src={previewUrl}
          onLoad={frameLoaded}
          title="Your site"
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          className="absolute left-0 top-0 block border-0"
          style={
            scale < 1
              ? { width: DESKTOP_WIDTH, height: box.height / scale, transform: `scale(${scale})`, transformOrigin: "0 0" }
              : { width: "100%", height: "100%" }
          }
        />
      </div>
    </div>
  );
}

type PickerPage = { file: string; title: string; url: string; home: boolean; draft?: boolean };

/**
 * Edit site's "Page": the page shown, and a search over every page to show another. Type part of a
 * title or address; arrow keys move, Enter shows it, Escape or a click outside closes.
 */
function PagePicker({ pages, shown, onPick }: { pages: PickerPage[]; shown: PickerPage | null; onPick: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listId = "page-picker-list";

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = pages.filter((p) => words.every((w) => p.title.toLowerCase().includes(w) || p.url.toLowerCase().includes(w)));
  const at = Math.min(active, Math.max(0, found.length - 1));

  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function pick(page: PickerPage) {
    setOpen(false);
    setQuery("");
    if (page.url !== shown?.url) onPick(page.url);
  }

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setQuery("");
          setActive(Math.max(0, pages.findIndex((p) => p.url === shown?.url)));
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Show another page: search by its name or address"
        className="flex h-8 max-w-[16rem] cursor-pointer items-center gap-2 rounded-md border border-zinc-300 bg-background px-2 text-sm font-medium hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-600"
      >
        <span className="truncate">{shown ? shown.title : "Another page"}</span>
        {shown?.draft && <span className="text-xs font-normal text-zinc-500">(hidden)</span>}
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3.5 shrink-0 text-zinc-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-zinc-200 bg-background shadow-xl dark:border-zinc-800">
          <div className="relative border-b border-zinc-100 dark:border-zinc-800">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive(Math.min(at + 1, found.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive(Math.max(at - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (found[at]) pick(found[at]);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                }
              }}
              placeholder="Search pages…"
              aria-label="Search your pages"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={found[at] ? `page-picker-${at}` : undefined}
              className="h-10 w-full bg-transparent pl-9 pr-3 text-sm outline-none"
            />
          </div>
          <ul id={listId} role="listbox" aria-label="Your pages" className="max-h-72 overflow-y-auto p-1">
            {found.length === 0 && <li className="px-3 py-2 text-sm text-zinc-500">No page matches “{query}”.</li>}
            {found.map((p, i) => (
              <li
                key={p.url}
                id={`page-picker-${i}`}
                role="option"
                aria-selected={i === at}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(p)}
                className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm ${i === at ? "bg-indigo-50 text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-100" : ""}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {p.title}
                    {p.draft && <span className="ml-1 font-normal text-zinc-500">(hidden)</span>}
                  </span>
                  <span className="block truncate text-xs text-zinc-500">{p.url}</span>
                </span>
                {p.home && <span className="shrink-0 rounded-full border border-zinc-200 px-1.5 text-[11px] text-zinc-500 dark:border-zinc-700">Homepage</span>}
                {p.url === shown?.url && <span className="shrink-0 text-xs text-indigo-600 dark:text-indigo-300">Showing</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
