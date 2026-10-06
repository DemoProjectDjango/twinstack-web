"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, assistantApi, attachmentUrl, type Attachment } from "@/lib/assistant-api";
import { useSite } from "../site-context";

// Files attached to the next message to Claude: picked with the paperclip, dropped on the box or
// pasted. Each uploads straight away (so sending is quick); the message carries their ids.

export type PendingAttachment = {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  attachment?: Attachment;
  error?: string;
  /** A local preview for images while they upload. */
  preview?: string;
};

const sizeLabel = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const BADGE: Record<Attachment["kind"], string> = { image: "IMG", pdf: "PDF", text: "TXT", document: "DOC", file: "FILE" };

function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."));
    reader.readAsDataURL(file);
  });
}

/** The files waiting to go with the next message. */
export function useAttachmentUploads() {
  const { owner, repo } = useSite();
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const previews = useRef(new Set<string>());

  // Local previews are freed when the box goes away.
  useEffect(() => {
    const urls = previews.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const update = useCallback(
    (key: string, change: Partial<PendingAttachment>) => setPending((list) => list.map((p) => (p.key === key ? { ...p, ...change } : p))),
    [],
  );

  // How many are attached right now, for the limit (kept current between quick successive picks).
  const count = useRef(0);
  useEffect(() => {
    count.current = pending.length;
  }, [pending]);

  const add = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      const taken = list.slice(0, Math.max(0, MAX_ATTACHMENTS - count.current));
      const uploads: [PendingAttachment, File][] = [];
      const added: PendingAttachment[] = taken.map((file) => {
        const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
        const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
        if (preview) previews.current.add(preview);
        if (file.size > MAX_ATTACHMENT_BYTES) return { key, name: file.name, size: file.size, status: "error", error: "Over 10 MB", preview };
        if (!file.size) return { key, name: file.name, size: 0, status: "error", error: "Empty file", preview };
        const entry: PendingAttachment = { key, name: file.name, size: file.size, status: "uploading", preview };
        uploads.push([entry, file]);
        return entry;
      });
      const skipped = list.length - taken.length;
      if (skipped) {
        added.push({ key: `limit-${Date.now()}`, name: `${skipped} more file${skipped === 1 ? "" : "s"}`, size: 0, status: "error", error: `Attach up to ${MAX_ATTACHMENTS} files at a time` });
      }
      count.current += added.length;
      setPending((current) => [...current, ...added]);
      for (const [entry, file] of uploads) {
        void (async () => {
          try {
            const { attachment } = await assistantApi.attach(owner, repo, { name: file.name, data: await readBase64(file) });
            update(entry.key, { status: "ready", attachment });
          } catch (err) {
            update(entry.key, { status: "error", error: err instanceof Error ? err.message : "Upload failed" });
          }
        })();
      }
    },
    [owner, repo, update],
  );

  const remove = useCallback((key: string) => setPending((list) => list.filter((p) => p.key !== key)), []);
  const clear = useCallback(() => setPending([]), []);

  return {
    pending,
    add,
    remove,
    clear,
    ready: pending.flatMap((p) => (p.status === "ready" && p.attachment ? [p.attachment] : [])),
    uploading: pending.some((p) => p.status === "uploading"),
  };
}

/** The paperclip: picks any number of files of any type. */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: FileList) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled}
        aria-label="Attach files"
        title="Attach files: photos, PDFs, Word documents, web pages or anything else"
        className="grid size-9 shrink-0 place-items-center rounded-md border border-zinc-300 text-base hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        <span aria-hidden="true">📎</span>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}

function KindBadge({ kind }: { kind: Attachment["kind"] }) {
  return (
    <span aria-hidden="true" className="grid h-8 w-9 shrink-0 place-items-center rounded bg-zinc-200 text-[10px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      {BADGE[kind]}
    </span>
  );
}

/** The files waiting to be sent, with their upload state. */
export function PendingChips({ pending, onRemove }: { pending: PendingAttachment[]; onRemove: (key: string) => void }) {
  if (!pending.length) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Attached files">
      {pending.map((p) => (
        <li
          key={p.key}
          className={`flex max-w-full items-center gap-2 rounded-md border bg-background py-1 pl-1 pr-2 text-xs ${
            p.status === "error" ? "border-red-300 dark:border-red-900" : "border-zinc-200 dark:border-zinc-800"
          }`}
        >
          {p.preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.preview} alt="" className="size-8 shrink-0 rounded object-cover" />
          ) : (
            <KindBadge kind={p.attachment?.kind ?? "file"} />
          )}
          <span className="min-w-0">
            <span className="block max-w-40 truncate font-medium" title={p.name}>
              {p.name}
            </span>
            <span className={`block ${p.status === "error" ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>
              {p.status === "uploading" ? "Uploading…" : p.status === "error" ? p.error : p.attachment?.note ? `Claude can't read it (${p.attachment.note})` : p.attachment?.kind === "file" ? "Can be added to your site" : sizeLabel(p.size)}
            </span>
          </span>
          <button type="button" onClick={() => onRemove(p.key)} aria-label={`Remove ${p.name}`} className="ml-1 text-zinc-500 hover:text-foreground">
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The files a sent message carried, in its bubble: photos as thumbnails, the rest as downloads. */
export function SentAttachments({ attachments }: { attachments: Attachment[] }) {
  const { owner, repo } = useSite();
  return (
    <ul className="flex flex-wrap justify-end gap-2">
      {attachments.map((a) =>
        a.kind === "image" ? (
          <li key={a.id}>
            <a href={attachmentUrl(owner, repo, a.id)} target="_blank" rel="noreferrer" title={a.name}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={attachmentUrl(owner, repo, a.id)} alt={a.name} className="h-20 max-w-40 rounded-lg border border-zinc-200 object-cover dark:border-zinc-800" />
            </a>
          </li>
        ) : (
          <li key={a.id}>
            <a
              href={attachmentUrl(owner, repo, a.id)}
              download={a.name}
              className="flex items-center gap-2 rounded-lg border border-zinc-200 py-1 pl-1 pr-3 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              <KindBadge kind={a.kind} />
              <span className="max-w-40 truncate">{a.name}</span>
            </a>
          </li>
        ),
      )}
    </ul>
  );
}

/** Drag-and-drop of files onto a box: the handlers, and whether files are being dragged over it. */
export function useFileDrop(onFiles: (files: FileList) => void, enabled = true) {
  const [over, setOver] = useState(false);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  return {
    over,
    handlers: enabled
      ? {
          onDragEnter: (e: DragEvent) => hasFiles(e) && (e.preventDefault(), setOver(true)),
          onDragOver: (e: DragEvent) => hasFiles(e) && e.preventDefault(),
          onDragLeave: (e: DragEvent) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
          },
          onDrop: (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setOver(false);
            if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
          },
        }
      : {},
  };
}
