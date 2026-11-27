"use client";

import { useEffect, useRef, useState } from "react";
import { api, workspaceImageUrl, workspacePath, type WorkspaceStatus } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Button, ErrorText } from "./ui";

// "Change this picture": a picture clicked in Edit site's preview, swapped for one of the site's
// own images (its files under assets/img, the same ones on GitHub) or a new upload, saved with
// POST …/pages/image. No AI, no credits; it goes live with the next publish.

export type PictureTarget = { address: string; before: string; alt: string; index: number; count: number };
type Result = { file: string | null; status: WorkspaceStatus };

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_SIDE = 2400;

/** A photo scaled down to MAX_SIDE when it's bigger (or over the upload limit); the file as it is otherwise. */
async function fitted(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= MAX_UPLOAD_BYTES) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.88));
    return blob ? new File([blob], file.name, { type }) : file;
  } catch {
    return file;
  }
}

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the picture."));
    reader.readAsDataURL(file);
  });

export function PictureSwap({ target, onClose, onSaved }: { target: PictureTarget; onClose: () => void; onSaved: (result: Result) => void }) {
  const { owner, repo } = useSite();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<string[] | null>(null);
  const [filter, setFilter] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [working, setWorking] = useState<"upload" | "save" | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    dialog.current?.showModal();
    api<{ images: string[] }>(workspacePath(owner, repo, "/images"))
      .then((data) => setImages(data.images))
      .catch((err) => {
        setImages([]);
        setError(err);
      });
  }, [owner, repo]);

  const save = async (path: string) => {
    setWorking("save");
    setError(null);
    try {
      const result = await api<Result>(workspacePath(owner, repo, "/pages/image"), {
        method: "POST",
        body: { address: target.address, before: target.before, after: `/${path.replace(/^\/+/, "")}`, index: target.index, count: target.count },
      });
      onSaved(result);
    } catch (err) {
      setError(err);
      setWorking(null);
    }
  };

  const upload = async (file: File) => {
    setWorking("upload");
    setError(null);
    try {
      const ready = await fitted(file);
      if (ready.size > MAX_UPLOAD_BYTES) throw new Error("That picture is over 5 MB. Choose a smaller one.");
      const saved = await api<{ path: string }>(workspacePath(owner, repo, "/uploads"), { method: "POST", body: { name: file.name, data: await readBase64(ready) } });
      setImages((list) => [saved.path, ...(list ?? []).filter((p) => p !== saved.path)]);
      await save(saved.path);
    } catch (err) {
      setError(err);
      setWorking(null);
    }
  };

  const shown = (images ?? []).filter((p) => !filter || p.toLowerCase().includes(filter.toLowerCase()));
  const current = target.before.replace(/^\//, "");

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onCancel={(e) => {
        if (working) e.preventDefault();
      }}
      className="m-auto w-[min(56rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] rounded-xl bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/40"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 p-4 dark:border-zinc-800">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Change this picture</h2>
            <p className="mt-0.5 text-sm text-zinc-500">Pick one of your site&apos;s pictures or upload a new one. It replaces this picture on this page; publish to make it live.</p>
          </div>
          <button type="button" onClick={() => dialog.current?.close()} disabled={Boolean(working)} aria-label="Close" className="grid size-8 shrink-0 place-items-center rounded-md text-lg hover:bg-zinc-100 dark:hover:bg-zinc-900">
            ✕
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 p-4 dark:border-zinc-800">
          <Button variant="primary" onClick={() => input.current?.click()} disabled={Boolean(working)}>
            {working === "upload" ? "Uploading…" : "Upload a picture"}
          </Button>
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search your pictures"
            aria-label="Search your pictures"
            className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-background px-3 py-1.5 text-sm dark:border-zinc-700"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <ErrorText error={error} />
          {images === null ? (
            <p className="text-sm text-zinc-500">Loading your pictures…</p>
          ) : shown.length === 0 ? (
            <p className="text-sm text-zinc-500">{filter ? "No pictures match that." : "Your site has no pictures yet: upload one."}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {shown.map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => setChosen(p)}
                    disabled={Boolean(working) || p === current}
                    aria-pressed={chosen === p}
                    title={p}
                    className={`block w-full overflow-hidden rounded-lg border text-left disabled:opacity-50 ${chosen === p ? "border-blue-600 ring-2 ring-blue-600" : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800"}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- the site's own file, through the workspace */}
                    <img src={workspaceImageUrl(owner, repo, p)} alt="" loading="lazy" className="aspect-[4/3] w-full bg-zinc-100 object-cover dark:bg-zinc-900" />
                    <span className="block truncate px-2 py-1 text-xs text-zinc-500">{p === current ? "This picture" : p.split("/").pop()}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 p-4 dark:border-zinc-800">
          <Button variant="secondary" onClick={() => dialog.current?.close()} disabled={Boolean(working)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => chosen && void save(chosen)} disabled={!chosen || Boolean(working)}>
            {working === "save" ? "Saving…" : "Use this picture"}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
