"use client";

import { useState } from "react";
import { api, workspacePath, type WorkspaceStatus } from "@/lib/site-api";
import { toast } from "@/lib/toast";
import { BRING_IN_ALL_EVENT } from "./OriginalPages";
import { useSite } from "./site-context";
import { ErrorText } from "./ui";

// Upload a website (.zip) (server/src/site-zip.js): a whole website's files, from a zip of its
// folder. It goes up in pieces (the server in front takes 16 MB a request), is unpacked on the
// server with strict limits, and its pages are then brought in looking as they did, by "Pages from
// your old site" (OriginalPages), which this starts.

const MAX_MB = 200;
const PIECE_BYTES = 6 * 1024 * 1024;

type Finished = { pages: string[]; files: number; replaced?: number; skipped: { name: string; reason: string }[]; status: WorkspaceStatus };

/** A slice of the file as base64 (without the data: prefix). */
function piece(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("The file couldn't be read."));
    reader.readAsDataURL(blob);
  });
}

export function SiteZipUpload() {
  const { owner, repo, busy, setStatus, refresh, claude } = useSite();
  const [progress, setProgress] = useState<number | null>(null);
  const [stage, setStage] = useState<"uploading" | "unpacking" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<Finished | null>(null);

  async function upload(file: File) {
    setError(null);
    setResult(null);
    if (!/\.zip$/i.test(file.name)) {
      setError(new Error("Choose a .zip file: the website's folder, compressed."));
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setError(new Error(`${file.name} is over ${MAX_MB} MB. Leave out videos and very large files, then compress the folder again.`));
      return;
    }
    try {
      setStage("uploading");
      setProgress(0);
      const { id } = await api<{ id: string }>(workspacePath(owner, repo, "/site-zip/start"), { method: "POST", body: {} });
      const pieces = Math.max(1, Math.ceil(file.size / PIECE_BYTES));
      for (let index = 0; index < pieces; index++) {
        const data = await piece(file.slice(index * PIECE_BYTES, (index + 1) * PIECE_BYTES));
        await api(workspacePath(owner, repo, "/site-zip/chunk"), { method: "POST", body: { id, index, data } });
        setProgress(Math.round(((index + 1) / pieces) * 100));
      }
      setStage("unpacking");
      const finished = await api<Finished>(workspacePath(owner, repo, "/site-zip/finish"), { method: "POST", body: { id, name: file.name } });
      setStatus(finished.status);
      setResult(finished);
      await refresh();
      const updated = finished.replaced ? ` (${finished.replaced} replaced their earlier versions)` : "";
      toast.success(`Added ${finished.pages.length} ${finished.pages.length === 1 ? "page" : "pages"} and ${finished.files} files from ${file.name}${updated}. Bringing the pages in now.`);
      // The list below brings every page in, looking as it did.
      window.dispatchEvent(new Event(BRING_IN_ALL_EVENT));
    } catch (err) {
      setError(err);
    } finally {
      setStage(null);
      setProgress(null);
    }
  }

  const working = stage !== null;
  return (
    <section aria-label="Upload a website" className="rounded-lg border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <h3 className="font-medium">Upload a website (.zip)</h3>
          <p className="mt-0.5 text-sm text-zinc-500">
            Have your website&apos;s files? Compress its folder into a .zip (up to {MAX_MB} MB) and upload it: every page comes in
            looking as it did, with its pictures, fonts and styles. Building the pages uses some AI credits each.
          </p>
        </div>
        <label
          className={`inline-flex rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background ${working || busy || !claude.ready ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:opacity-90"}`}
        >
          {stage === "uploading" ? `Uploading… ${progress ?? 0}%` : stage === "unpacking" ? "Unpacking…" : "Choose a .zip"}
          <input
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="sr-only"
            disabled={working || busy || !claude.ready}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
      </div>
      {progress !== null && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Upload">
          <div className="h-full bg-foreground transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
      {!claude.ready && <p className="mt-2 text-xs text-zinc-500">{claude.reason}</p>}
      {error ? <ErrorText error={error} /> : null}
      {result && result.skipped.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
            {result.skipped.length} {result.skipped.length === 1 ? "file was" : "files were"} left out
          </summary>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-zinc-500">
            {result.skipped.map((s) => (
              <li key={s.name} className="break-all">
                {s.name}: {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
