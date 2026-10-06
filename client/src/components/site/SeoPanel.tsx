"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  workspaceImageUrl,
  workspacePath,
  type Proposal,
  type SeoFields,
  type SeoInfo,
  type SeoIssue,
  type SeoPage,
  type SeoReport,
  type WorkspaceStatus,
} from "@/lib/site-api";
import { LIMITS, descriptionMeter, effectiveSeo, liveChecks, titleMeter, truncateToWidth, type Meter } from "@/lib/seo";
import { useSite } from "./site-context";
import { Badge, Button, ErrorText, Field, Notice, Section, inputClass } from "./ui";

/**
 * The SEO tab: how every page shows up in search results and when it's shared. The copy's own
 * scripts/seo.js does the work: "seo-audit" measures every page, "seo-set" saves fields typed here,
 * "seo-claude" has Claude write them (one page as a preview proposal, or every page at once).
 */

const LEVEL_STYLE: Record<SeoIssue["level"], string> = {
  error: "text-red-600 dark:text-red-400",
  warning: "text-amber-700 dark:text-amber-400",
  tip: "text-sky-700 dark:text-sky-400",
  note: "text-zinc-500",
};

function scoreStyle(score: number) {
  if (score >= 80) return "bg-green-600 text-white";
  if (score >= 50) return "bg-amber-500 text-white";
  return "bg-red-600 text-white";
}

function Score({ value, large = false }: { value: number; large?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold tabular-nums ${scoreStyle(value)} ${large ? "size-14 text-xl" : "h-6 min-w-9 px-2 text-xs"}`}
      title={`SEO score ${value} out of 100`}
    >
      {value}
    </span>
  );
}

const levelCount = (page: SeoPage, level: SeoIssue["level"]) => page.issues.filter((i) => i.level === level).length;

export function SeoPanel() {
  const { owner, repo, busy, version, run, hasKey, setStatus, refresh } = useSite();
  const [info, setInfo] = useState<SeoInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [direction, setDirection] = useState("");
  const [force, setForce] = useState(false);
  const [installing, setInstalling] = useState(false);
  const autoChecked = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<SeoInfo>(workspacePath(owner, repo, "/seo"))
      .then((next) => {
        if (cancelled) return;
        setInfo(next);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  // Measure the pages when there's no audit yet, or a page changed since the last one. Once per
  // audit: if the check fails, the user re-runs it with the button rather than in a loop.
  useEffect(() => {
    if (!info?.available || busy || (info.report && !info.stale)) return;
    const stamp = info.report?.createdAt ?? "none";
    if (autoChecked.current === stamp) return;
    autoChecked.current = stamp;
    void run("seo-audit");
  }, [info, busy, run]);

  async function install() {
    setInstalling(true);
    setError(null);
    try {
      const result = await api<{ written: string[]; status: WorkspaceStatus }>(workspacePath(owner, repo, "/install/seo"), {
        method: "POST",
        body: {},
      });
      setStatus(result.status);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setInstalling(false);
    }
  }

  const report = info?.report ?? null;
  const pages = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return [...(report?.pages ?? [])]
      .filter((p) => !needle || `${p.url} ${p.file} ${p.seo.title}`.toLowerCase().includes(needle))
      .sort((a, b) => a.score - b.score || a.url.localeCompare(b.url));
  }, [report, filter]);

  if (!info) {
    return (
      <Section title="Search engine optimisation">
        {error ? <ErrorText error={error} /> : <p className="text-sm text-zinc-500">Loading…</p>}
      </Section>
    );
  }

  if (!info.available) {
    return (
      <Section
        title="Search engine optimisation"
        description="Set each page's search title, description, focus keyphrase and social image, by hand or with Claude, and preview how it shows up in search results."
      >
        <Notice>
          This site was copied before SEO was added to the template. Adding it copies <code className="font-mono">scripts/seo.js</code>,{" "}
          <code className="font-mono">scripts/lib/seo.js</code> and the template&apos;s build, check, content loader and page shell (
          <code className="font-mono">templates/partials/base.html</code>) into this site, replacing those files. You review them on the
          Changes tab before publishing.
        </Notice>
        <div className="mt-3 flex items-center gap-3">
          <Button variant="primary" disabled={busy || installing} onClick={install}>
            {installing ? "Adding…" : "Add SEO from the template"}
          </Button>
          <ErrorText error={error} />
        </div>
      </Section>
    );
  }

  const checking = !report || info.stale;
  const missing = report?.pages.filter((p) => !p.fields.noindex && (!p.fields.metaTitle || !p.fields.metaDescription)).length ?? 0;

  return (
    <>
      <Section
        title="Search engine optimisation"
        description="How every page shows up in search results and when it's shared. Write a page's title, description and focus keyphrase yourself, or let Claude write them from what the page says."
      >
        {!info.template && (
          <div className="mb-4">
            <Notice tone="warning">
              This site&apos;s page shell (<code className="font-mono">templates/partials/base.html</code>) doesn&apos;t output the SEO
              tags yet, so saved fields won&apos;t reach the built pages.{" "}
              <Button variant="ghost" className="underline" disabled={busy || installing} onClick={install}>
                Update it from the template
              </Button>
            </Notice>
          </div>
        )}
        {report ? (
          <div className="flex flex-wrap items-center gap-4">
            <Score value={report.summary.average} large />
            <div className="text-sm">
              <p className="font-medium">Average score across {report.summary.pages} pages</p>
              <p className="text-zinc-500">
                {report.summary.errors} error{report.summary.errors === 1 ? "" : "s"}, {report.summary.warnings} warning
                {report.summary.warnings === 1 ? "" : "s"} · checked {new Date(report.createdAt).toLocaleString()}
                {info.stale && " · pages changed since"}
              </p>
            </div>
            <Button className="ml-auto" disabled={busy} onClick={() => run("seo-audit")}>
              Check again
            </Button>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">{busy ? "Checking every page…" : "No check yet."}</p>
        )}

        <div className="mt-5 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-sm font-medium">Write every page&apos;s SEO with Claude</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Claude writes the title, description and focus keyphrase of {force ? "every page" : `the ${missing} page${missing === 1 ? "" : "s"} without their own`}{" "}
            from what each page says, one request per page, and checks each against the others so none repeat. The changes appear on the
            Changes tab. To review one page first, open it below.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              maxLength={2000}
              placeholder="Direction for every page (optional), e.g. aim at UK charities"
              className={`${inputClass} min-w-60 flex-1`}
              disabled={busy}
            />
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} disabled={busy} />
              Include pages that have it
            </label>
            <Button
              variant="primary"
              disabled={busy || !hasKey || (!force && missing === 0)}
              onClick={() => run("seo-claude", { all: true, force, instruction: direction.trim() || undefined })}
            >
              Write with Claude
            </Button>
          </div>
        </div>
        <div className="mt-3">
          <ErrorText error={error} />
        </div>
      </Section>

      <Section title="Pages" description="Worst first. Open a page to see it as a search result, change its fields or ask Claude for a suggestion.">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by URL, file or title"
          className={`${inputClass} mb-3`}
          aria-label="Filter pages"
        />
        {!report && <p className="text-sm text-zinc-500">{checking && busy ? "Checking…" : "Run a check to list the pages."}</p>}
        {report && report.pages.length === 0 && <p className="text-sm text-zinc-500">No pages yet.</p>}
        <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {pages.map((page) => {
            const expanded = open === page.file;
            const errors = levelCount(page, "error");
            const warnings = levelCount(page, "warning");
            return (
              <li key={page.file}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : page.file)}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900"
                >
                  <Score value={page.score} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{page.seo.title}</span>
                    <span className="block truncate font-mono text-xs text-zinc-500">{page.url}</span>
                  </span>
                  {page.draft && <Badge>Draft</Badge>}
                  {page.fields.noindex && <Badge>Hidden</Badge>}
                  {errors > 0 && <span className="text-xs text-red-600 dark:text-red-400">{errors} error{errors === 1 ? "" : "s"}</span>}
                  {warnings > 0 && <span className="text-xs text-amber-700 dark:text-amber-400">{warnings} warning{warnings === 1 ? "" : "s"}</span>}
                  <span className="text-zinc-400" aria-hidden>
                    {expanded ? "▾" : "▸"}
                  </span>
                </button>
                {expanded && (
                  <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
                    <SeoEditor key={`${page.file}:${JSON.stringify(page.fields)}`} page={page} report={report!} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ editor */

const FIELD_ORDER: (keyof SeoFields)[] = ["metaTitle", "metaDescription", "focusKeyword", "ogImage", "ogImageAlt", "canonical", "noindex"];

function SeoEditor({ page, report }: { page: SeoPage; report: SeoReport }) {
  const { owner, repo, busy, version, run, job, hasKey, setStatus, refresh } = useSite();
  const [fields, setFields] = useState<SeoFields>(page.fields);
  const [direction, setDirection] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Claude's suggestion for this page, from the latest preview run.
  useEffect(() => {
    let cancelled = false;
    api<{ proposal: Proposal | null }>(workspacePath(owner, repo, "/proposal"))
      .then(({ proposal: next }) => !cancelled && setProposal(next?.mode === "seo" && next.file === page.file ? next : null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version, page.file]);

  const changed = FIELD_ORDER.filter((name) => fields[name] !== page.fields[name]);
  const set = <K extends keyof SeoFields>(name: K, value: SeoFields[K]) => setFields((f) => ({ ...f, [name]: value }));
  const seo = effectiveSeo(page, fields);
  const checks = liveChecks(page, fields, report.pages);
  const claudeRunning = job?.status === "running" && job.command === "seo-claude";

  function save() {
    void run("seo-set", { page: page.file, fields: Object.fromEntries(changed.map((name) => [name, fields[name]])) });
  }

  async function applySuggestion() {
    if (!proposal) return;
    setApplying(true);
    setError(null);
    try {
      const result = await api<{ status: WorkspaceStatus }>(workspacePath(owner, repo, "/proposal/apply"), {
        method: "POST",
        body: { content: proposal.content },
      });
      setStatus(result.status);
      setProposal(null);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setApplying(false);
    }
  }

  async function discardSuggestion(useIt: boolean) {
    if (!proposal) return;
    if (useIt && proposal.seo) setFields((f) => ({ ...f, ...proposal.seo }));
    setError(null);
    try {
      await api(workspacePath(owner, repo, "/proposal"), { method: "DELETE" });
      setProposal(null);
    } catch (err) {
      setError(err);
    }
  }

  const imagePath = fields.ogImage.trim() || page.seo.defaultImagePath || (page.fields.ogImage ? "" : page.seo.imagePath);

  // Stacked: the desktop result needs its full width (about 600px) to show where Google cuts the text.
  return (
    <div className="space-y-5">
      <Previews page={page} title={seo.title} description={seo.description} socialTitle={seo.socialTitle} imagePath={imagePath} siteName={report.site.name} siteUrl={report.site.url} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className="text-sm font-medium">{changed.length ? "Your changes" : "Checks"}</h4>
          <ul className="mt-1 space-y-0.5 text-sm">
            {checks.map((check) => (
              <li key={check.message} className={check.ok ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}>
                {check.ok ? "✓" : "!"} {check.message}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="text-sm font-medium">Last check {changed.length > 0 && <span className="font-normal text-zinc-500">(before your changes)</span>}</h4>
          {page.issues.length === 0 ? (
            <p className="mt-1 text-sm text-green-700 dark:text-green-400">No issues.</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-sm">
              {page.issues.map((issue, i) => (
                <li key={i}>
                  <span className={`text-xs font-semibold uppercase ${LEVEL_STYLE[issue.level]}`}>{issue.level}</span> {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="SEO title" hint={<MeterBar meter={titleMeter(seo.title)} unset={!fields.metaTitle} />}>
          <input value={fields.metaTitle} onChange={(e) => set("metaTitle", e.target.value)} placeholder={page.seo.defaultTitle} maxLength={200} className={inputClass} disabled={busy} />
        </Field>
        <Field label="Meta description" hint={<MeterBar meter={descriptionMeter(seo.description)} unset={!fields.metaDescription} />}>
          <textarea
            value={fields.metaDescription}
            onChange={(e) => set("metaDescription", e.target.value.replace(/\n/g, " "))}
            placeholder={page.seo.defaultDescription || "What the page offers, in one or two sentences."}
            maxLength={400}
            rows={3}
            className={inputClass}
            disabled={busy}
          />
        </Field>
        <Field label="Focus keyphrase" hint="The search phrase this page should be found for. Checked against the title, description, heading and introduction.">
          <input value={fields.focusKeyword} onChange={(e) => set("focusKeyword", e.target.value)} maxLength={100} className={inputClass} disabled={busy} />
        </Field>
        <SocialImageField value={fields.ogImage} fallback={page.seo.defaultImagePath || ""} onChange={(value) => set("ogImage", value)} disabled={busy} />
        <Field label="Social image alt text" hint="What the image shows, for people who can't see it.">
          <input value={fields.ogImageAlt} onChange={(e) => set("ogImageAlt", e.target.value)} maxLength={300} className={inputClass} disabled={busy} />
        </Field>
        <Field label="Canonical URL" hint="Only when another URL has the same content: search engines index that one instead. Empty means this page.">
          <input value={fields.canonical} onChange={(e) => set("canonical", e.target.value)} placeholder={page.absoluteUrl} maxLength={500} className={inputClass} disabled={busy} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={fields.noindex} onChange={(e) => set("noindex", e.target.checked)} disabled={busy} />
          Hide from search engines (noindex, and left out of the sitemap)
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={busy || changed.length === 0}>
            Save
          </Button>
          <Button disabled={busy || changed.length === 0} onClick={() => setFields(page.fields)}>
            Undo changes
          </Button>
        </div>
      </form>
      <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <p className="text-sm font-medium">Suggest with Claude</p>
        <p className="mt-0.5 text-xs text-zinc-500">
          Claude writes the title, description and focus keyphrase from the page{page.fields.focusKeyword ? `, keeping the keyphrase "${page.fields.focusKeyword}" unless you give a direction` : ""}. You see it here before anything changes.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            maxLength={2000}
            placeholder="Direction (optional), e.g. target “Salesforce data migration UK”"
            className={`${inputClass} min-w-48 flex-1`}
            disabled={busy}
          />
          <Button disabled={busy || !hasKey} onClick={() => run("seo-claude", { page: page.file, instruction: direction.trim() || undefined, dryRun: true })}>
            {claudeRunning ? "Claude is writing…" : "Suggest"}
          </Button>
        </div>
        {proposal?.seo && (
          <Suggestion
            proposal={proposal}
            page={page}
            siteName={report.site.name}
            siteUrl={report.site.url}
            busy={busy || applying}
            onApply={applySuggestion}
            onUse={() => discardSuggestion(true)}
            onDiscard={() => discardSuggestion(false)}
          />
        )}
        <div className="mt-2">
          <ErrorText error={error} />
        </div>
      </div>
    </div>
  );
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function readAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/**
 * The social image: pick one of the site's images from thumbnails, upload a new one (saved to
 * assets/img/uploads/ like the Claude tab's uploads), or type a path or https URL. The value is
 * the site path ("/assets/img/…") or the URL; "" uses `fallback`.
 */
function SocialImageField({ value, fallback, onChange, disabled }: { value: string; fallback: string; onChange: (value: string) => void; disabled: boolean }) {
  const { owner, repo, version, refresh } = useSite();
  const [images, setImages] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [filter, setFilter] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Re-read after every command and upload, so a new image shows up.
  useEffect(() => {
    let cancelled = false;
    api<{ images: string[] }>(workspacePath(owner, repo, "/images"))
      .then(({ images: list }) => !cancelled && setImages(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  async function upload(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(new Error(`${file.name} is over 5 MB.`));
      return;
    }
    setUploading(true);
    try {
      const saved = await api<{ path: string }>(workspacePath(owner, repo, "/uploads"), {
        method: "POST",
        body: { name: file.name, data: await readAsBase64(file) },
      });
      onChange(`/${saved.path}`);
      setBrowsing(false);
      // A new file in the site: update the change count and the image list.
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  }

  const shown = value.trim() || fallback;
  const thumb = (path: string) => {
    const local = path.replace(/^\/+/, "");
    if (/^https?:\/\//i.test(path)) return path;
    return /^assets\/img\/[\w./-]+\.(png|jpe?g|gif|webp)$/i.test(local) ? workspaceImageUrl(owner, repo, local) : null;
  };
  const shownThumb = shown ? thumb(shown) : null;
  const needle = filter.trim().toLowerCase();
  const listed = images.filter((image) => !needle || image.toLowerCase().includes(needle));

  return (
    <div>
      <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">Social image</span>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <span className="grid h-15.75 w-30 shrink-0 place-items-center overflow-hidden rounded border border-zinc-200 bg-zinc-100 text-center text-[10px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
          {shownThumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shownThumb} alt="" className="size-full object-cover" />
          ) : shown ? (
            /\.svg($|\?)/i.test(shown) ? "SVG: not shown by social sites" : "No preview"
          ) : (
            "No image"
          )}
        </span>
        <span className="flex flex-wrap gap-2">
          <Button disabled={disabled} onClick={() => setBrowsing((b) => !b)} aria-expanded={browsing}>
            {browsing ? "Close" : "Choose from the site"}
          </Button>
          <label
            className={`rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium dark:border-zinc-700 ${disabled || uploading ? "opacity-50" : "cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
          >
            {uploading ? "Uploading…" : "Upload"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="sr-only"
              disabled={disabled || uploading}
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          {value && (
            <Button variant="ghost" disabled={disabled} onClick={() => onChange("")}>
              Remove
            </Button>
          )}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        {value ? "This page's own image." : fallback ? `Not set, so ${fallback} is used.` : "Not set."} Shown when the page is shared. PNG or JPEG, ideally
        1200 × 630.
      </p>

      {browsing && (
        <div className="mt-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
          {images.length === 0 ? (
            <p className="p-2 text-sm text-zinc-500">No images in assets/img yet. Upload one.</p>
          ) : (
            <>
              {images.length > 8 && (
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter images" className={`${inputClass} mb-2`} aria-label="Filter images" />
              )}
              <ul className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-4">
                {listed.map((image) => {
                  const selected = value === `/${image}`;
                  return (
                    <li key={image}>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          onChange(`/${image}`);
                          setBrowsing(false);
                        }}
                        aria-pressed={selected}
                        title={image}
                        className={`block w-full overflow-hidden rounded border text-left ${selected ? "border-foreground ring-2 ring-foreground" : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800"}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={workspaceImageUrl(owner, repo, image)} alt="" loading="lazy" className="aspect-[1.91/1] w-full bg-zinc-100 object-cover dark:bg-zinc-900" />
                        <span className="block truncate px-1.5 py-1 text-[11px] text-zinc-500">{image.replace(/^assets\/img\//, "")}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}

      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Or type a path (/assets/img/…) or an https URL"
        maxLength={500}
        className={`${inputClass} mt-2`}
        disabled={disabled}
        aria-label="Social image path or URL"
      />
      <div className="mt-1">
        <ErrorText error={error} />
      </div>
    </div>
  );
}

function MeterBar({ meter, unset }: { meter: Meter; unset: boolean }) {
  const colour = { good: "bg-green-600", short: "bg-amber-500", long: "bg-red-600", empty: "bg-zinc-300" }[meter.tone];
  return (
    <span className="block">
      <span className="block h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <span className={`block h-full ${colour}`} style={{ width: `${Math.min(100, (meter.px / meter.max) * 100)}%` }} />
      </span>
      <span className="mt-1 block">
        {meter.chars} characters · {meter.px} of about {meter.max}px{meter.tone === "long" ? ", so it's cut off" : ""}
        {unset && " · empty, so the default shown in grey applies"}
      </span>
    </span>
  );
}

function Suggestion({
  proposal,
  page,
  siteName,
  siteUrl,
  busy,
  onApply,
  onUse,
  onDiscard,
}: {
  proposal: Proposal;
  page: SeoPage;
  siteName: string;
  siteUrl: string;
  busy: boolean;
  onApply: () => void;
  onUse: () => void;
  onDiscard: () => void;
}) {
  const s = proposal.seo!;
  const rows: [string, string, string][] = [
    ["Title", page.seo.title, s.metaTitle],
    ["Description", page.seo.description, s.metaDescription],
    ["Focus keyphrase", page.fields.focusKeyword, s.focusKeyword],
  ];
  return (
    <div className="mt-3 space-y-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <p className="text-sm font-medium">Claude suggests</p>
      <dl className="space-y-2 text-sm">
        {rows.map(([label, before, after]) => (
          <div key={label}>
            <dt className="text-xs font-medium text-zinc-500">{label}</dt>
            <dd>{after || <span className="text-zinc-500">(none)</span>}</dd>
            {before !== after && <dd className="text-xs text-zinc-500 line-through">{before || "(none)"}</dd>}
          </div>
        ))}
      </dl>
      <GooglePreview title={s.metaTitle} description={s.metaDescription} url={page.url} date={page.seo.type === "article" ? page.date : null} siteName={siteName} siteUrl={siteUrl} mobile={false} />
      {[...proposal.problems, ...proposal.warnings].map((w) => (
        <p key={w} className="text-xs text-amber-700 dark:text-amber-400">
          ! {w}
        </p>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || proposal.problems.length > 0} onClick={onApply}>
          Apply
        </Button>
        <Button disabled={busy} onClick={onUse}>
          Edit before saving
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- previews */

type PreviewView = "desktop" | "mobile" | "social";

function Previews(props: { page: SeoPage; title: string; description: string; socialTitle: string; imagePath: string; siteName: string; siteUrl: string }) {
  const [view, setView] = useState<PreviewView>("desktop");
  const { page } = props;
  return (
    <div>
      <div className="flex gap-1" role="tablist" aria-label="Preview">
        {(
          [
            ["desktop", "Google, desktop"],
            ["mobile", "Google, mobile"],
            ["social", "Shared link"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className={`rounded px-2.5 py-1 text-xs font-medium ${view === id ? "bg-foreground text-background" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mt-2">
        {view === "social" ? (
          <SocialPreview title={props.socialTitle} description={props.description} imagePath={props.imagePath} siteUrl={props.siteUrl} />
        ) : (
          <GooglePreview
            title={props.title}
            description={props.description}
            url={page.url}
            date={page.seo.type === "article" ? page.date : null}
            siteName={props.siteName}
            siteUrl={props.siteUrl}
            mobile={view === "mobile"}
          />
        )}
      </div>
      {page.fields.noindex && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">This page is hidden from search engines, so it won&apos;t appear in results at all.</p>}
    </div>
  );
}

const hostOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/+$/, "");

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** A search result as Google lays it out, with the title and description cut where Google cuts them. */
function GooglePreview({
  title,
  description,
  url,
  date,
  siteName,
  siteUrl,
  mobile,
}: {
  title: string;
  description: string;
  url: string;
  date: string | null;
  siteName: string;
  siteUrl: string;
  mobile: boolean;
}) {
  const shownTitle = truncateToWidth(title, LIMITS.titleSize, LIMITS.titlePx).text;
  // Phones show less of the description: about 680px at the same size.
  const shownDescription = truncateToWidth(description, LIMITS.descriptionSize, mobile ? 680 : LIMITS.descriptionPx).text;
  const crumbs = [hostOf(siteUrl), ...url.split("/").filter(Boolean)].join(" › ");
  const when = date ? formatDate(date) : "";
  return (
    <div
      className={`rounded-lg border border-zinc-200 bg-white p-4 text-left text-[#202124] shadow-sm dark:border-zinc-700 ${mobile ? "max-w-[380px]" : "max-w-[640px]"}`}
      style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
    >
      <div className="flex items-center gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full border border-[#dadce0] bg-[#f1f3f4] text-xs font-bold">
          {(siteName || hostOf(siteUrl)).slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-sm">{siteName}</span>
          <span className="block truncate text-xs text-[#4d5156]">{crumbs}</span>
        </span>
      </div>
      <p className={`mt-2 text-[#1a0dab] ${mobile ? "text-lg leading-snug" : "truncate text-xl leading-tight"}`}>{shownTitle || <span className="text-zinc-400">No title</span>}</p>
      <p className="mt-1 text-sm leading-[1.58] text-[#4d5156]">
        {when && <span className="text-[#70757a]">{when} — </span>}
        {shownDescription || <span className="text-zinc-400">No description: Google picks text from the page.</span>}
      </p>
    </div>
  );
}

/** A shared link as Facebook, LinkedIn and Slack show it (og:image, og:title, og:description). */
function SocialPreview({ title, description, imagePath, siteUrl }: { title: string; description: string; imagePath: string; siteUrl: string }) {
  const { owner, repo } = useSite();
  const [failed, setFailed] = useState<string | null>(null);
  const local = imagePath.replace(/^\/+/, "");
  const src = /^https?:\/\//i.test(imagePath)
    ? imagePath
    : /^assets\/img\/[\w./-]+\.(png|jpe?g|gif|webp)$/i.test(local)
      ? workspaceImageUrl(owner, repo, local)
      : null;
  const svg = /\.svg($|\?)/i.test(imagePath);
  return (
    <div className="max-w-[520px] overflow-hidden rounded-lg border border-zinc-300 bg-[#f2f3f5] text-left text-[#1d2129] dark:border-zinc-700" style={{ fontFamily: "Helvetica, Arial, sans-serif" }}>
      <div className="grid aspect-[1.91/1] place-items-center bg-[#dddfe2] text-center text-xs text-[#606770]">
        {src && failed !== src ? (
          // A preview of the site's own file or the URL given, at the size social sites crop to.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="size-full object-cover" onError={() => setFailed(src)} />
        ) : (
          <span className="px-6">
            {!imagePath ? "No image: shared without one." : svg ? "SVG image: social sites don't show it, so the link is shared without an image." : `Can't preview ${imagePath}.`}
          </span>
        )}
      </div>
      <div className="border-t border-[#dadde1] px-3 py-2">
        <p className="truncate text-xs uppercase text-[#606770]">{hostOf(siteUrl)}</p>
        <p className="truncate text-base font-semibold">{title}</p>
        <p className="line-clamp-2 text-sm text-[#606770]">{description}</p>
      </div>
    </div>
  );
}
