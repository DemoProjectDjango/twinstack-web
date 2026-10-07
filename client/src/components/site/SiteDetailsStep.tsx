"use client";

import { useEffect, useState } from "react";
import {
  api,
  workspacePath,
  type Json,
  type StaticSection,
} from "@/lib/site-api";
import { useSite } from "./site-context";
import { Button, ErrorText, Field, Notice, inputClass } from "./ui";

type Config = { [key: string]: Json };

// The fields asked for before the first publish, where site.config.json has them as text.
const FIELDS = [
  {
    path: ["name"],
    label: "Site name",
    hint: "Shown in the header, the footer and browser tabs.",
  },
  {
    path: ["tagline"],
    label: "Tagline",
    hint: "A few words on what you do. Also the homepage's search title.",
  },
  {
    path: ["description"],
    label: "Description",
    hint: "One or two sentences. Search results show it when a page has none of its own.",
    long: true,
  },
  {
    path: ["contact", "email"],
    label: "Contact email",
    hint: "Where the site's email links go.",
  },
] as const;

const isObject = (value: Json | undefined): value is Config =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function read(data: Config, path: readonly string[]) {
  const value = path.reduce<Json | undefined>(
    (at, key) => (isObject(at) ? at[key] : undefined),
    data,
  );
  return typeof value === "string" ? value : null;
}

function write(
  data: Config,
  [key, ...rest]: readonly string[],
  value: string,
): Config {
  return {
    ...data,
    [key]: rest.length
      ? write(isObject(data[key]) ? data[key] : {}, rest, value)
      : value,
  };
}

/**
 * Before the first publish: the site's name, tagline, description and contact email from Site details,
 * filled in, to check or correct. Skippable; `onDone` runs once they're saved or skipped.
 */
export function SiteDetailsStep({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const { owner, repo, busy } = useSite();
  const [data, setData] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ sections: StaticSection[] }>(
      workspacePath(owner, repo, "/static-info"),
    )
      .then(({ sections }) => {
        if (cancelled) return;
        const site = sections.find((s) => s.id === "site")?.data;
        // A site without the usual settings file has nothing to ask about.
        if (!isObject(site)) return onDone();
        setData(site);
        setDraft(site);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
    // Loaded once, when the step opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo]);

  async function saveAndContinue(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || !data) return;
    if (JSON.stringify(draft) === JSON.stringify(data)) return onDone();
    setSaving(true);
    setError(null);
    try {
      await api(workspacePath(owner, repo, "/static-info/site"), {
        method: "PUT",
        body: { data: draft },
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  if (!draft)
    return error ? (
      <ErrorText error={error} />
    ) : (
      <p className="text-sm text-zinc-500">Loading your site details…</p>
    );

  const fields = FIELDS.filter((f) => read(draft, f.path) !== null);
  const disabled = saving || busy;
  return (
    <form onSubmit={saveAndContinue} className="space-y-4">
      <Notice>
        Before your site goes live for the first time, check the details
        visitors and search engines see. You can change these and more any time
        under Site details.
      </Notice>
      {fields.map((f) => (
        <Field key={f.path.join(".")} label={f.label} hint={f.hint}>
          {"long" in f && f.long ? (
            <textarea
              value={read(draft, f.path) ?? ""}
              onChange={(e) => setDraft(write(draft, f.path, e.target.value))}
              rows={3}
              className={inputClass}
              disabled={disabled}
            />
          ) : (
            <input
              type={f.path.at(-1) === "email" ? "email" : "text"}
              value={read(draft, f.path) ?? ""}
              onChange={(e) => setDraft(write(draft, f.path, e.target.value))}
              className={inputClass}
              disabled={disabled}
            />
          )}
        </Field>
      ))}
      <ErrorText error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          className="px-5 py-2"
          disabled={disabled}
        >
          {saving ? "Saving…" : "Save and publish"}
        </Button>
        <Button disabled={disabled} onClick={onDone}>
          Skip and publish
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
