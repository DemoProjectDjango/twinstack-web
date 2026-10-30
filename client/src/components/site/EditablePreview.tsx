"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, isHomePage, workspacePath, type WorkspaceStatus } from "@/lib/site-api";
import { useAssistant } from "./assistant/AssistantProvider";
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

const SOURCE = "twinstack-preview";
// The width "Computer" shows the site at: a common laptop screen, wide enough for desktop menus.
const DESKTOP_WIDTH = 1280;

type FrameMessage =
  | { type: "ready"; path: string }
  | { type: "scroll"; path: string; y: number }
  | { type: "typing"; on: boolean }
  | { type: "edit"; id: number; path: string; before: string; after: string; index: number; count: number }
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
      if (!ran) setFramePath("");
    }, 800);
  }
  // The page the frame shows (its full path, preview prefix included).
  const [framePath, setFramePath] = useState("");
  // The frame reloads with each new build, but never under someone's typing.
  const [shownVersion, setShownVersion] = useState(version);
  if (shownVersion !== version && !typing) setShownVersion(version);

  // Where the frame is (the page's path and scroll), and where a reloaded frame should go back to.
  const place = useRef({ path: "", y: 0 });
  const restore = useRef<{ path: string; y: number; went: boolean } | null>(null);
  useEffect(() => {
    restore.current = place.current.path ? { ...place.current, went: false } : null;
  }, [shownVersion]);

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
  useEffect(() => {
    if (previewTarget) go(previewTarget.url);
    // Only a new request moves the frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, base]);

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
          body: { address, before: message.before, after: message.after, index: message.index, count: message.count },
        });
        post(frameRef.current, { type: "result", id: message.id, ok: true });
        if (result.file) {
          setStatus(result.status);
          setNote({ tone: "saved", text: savedText(result) });
        } else {
          setNote(null);
        }
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
        const back = wanted && bare(wanted.path) === bare(data.path) ? wanted.y : 0;
        place.current = { path: data.path, y: back };
        setFramePath(data.path);
        if (back) post(frameRef.current, { type: "scroll", y: back });
        post(frameRef.current, { type: "mode", editing: editingRef.current });
        post(frameRef.current, { type: "scale", value: scaleRef.current });
      } else if (data.type === "scroll") {
        place.current = { path: data.path, y: data.y };
      } else if (data.type === "typing") {
        setTyping(data.on);
      } else if (data.type === "edit") {
        if (editingRef.current) void save(data);
      } else if (data.type === "ask-section") {
        askAbout.current(data);
      } else if (data.type === "not-editable") {
        setNote({ tone: "info", text: "That part can't be typed into. Click a heading, a paragraph or a button's words, or ask the AI below to change it." });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [owner, repo, previewUrl, base, setStatus]);

  if (!previewUrl) return null;
  // Text the server couldn't place (the design's own words, text in two places…): the AI can still change it.
  const refused = note?.tone === "error" && note.error instanceof ApiError && note.error.status < 500;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {pages.length > 0 && (
          <label className="flex min-w-0 items-center gap-2 text-sm">
            <span className="text-zinc-500">Page</span>
            <select
              value={shownPage?.url ?? ""}
              onChange={(e) => e.target.value && go(e.target.value)}
              className="max-w-[16rem] truncate rounded-md border border-zinc-300 bg-background px-2 py-1 text-sm font-medium dark:border-zinc-700"
            >
              {!shownPage && <option value="">Another page</option>}
              {pages.map((p) => (
                <option key={p.url} value={p.url}>
                  {p.title}
                  {p.draft ? " (hidden)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="min-w-0 flex-1 text-sm text-zinc-500">
          {editing
            ? "Click any words on your site and type: Enter or clicking away saves, Esc puts it back. To change more, use \"Ask the AI to change this section\"."
            : "Links and buttons work as they do on your live site."}
        </p>
        <Button
          variant="ghost"
          aria-pressed={!editing}
          onClick={() => {
            setEditing(!editing);
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
          key={shownVersion}
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
