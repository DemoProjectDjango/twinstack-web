"use client";

import { useEffect, useRef, useState } from "react";
import { api, workspaceImageUrl, workspacePath, type Proposal, type WorkspaceStatus } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Button, ErrorText, Field, Notice, Section, inputClass } from "./ui";

const MAX_IMAGES = 6;
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

export function EditPanel({ initialFile }: { initialFile: string | null }) {
  const { owner, repo, overview, busy, run, hasKey, version, job, setStatus, refresh } = useSite();
  const [file, setFile] = useState(initialFile?.endsWith(".md") ? initialFile : "");
  const [instruction, setInstruction] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [imageUrl, setImageUrl] = useState("");
  const [siteImages, setSiteImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [imageError, setImageError] = useState<unknown>(null);

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [draft, setDraft] = useState("");
  const loadedAt = useRef<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [proposalError, setProposalError] = useState<unknown>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const supportsImages = overview?.features.pageEditImages ?? true;
  const collections = overview?.collections.filter((c) => c.pages.length) ?? [];

  // After every command (a preview finishing, an upload…) re-read the proposal
  // and the site's images. The draft is only replaced when a new proposal arrives.
  useEffect(() => {
    let cancelled = false;
    api<{ proposal: Proposal | null }>(workspacePath(owner, repo, "/proposal"))
      .then(({ proposal: next }) => {
        if (cancelled) return;
        setProposal(next);
        const stamp = next ? `${next.file}@${next.createdAt}` : null;
        if (stamp !== loadedAt.current) {
          loadedAt.current = stamp;
          setDraft(next?.content ?? "");
        }
      })
      .catch((err) => !cancelled && setProposalError(err));
    api<{ images: string[] }>(workspacePath(owner, repo, "/images"))
      .then(({ images: list }) => !cancelled && setSiteImages(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  function addImage(entry: string) {
    setImageError(null);
    setImages((prev) => (prev.includes(entry) || prev.length >= MAX_IMAGES ? prev : [...prev, entry]));
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setImageError(null);
    setUploading(true);
    try {
      for (const picked of Array.from(files)) {
        if (images.length >= MAX_IMAGES) throw new Error(`Attach at most ${MAX_IMAGES} images.`);
        if (picked.size > MAX_IMAGE_BYTES) throw new Error(`${picked.name} is over 5 MB.`);
        const saved = await api<{ path: string }>(workspacePath(owner, repo, "/uploads"), {
          method: "POST",
          body: { name: picked.name, data: await readAsBase64(picked) },
        });
        addImage(saved.path);
      }
      // The upload is a new file in the site: update the change count and image list.
      await refresh();
    } catch (err) {
      setImageError(err);
    } finally {
      setUploading(false);
    }
  }

  function addUrl(e: React.FormEvent) {
    e.preventDefault();
    const value = imageUrl.trim();
    if (!/^https?:\/\/\S+$/i.test(value)) {
      setImageError(new Error("Enter an image URL starting with http:// or https://."));
      return;
    }
    addImage(value);
    setImageUrl("");
  }

  function startEdit(dryRun: boolean) {
    setApplied(null);
    setProposalError(null);
    void run("page-edit", { page: file, instruction, images: supportsImages ? images : [], dryRun });
  }

  async function applyProposal() {
    if (!proposal) return;
    setApplying(true);
    setProposalError(null);
    try {
      const result = await api<{ file: string; status: WorkspaceStatus }>(workspacePath(owner, repo, "/proposal/apply"), {
        method: "POST",
        body: { content: draft },
      });
      setStatus(result.status);
      setApplied(result.file);
      setProposal(null);
      loadedAt.current = null;
      await refresh();
    } catch (err) {
      setProposalError(err);
    } finally {
      setApplying(false);
    }
  }

  async function discardProposal() {
    setProposalError(null);
    try {
      await api(workspacePath(owner, repo, "/proposal"), { method: "DELETE" });
      setProposal(null);
      loadedAt.current = null;
      setDraft("");
    } catch (err) {
      setProposalError(err);
    }
  }

  const disabled = busy || !hasKey;
  const ready = Boolean(file) && Boolean(instruction.trim());
  const previewRunning = job?.command === "page-edit" && job.status === "running";
  const previewFailed = job?.command === "page-edit" && job.status === "failed";

  return (
    <>
      {!hasKey && <Notice tone="warning">Add your Anthropic API key on the dashboard to use Claude edits.</Notice>}
      {!supportsImages && (
        <Notice tone="warning">
          This site copy has an older <code className="font-mono">scripts/edit-page.js</code>, so images and the full preview
          below aren&apos;t available (the preview only appears in the Output panel). Update{" "}
          <code className="font-mono">scripts/edit-page.js</code> and <code className="font-mono">scripts/lib/claude-writer.js</code>{" "}
          from the template to get them.
        </Notice>
      )}

      <Section
        title="Edit a page with Claude"
        description="Pick one page, say what to change, and optionally give Claude images to look at and place in the page. Preview first: you'll see the complete new file below and can adjust it before applying."
      >
        <div className="space-y-4">
          <Field label="Page">
            <select value={file} onChange={(e) => setFile(e.target.value)} className={inputClass} disabled={disabled}>
              <option value="">Choose a page…</option>
              {collections.map((collection) => (
                <optgroup key={collection.name} label={collection.label}>
                  {collection.pages.map((page) => (
                    <option key={page.file} value={page.file}>
                      {page.title} — {page.file}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          {overview && collections.length === 0 && (
            <p className="text-sm text-zinc-500">This site has no pages yet. Create some on the Pages or Site tree tab.</p>
          )}

          <Field label="Instruction">
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="Add a short 'Meet the team' section using the attached photo"
              className={inputClass}
              disabled={disabled}
            />
          </Field>

          {supportsImages && (
            <div>
              <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Images (optional, up to {MAX_IMAGES})
              </span>
              {images.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {images.map((image) => (
                    <li key={image} className="flex max-w-full items-center gap-2 rounded-md border border-zinc-200 p-1.5 pr-2 dark:border-zinc-800">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={/^https?:/i.test(image) ? image : workspaceImageUrl(owner, repo, image)}
                        alt=""
                        className="size-10 shrink-0 rounded object-cover"
                      />
                      <span className="max-w-56 truncate font-mono text-xs" title={image}>
                        {image}
                      </span>
                      <button
                        type="button"
                        onClick={() => setImages((prev) => prev.filter((i) => i !== image))}
                        disabled={disabled}
                        aria-label={`Remove ${image}`}
                        className="text-zinc-500 hover:text-foreground"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className={`flex items-center justify-center rounded-md border border-dashed border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 ${disabled || uploading ? "opacity-50" : "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"}`}>
                  {uploading ? "Uploading…" : "Upload images (PNG, JPEG, GIF, WebP, 5 MB max)"}
                  <input
                    type="file"
                    accept={IMAGE_ACCEPT}
                    multiple
                    className="sr-only"
                    disabled={disabled || uploading || images.length >= MAX_IMAGES}
                    onChange={(e) => {
                      void upload(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
                <select
                  value=""
                  onChange={(e) => e.target.value && addImage(e.target.value)}
                  className={inputClass}
                  disabled={disabled || siteImages.length === 0 || images.length >= MAX_IMAGES}
                >
                  <option value="">{siteImages.length ? "Or pick an image already in the site…" : "No images in assets/img yet"}</option>
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
                  placeholder="Or paste an image URL (https://…)"
                  className={inputClass}
                  disabled={disabled || images.length >= MAX_IMAGES}
                />
                <Button type="submit" disabled={disabled || !imageUrl.trim() || images.length >= MAX_IMAGES}>
                  Add URL
                </Button>
              </form>
              <p className="mt-1 text-xs text-zinc-500">
                Uploads are saved into the site under assets/img/uploads/ so the page can show them. Claude sees each image and
                writes alt text for it.
              </p>
              <div className="mt-1">
                <ErrorText error={imageError} />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={disabled || !ready} onClick={() => startEdit(true)}>
              {previewRunning ? "Asking Claude…" : "Preview change"}
            </Button>
            <Button disabled={disabled || !ready} onClick={() => startEdit(false)}>
              Apply without preview
            </Button>
            <span className="text-xs text-zinc-500">Each click is one Claude request, billed to your key.</span>
          </div>
        </div>
      </Section>

      {applied && (
        <Notice tone="success">
          Saved <code className="font-mono">{applied}</code>. Build a preview to see it, or review it on the Changes tab.
        </Notice>
      )}
      {previewFailed && !proposal && (
        <Notice tone="warning">Claude&apos;s edit didn&apos;t complete. The Output panel shows why.</Notice>
      )}

      {proposal && (
        <Section
          title="Proposed page"
          description={
            <>
              Claude&apos;s complete new version of <code className="font-mono">{proposal.file}</code>. Nothing is saved yet. Edit
              the text if you want, then apply it. Applying doesn&apos;t call Claude again.
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-sm">
              <span className="text-zinc-500">Instruction:</span> {proposal.instruction}
            </p>
            {proposal.images.length > 0 && (
              <p className="break-all text-sm">
                <span className="text-zinc-500">Images:</span> {proposal.images.join(", ")}
              </p>
            )}
            {proposal.problems.length > 0 && (
              <Notice tone="warning">
                Check this before applying:
                <ul className="mt-1 list-disc pl-5">
                  {proposal.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </Notice>
            )}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={24}
              spellCheck={false}
              aria-label={`Proposed contents of ${proposal.file}`}
              className={`${inputClass} font-mono text-xs leading-relaxed`}
              disabled={applying || busy}
            />
            <ErrorText error={proposalError} />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={applying || busy || !draft.trim()} onClick={applyProposal}>
                {applying ? "Applying…" : "Apply this version"}
              </Button>
              <Button disabled={applying || busy} onClick={discardProposal}>
                Discard
              </Button>
              {draft !== proposal.content && (
                <>
                  <span className="text-xs text-zinc-500">Edited by you.</span>
                  <Button variant="ghost" className="text-xs" disabled={applying || busy} onClick={() => setDraft(proposal.content)}>
                    Reset to Claude&apos;s version
                  </Button>
                </>
              )}
            </div>
          </div>
        </Section>
      )}
    </>
  );
}
