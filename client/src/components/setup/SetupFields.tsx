"use client";

import { useEffect, useMemo } from "react";
import { useFileUrl } from "./use-file-url";
import {
  DEFAULT_HOURS,
  LOGO_ACCEPT,
  MAX_LOGO_BYTES,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  PHOTO_ACCEPT,
  hoursText,
  type AnswerValue,
  type HoursRow,
  type Item,
  type SetupField,
  type SetupGroup,
} from "@/lib/setup";
import { inputClass } from "../site/ui";

// The fields of one setup question group (a skill's group, server/src/site-types/*.json), each by
// its type. The logo and photos are files, kept beside the answers until the site exists.

export type FieldsProps = {
  group: SetupGroup;
  answers: Record<string, AnswerValue>;
  onAnswer: (id: string, value: AnswerValue | undefined) => void;
  /** Fields the AI filled in from what the owner wrote. */
  fromBrief: Set<string>;
  logo: File | null;
  onLogo: (file: File | null) => void;
  /** The browser-tab icon, when the owner chose one other than the logo. */
  favicon: File | null;
  onFavicon: (file: File | null) => void;
  /** For the tab icon's preview: the business's name and colour. */
  siteName: string;
  accent: string;
  photos: File[];
  onPhotos: (files: File[]) => void;
  onError: (error: Error | null) => void;
};

const chipClass = (on: boolean) =>
  `rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
    on ? "border-foreground bg-foreground text-background" : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
  }`;

function FromBrief() {
  return <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">From what you wrote</span>;
}

export function SetupFields(props: FieldsProps) {
  const { group, answers } = props;
  return (
    <div className="mt-5 grid gap-5">
      {group.fields
        .filter((f) => !f.showIf || answers[f.showIf.field] === f.showIf.equals)
        .map((field) => (
          <Field key={field.id} field={field} {...props} />
        ))}
    </div>
  );
}


/** Reads one image from a file input, refusing one over `max` bytes. */
function pickImage(e: React.ChangeEvent<HTMLInputElement>, max: number, onError: (error: Error | null) => void, onFile: (file: File) => void) {
  const file = e.target.files?.[0] ?? null;
  e.target.value = "";
  if (!file) return;
  if (file.size > max) return onError(new Error(`${file.name} is over ${Math.round(max / 1024 / 1024)} MB.`));
  onError(null);
  onFile(file);
}

/**
 * The logo, shown once chosen, and the browser-tab icon (favicon): the logo by default, or without
 * one the business's initial on its colour (the mark the build makes), or an image of its own.
 */
export function LogoAndIcon({
  name,
  accent,
  logo,
  onLogo,
  favicon,
  onFavicon,
  onError,
}: {
  name: string;
  accent: string;
  logo: File | null;
  onLogo: (file: File | null) => void;
  favicon: File | null;
  onFavicon: (file: File | null) => void;
  onError: (error: Error | null) => void;
}) {
  const logoUrl = useFileUrl(logo);
  const faviconUrl = useFileUrl(favicon);
  const iconUrl = faviconUrl ?? logoUrl;
  const initial = (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "Y").toUpperCase();
  return (
    <div className="grid gap-3">
      {logo && logoUrl ? (
        <div className="flex items-center gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <span className="grid h-16 w-28 shrink-0 place-items-center rounded-lg bg-[repeating-conic-gradient(#f4f4f5_0_25%,#fff_0_50%)] bg-size-[12px_12px] p-1.5 dark:bg-[repeating-conic-gradient(#27272a_0_25%,#18181b_0_50%)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logoUrl} alt="Your logo" className="max-h-full max-w-full object-contain" />
          </span>
          <span className="min-w-0 flex-1 text-sm">
            <b className="block truncate font-medium">{logo.name}</b>
            <span className="text-xs text-zinc-500">Shown in your header and footer</span>
          </span>
          <label className="cursor-pointer text-xs underline">
            Change
            <input type="file" accept={LOGO_ACCEPT} className="sr-only" onChange={(e) => pickImage(e, MAX_LOGO_BYTES, onError, onLogo)} />
          </label>
          <button type="button" onClick={() => onLogo(null)} className="text-xs text-zinc-500 underline">
            Remove
          </button>
        </div>
      ) : (
        <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-200 px-4 py-6 text-center text-sm hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600">
          <span className="font-medium">Choose your logo</span>
          <span className="mt-0.5 text-xs text-zinc-500">PNG, SVG or WebP, up to 2 MB. Without one, the header shows your name.</span>
          <input type="file" accept={LOGO_ACCEPT} className="sr-only" onChange={(e) => pickImage(e, MAX_LOGO_BYTES, onError, onLogo)} />
        </label>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-zinc-50 p-3 dark:bg-zinc-900/60">
        {/* A browser tab, as visitors see the icon. */}
        <span aria-hidden="true" className="flex min-w-0 max-w-56 items-center gap-2 rounded-t-lg border border-b-0 border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
          {iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={iconUrl} alt="" className="size-4 shrink-0 rounded-sm object-contain" />
          ) : (
            <span className="grid size-4 shrink-0 place-items-center rounded-[4px] text-[9px] font-bold text-white" style={{ background: accent }}>
              {initial}
            </span>
          )}
          <span className="truncate">{name || "Your site"}</span>
        </span>
        <span className="min-w-0 flex-1 text-sm">
          <b className="block font-medium">Browser tab icon</b>
          <span className="text-xs text-zinc-500">{favicon ? favicon.name : logo ? "Your logo, by default" : "Your initial in your colour, until you add a logo"}</span>
        </span>
        <label className="cursor-pointer text-xs underline">
          {favicon ? "Change" : "Choose a different icon"}
          <input type="file" accept={`${LOGO_ACCEPT},image/x-icon,image/vnd.microsoft.icon`} className="sr-only" onChange={(e) => pickImage(e, MAX_LOGO_BYTES, onError, onFavicon)} />
        </label>
        {favicon && (
          <button type="button" onClick={() => onFavicon(null)} className="text-xs text-zinc-500 underline">
            {logo ? "Use my logo" : "Use my initial"}
          </button>
        )}
        <span className="basis-full text-xs text-zinc-500">A square image works best: browsers show it very small.</span>
      </div>
    </div>
  );
}

function Field({ field, answers, onAnswer, fromBrief, logo, onLogo, favicon, onFavicon, siteName, accent, photos, onPhotos, onError }: FieldsProps & { field: SetupField }) {
  const id = `setup-${field.id}`;
  const value = answers[field.id];
  const label = (
    <span className="mb-1.5 block text-sm font-medium">
      {field.label}
      {fromBrief.has(field.id) && <FromBrief />}
    </span>
  );
  const hint = field.hint && <span className="mt-1 block text-xs text-zinc-500">{field.hint}</span>;

  switch (field.type) {
    case "choice":
    case "yesno": {
      const choices = field.type === "yesno" ? ["Yes", "No"] : (field.choices ?? []);
      const current = typeof value === "string" ? value : "";
      return (
        <div>
          {label}
          <div className="flex flex-wrap gap-2" role="group" aria-label={field.label}>
            {choices.map((choice) => (
              <button key={choice} type="button" aria-pressed={current === choice} onClick={() => onAnswer(field.id, current === choice ? undefined : choice)} className={chipClass(current === choice)}>
                {choice}
              </button>
            ))}
          </div>
          {field.other && (
            <input
              id={id}
              value={choices.includes(current) ? "" : current}
              onChange={(e) => onAnswer(field.id, e.target.value || undefined)}
              maxLength={120}
              placeholder="Or type your own"
              aria-label={`${field.label} in your own words`}
              className={`${inputClass} mt-2 py-2`}
            />
          )}
          {hint}
        </div>
      );
    }
    case "multi": {
      const current = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div>
          {label}
          <div className="flex flex-wrap gap-2" role="group" aria-label={field.label}>
            {(field.choices ?? []).map((choice) => {
              const on = current.includes(choice);
              return (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const next = on ? current.filter((c) => c !== choice) : [...current, choice];
                    onAnswer(field.id, next.length ? next : undefined);
                  }}
                  className={chipClass(on)}
                >
                  {choice}
                </button>
              );
            })}
          </div>
          {hint}
        </div>
      );
    }
    case "text":
    case "tel":
    case "email":
    case "url":
      return (
        <label htmlFor={id} className="block">
          {label}
          <input
            id={id}
            type={field.type === "text" ? "text" : field.type}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onAnswer(field.id, e.target.value || undefined)}
            maxLength={field.type === "url" ? 300 : 200}
            placeholder={field.placeholder ?? (field.type === "url" ? "https://…" : "")}
            className={`${inputClass} py-2`}
          />
          {hint}
        </label>
      );
    case "textarea":
      return (
        <label htmlFor={id} className="block">
          {label}
          <textarea
            id={id}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onAnswer(field.id, e.target.value || undefined)}
            rows={3}
            maxLength={1500}
            className={`${inputClass} resize-y py-2`}
          />
          {hint}
        </label>
      );
    case "hours":
      return <HoursField field={field} value={Array.isArray(value) ? (value as HoursRow[]) : null} onAnswer={onAnswer} label={label} />;
    case "items":
      return <ItemsField field={field} value={Array.isArray(value) ? (value as Item[]) : []} onAnswer={onAnswer} label={label} hint={hint} />;
    case "logo":
      return (
        <div>
          {label}
          <LogoAndIcon name={siteName} accent={accent} logo={logo} onLogo={onLogo} favicon={favicon} onFavicon={onFavicon} onError={onError} />
        </div>
      );
    case "photos":
      return <PhotosField label={label} hint={field.hint} photos={photos} onPhotos={onPhotos} onError={onError} />;
  }
}

function HoursField({ field, value, onAnswer, label }: { field: SetupField; value: HoursRow[] | null; onAnswer: FieldsProps["onAnswer"]; label: React.ReactNode }) {
  const rows = value ?? DEFAULT_HOURS;
  const set = (i: number, change: Partial<HoursRow>) => onAnswer(field.id, rows.map((r, j) => (j === i ? { ...r, ...change } : r)));
  return (
    <div>
      {label}
      <div className="grid gap-1.5">
        {rows.map((row, i) => (
          <div key={row.day} className="grid grid-cols-[3rem_1fr_1fr_auto] items-center gap-2 text-sm tabular-nums">
            <b className="font-medium">{row.day}</b>
            <input type="time" value={row.open} disabled={row.closed} onChange={(e) => set(i, { open: e.target.value })} aria-label={`${row.day} opens`} className={`${inputClass} py-1.5 disabled:opacity-40`} />
            <input type="time" value={row.close} disabled={row.closed} onChange={(e) => set(i, { close: e.target.value })} aria-label={`${row.day} closes`} className={`${inputClass} py-1.5 disabled:opacity-40`} />
            <label className="flex items-center gap-1 text-xs text-zinc-500">
              <input type="checkbox" checked={row.closed} onChange={(e) => set(i, { closed: e.target.checked })} /> Closed
            </label>
          </div>
        ))}
      </div>
      <span className="mt-1 block text-xs text-zinc-500">{value ? `Shown as: ${hoursText(rows)}` : "Set your hours: these are only a starting point and aren't saved until you change one."}</span>
    </div>
  );
}

function ItemsField({ field, value, onAnswer, label, hint }: { field: SetupField; value: Item[]; onAnswer: FieldsProps["onAnswer"]; label: React.ReactNode; hint: React.ReactNode }) {
  const rows = value.length ? value : [{ name: "", desc: "", price: "" }];
  const max = field.max ?? 6;
  const set = (next: Item[]) => onAnswer(field.id, next.some((i) => i.name.trim()) ? next : undefined);
  const columns = field.noPrice ? "sm:grid-cols-[1fr_1.4fr_auto]" : "sm:grid-cols-[1fr_1.4fr_6rem_auto]";
  return (
    <div>
      {label}
      <div className="grid gap-2">
        {rows.map((item, i) => (
          <div key={i} className={`grid grid-cols-1 items-center gap-2 rounded-xl border border-zinc-200 p-2 dark:border-zinc-800 ${columns}`}>
            <input value={item.name} onChange={(e) => set(rows.map((r, j) => (j === i ? { ...r, name: e.target.value, sample: false } : r)))} placeholder={field.itemLabel ?? "Name"} aria-label={`${field.itemLabel ?? "Item"} ${i + 1}`} className={`${inputClass} py-1.5`} />
            <input value={item.desc} onChange={(e) => set(rows.map((r, j) => (j === i ? { ...r, desc: e.target.value } : r)))} placeholder={field.descLabel ?? "Short description"} aria-label={`${field.itemLabel ?? "Item"} ${i + 1} description`} className={`${inputClass} py-1.5`} />
            {!field.noPrice && (
              <input value={item.price} onChange={(e) => set(rows.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)))} placeholder="Price" aria-label={`${field.itemLabel ?? "Item"} ${i + 1} price`} className={`${inputClass} py-1.5`} />
            )}
            <span className="flex items-center gap-1.5">
              {item.sample && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">Sample</span>}
              <button type="button" onClick={() => set(rows.filter((_, j) => j !== i))} aria-label={`Remove ${field.itemLabel ?? "item"} ${i + 1}`} className="grid size-8 place-items-center rounded-lg border border-zinc-200 text-zinc-500 hover:text-foreground dark:border-zinc-800">
                ×
              </button>
            </span>
          </div>
        ))}
      </div>
      {rows.length < max && (
        <button type="button" onClick={() => onAnswer(field.id, [...rows, { name: "", desc: "", price: "" }])} className="mt-2 text-sm text-zinc-500 underline hover:text-foreground">
          Add {(field.itemLabel ?? "item").toLowerCase()}
        </button>
      )}
      {hint}
    </div>
  );
}

function PhotosField({ label, hint, photos, onPhotos, onError }: { label: React.ReactNode; hint?: string; photos: File[]; onPhotos: (f: File[]) => void; onError: (e: Error | null) => void }) {
  // Thumbnails of the chosen photos, freed when they change.
  const previews = useMemo(() => photos.map((photo) => ({ name: photo.name, url: URL.createObjectURL(photo) })), [photos]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);
  return (
    <div>
      {label}
      <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-200 px-4 py-6 text-center text-sm hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600">
        <span className="font-medium">Choose photos</span>
        <span className="mt-0.5 text-xs text-zinc-500">
          {hint ? `${hint} ` : ""}Up to {MAX_PHOTOS}, 5 MB each.
        </span>
        <input
          type="file"
          accept={PHOTO_ACCEPT}
          multiple
          className="sr-only"
          onChange={(e) => {
            const picked = [...photos, ...Array.from(e.target.files ?? [])];
            e.target.value = "";
            const tooBig = picked.find((f) => f.size > MAX_PHOTO_BYTES);
            onError(tooBig ? new Error(`${tooBig.name} is over 5 MB.`) : picked.length > MAX_PHOTOS ? new Error(`You can add up to ${MAX_PHOTOS} photos.`) : null);
            onPhotos(picked.filter((f) => f.size <= MAX_PHOTO_BYTES).slice(0, MAX_PHOTOS));
          }}
        />
      </label>
      {previews.length > 0 && (
        <ul className="mt-2 grid grid-cols-6 gap-2">
          {previews.map((p, i) => (
            <li key={p.url} className="group relative aspect-square overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-900">
              {/* eslint-disable-next-line @next/next/no-img-element -- a local preview, not a page image */}
              <img src={p.url} alt={p.name} className="size-full object-cover" />
              <button
                type="button"
                aria-label={`Remove ${p.name}`}
                onClick={() => onPhotos(photos.filter((_, j) => j !== i))}
                className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/60 text-xs text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
