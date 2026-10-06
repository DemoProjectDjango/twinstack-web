"use client";

import { useEffect, useState, type ReactNode } from "react";
import { api, workspacePath } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Button, ErrorText, inputClass } from "./ui";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

function readAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/**
 * Three ways to bring in an image: upload one (saved into the site under
 * assets/img/uploads/), pick one already in the site, or paste a URL. Each
 * chosen image is handed to `onAdd` as a repo path ("assets/img/…") or a URL.
 */
export function ImagePicker({
  onAdd,
  disabled,
  room = Infinity,
  hint,
}: {
  onAdd: (entry: string) => void;
  disabled: boolean;
  /** How many more images may be added; at 0 the controls are disabled. */
  room?: number;
  hint?: ReactNode;
}) {
  const { owner, repo, version, refresh } = useSite();
  const [siteImages, setSiteImages] = useState<string[]>([]);
  const [imageUrl, setImageUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Re-read after every command and upload, so new images show up in the list.
  useEffect(() => {
    let cancelled = false;
    api<{ images: string[] }>(workspacePath(owner, repo, "/images"))
      .then(({ images }) => !cancelled && setSiteImages(images))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  function add(entry: string) {
    setError(null);
    onAdd(entry);
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    if (files.length > room) {
      setError(new Error(`Add at most ${room} more image${room === 1 ? "" : "s"}.`));
      return;
    }
    setUploading(true);
    try {
      for (const picked of Array.from(files)) {
        if (picked.size > MAX_IMAGE_BYTES) throw new Error(`${picked.name} is over 5 MB.`);
        const saved = await api<{ path: string }>(workspacePath(owner, repo, "/uploads"), {
          method: "POST",
          body: { name: picked.name, data: await readAsBase64(picked) },
        });
        add(saved.path);
      }
      // The upload is a new file in the site: update the change count and image list.
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  }

  function addUrl(e: React.FormEvent) {
    e.preventDefault();
    const value = imageUrl.trim();
    if (!/^https?:\/\/\S+$/i.test(value)) {
      setError(new Error("Enter an image URL starting with http:// or https://."));
      return;
    }
    add(value);
    setImageUrl("");
  }

  const off = disabled || room <= 0;

  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label
          className={`flex items-center justify-center rounded-md border border-dashed border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 ${off || uploading ? "opacity-50" : "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"}`}
        >
          {uploading ? "Uploading…" : "Upload photos from your computer (up to 5 MB each)"}
          <input
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            className="sr-only"
            disabled={off || uploading}
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <select
          value=""
          onChange={(e) => e.target.value && add(e.target.value)}
          className={inputClass}
          disabled={off || siteImages.length === 0}
        >
          <option value="">{siteImages.length ? "Or pick a photo already in the site…" : "No photos in the site yet"}</option>
          {siteImages.map((image) => (
            <option key={image} value={image}>
              {image}
            </option>
          ))}
        </select>
      </div>
      <form onSubmit={addUrl} className="mt-2 flex gap-2">
        <input
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
          placeholder="Or paste a link to a photo online (https://…)"
          className={inputClass}
          disabled={off}
        />
        <Button type="submit" className="shrink-0" disabled={off || !imageUrl.trim()}>
          Add
        </Button>
      </form>
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
      <div className="mt-1">
        <ErrorText error={error} />
      </div>
    </div>
  );
}
