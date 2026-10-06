"use client";

import { useEffect, useRef, useState } from "react";
import { api, workspacePath, type Brand, type BrandInfo, type WorkspaceStatus } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Button, ErrorText, Field, Notice, Section, inputClass } from "./ui";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/x-icon,.svg,.ico";

type ImageField = "logo" | "logoDark" | "logoMark" | "favicon";

const SLOTS: { field: ImageField; label: string; hint: string; removable: boolean; dark?: boolean }[] = [
  {
    field: "logo",
    label: "Logo",
    hint: "Shown in the header in place of the icon and name, 36px tall. A wide logo is fine. Its alt text is the name below.",
    removable: true,
  },
  {
    field: "logoDark",
    label: "Logo on a dark background",
    hint: "Shown in the footer, which is dark. Leave it empty to use the logo above there too, if it reads on dark.",
    removable: true,
    dark: true,
  },
  {
    field: "logoMark",
    label: "Icon",
    hint: "The small square mark shown beside the name when there's no logo, and the browser-tab icon when there's no favicon.",
    removable: false,
  },
  {
    field: "favicon",
    label: "Favicon",
    hint: "The browser-tab icon. A square PNG, SVG or ICO, at least 32×32. Empty uses the icon.",
    removable: true,
  },
];

function readAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/** The site's logo, dark-background logo, icon, favicon and name (site.config.json → brand). */
export function BrandPanel() {
  const { owner, repo, busy, version, setStatus } = useSite();
  const [info, setInfo] = useState<BrandInfo | null>(null);
  const [draft, setDraft] = useState<Brand | null>(null);
  const [previews, setPreviews] = useState<BrandInfo["previews"]>({});
  const [uploading, setUploading] = useState<ImageField | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dirtyRef = useRef(false);

  const dirty = info !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(info.brand);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Reloaded after every command (a Claude run may change site.config.json) unless there are unsaved edits.
  useEffect(() => {
    if (dirtyRef.current) return;
    let cancelled = false;
    api<BrandInfo>(workspacePath(owner, repo, "/brand"))
      .then((loaded) => {
        if (cancelled || dirtyRef.current) return;
        setInfo(loaded);
        setDraft(loaded.brand);
        setPreviews(loaded.previews);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  async function upload(field: ImageField, file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      setError(new Error(`${file.name} is over 2 MB.`));
      return;
    }
    setError(null);
    setUploading(field);
    try {
      const result = await api<{ path: string; preview: string | null }>(workspacePath(owner, repo, "/brand/image"), {
        method: "POST",
        body: { name: file.name, data: await readAsBase64(file) },
      });
      setDraft((current) => (current ? { ...current, [field]: result.path } : current));
      setPreviews((current) => ({ ...current, [field]: result.preview }));
      setSaved(false);
    } catch (err) {
      setError(err);
    } finally {
      setUploading(null);
    }
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api<BrandInfo & { status: WorkspaceStatus }>(workspacePath(owner, repo, "/brand"), {
        method: "PUT",
        body: { brand: draft },
      });
      setInfo(result);
      setDraft(result.brand);
      setPreviews(result.previews);
      setStatus(result.status);
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Logo"
      description={
        <>
          The logo, icon and name in the site&apos;s header, footer and browser tab. They&apos;re kept in{" "}
          <code className="font-mono">site.config.json</code> (brand), and uploads go to{" "}
          <code className="font-mono">assets/img/brand/</code>. Save, and the preview on Home updates by itself.
        </>
      }
    >
      <ErrorText error={error} />
      {info && !info.supported && (
        <div className="mb-3">
          <Notice tone="warning">
            This copy&apos;s header and footer only show the icon and name. To use a full logo, a dark-background logo or a
            favicon, update <code className="font-mono">templates/partials/header.html</code>,{" "}
            <code className="font-mono">footer.html</code> and <code className="font-mono">base.html</code> from the template.
          </Notice>
        </div>
      )}
      {!draft ? (
        !error && <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <div className="space-y-4">
          <Field label="Name" hint="Shown beside the icon when there's no logo, and the logo's alt text.">
            <input
              value={draft.logoText}
              onChange={(e) => {
                setDraft({ ...draft, logoText: e.target.value });
                setSaved(false);
              }}
              maxLength={80}
              className={inputClass}
              disabled={busy || saving}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            {SLOTS.map((slot) => {
              const value = draft[slot.field];
              const src = previews[slot.field];
              return (
                <div key={slot.field} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                  <span className="block text-sm font-medium">{slot.label}</span>
                  <div
                    className={`mt-2 flex h-20 items-center justify-center rounded border border-zinc-200 p-2 dark:border-zinc-800 ${
                      slot.dark ? "bg-[#0b1a2e]" : "bg-white"
                    }`}
                  >
                    {value && src ? (
                      // A data: URL preview of a file in the workspace; next/image adds nothing here.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={src} alt={`${slot.label} preview`} className="max-h-full max-w-full object-contain" />
                    ) : (
                      <span className={`text-xs ${slot.dark ? "text-zinc-400" : "text-zinc-500"}`}>
                        {value ? "No preview (large file)" : "Not set"}
                      </span>
                    )}
                  </div>
                  {value && <code className="mt-1 block truncate font-mono text-xs text-zinc-500">{value}</code>}
                  <p className="mt-1 text-xs text-zinc-500">{slot.hint}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label
                      className={`cursor-pointer rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900 ${
                        busy || saving || uploading ? "pointer-events-none opacity-50" : ""
                      }`}
                    >
                      {uploading === slot.field ? "Uploading…" : value ? "Replace" : "Upload"}
                      <input
                        type="file"
                        accept={LOGO_ACCEPT}
                        className="sr-only"
                        disabled={busy || saving || uploading !== null}
                        onChange={(e) => {
                          void upload(slot.field, e.target.files?.[0]);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    {slot.removable && value && (
                      <Button
                        variant="ghost"
                        className="px-2 py-1 text-xs"
                        disabled={busy || saving}
                        onClick={() => {
                          setDraft({ ...draft, [slot.field]: "" });
                          setSaved(false);
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={!dirty || busy || saving || uploading !== null} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              disabled={!dirty || busy || saving}
              onClick={() => {
                if (!info) return;
                setDraft(info.brand);
                setPreviews(info.previews);
              }}
            >
              Discard changes
            </Button>
            {saved && !dirty && <span className="text-xs text-zinc-500">Saved. The preview updates by itself.</span>}
          </div>
        </div>
      )}
    </Section>
  );
}
