"use client";

import { useEffect, useRef, useState } from "react";
import { api, workspacePath, type WorkspaceStatus } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Button, ErrorText, Notice, Spinner } from "./ui";

// The site preview, with "Edit text": the preview's own script (server/src/preview/inline-edit.js,
// added by the preview route) makes the text the owner clicks editable and sends it here, and this
// saves it with POST …/pages/text. No Claude, no credits: the automatic preview rebuilds afterwards.
// The frame waits for the owner to finish typing before it reloads, and comes back to the page and
// scroll position it was showing.

const SOURCE = "twinstack-preview";

type FrameMessage =
  | { type: "ready"; path: string }
  | { type: "scroll"; path: string; y: number }
  | { type: "typing"; on: boolean }
  | { type: "edit"; id: number; path: string; before: string; after: string; index: number; count: number }
  | { type: "not-editable" };

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
  if (where === "details") return `Saved. It's one of your site details, so it changed everywhere it appears.${after}`;
  if (where === "other") {
    const field = label === "title" ? "title" : label === "description" ? "description" : "text";
    return `Saved. It's the ${field} of the page “${title ?? "another page"}”, so it changed there too.${after}`;
  }
  return `Saved.${after}`;
}

function post(frame: HTMLIFrameElement | null, message: Record<string, unknown>) {
  frame?.contentWindow?.postMessage({ source: SOURCE, ...message }, "*");
}

export function EditablePreview({ dimmed, phone }: { dimmed: boolean; phone: boolean }) {
  const { owner, repo, status, version, setStatus } = useSite();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [editing, setEditing] = useState(false);
  const [typing, setTyping] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
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
  const editingRef = useRef(editing);
  useEffect(() => {
    editingRef.current = editing;
    post(frameRef.current, { type: "mode", editing });
  }, [editing]);

  useEffect(() => {
    if (!previewUrl) return;
    // Without its trailing slash: the homepage is served at …/<signature> too (Next.js drops the slash).
    const base = new URL(previewUrl, window.location.href).pathname.replace(/\/$/, "");

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
        const wanted = restore.current;
        if (wanted && !wanted.went && wanted.path !== data.path) {
          wanted.went = true;
          post(frameRef.current, { type: "go", path: wanted.path });
          return;
        }
        restore.current = null;
        const back = wanted && wanted.path === data.path ? wanted.y : 0;
        place.current = { path: data.path, y: back };
        if (back) post(frameRef.current, { type: "scroll", y: back });
        post(frameRef.current, { type: "mode", editing: editingRef.current });
      } else if (data.type === "scroll") {
        place.current = { path: data.path, y: data.y };
      } else if (data.type === "typing") {
        setTyping(data.on);
      } else if (data.type === "edit") {
        if (editingRef.current) void save(data);
      } else if (data.type === "not-editable") {
        setNote({ tone: "info", text: "That part can't be typed into. Click a heading, a paragraph or a button's words." });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [owner, repo, previewUrl, setStatus]);

  if (!previewUrl) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={editing ? "primary" : "secondary"}
          aria-pressed={editing}
          onClick={() => {
            setEditing(!editing);
            if (editing) setTyping(false);
            setNote(null);
          }}
        >
          {editing ? "Done editing" : "Edit text"}
        </Button>
        <p className="text-sm text-zinc-500">
          {editing
            ? "Click a heading, paragraph or button on your page and type. Enter or clicking away saves it, Esc puts it back. Use the menu to go to another page."
            : "Change words on your pages by typing straight into the preview. It's free and doesn't use Claude."}
        </p>
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
          </Notice>
        )}
      </div>
      {/* Sandboxed without allow-same-origin: the site's scripts can't act as the user on this app. */}
      <iframe
        ref={frameRef}
        key={shownVersion}
        src={previewUrl}
        title="Site preview"
        sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
        className={`mx-auto block h-[40rem] rounded-md border bg-white dark:border-zinc-800 ${
          editing ? "border-blue-500 ring-2 ring-blue-500/30" : "border-zinc-200"
        } ${phone ? "w-[390px] max-w-full" : "w-full"} ${dimmed && !editing ? "opacity-60" : ""}`}
      />
    </div>
  );
}
