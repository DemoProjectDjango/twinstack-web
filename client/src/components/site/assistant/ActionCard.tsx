"use client";

import { useEffect, useState, type ReactNode } from "react";
import { COPY_PROGRESS_EVENT, type CopyProgress } from "@/lib/copy-website";
import { api, workspacePath } from "@/lib/site-api";
import { attachmentUrl, type AssistantAction } from "@/lib/assistant-api";
import { LiveDiff } from "../LiveDiff";
import { useSite } from "../site-context";
import { Badge, Button, Details, Spinner } from "../ui";
import { seeItOf } from "./AiActivity";
import { useAssistant } from "./AssistantProvider";

// One change Claude proposed, as a card in the chat: what it does in plain words, what exactly
// changes (folded away), and the buttons to apply or skip it.

const SEO_LABELS: Record<string, string> = {
  metaTitle: "Search title",
  metaDescription: "Search description",
  focusKeyword: "Focus keyphrase",
  ogImage: "Social image",
  ogImageAlt: "Social image description",
  canonical: "Canonical address",
  noindex: "Hidden from search engines",
};

const PAGE_TYPES: Record<string, string> = {
  page: "Page",
  post: "Blog post",
  service: "Service",
  product: "Product",
  case: "Case study",
  homepage: "Homepage",
  listing: "Listing page (lists its pages by itself)",
};

const APPLY_LABEL: Partial<Record<AssistantAction["tool"], string>> = {
  edit_page: "Write it",
  design_header_and_footer: "Design them",
  create_page: "Create it",
  delete_page: "Remove page",
  add_file_to_site: "Add it",
  write_file: "Save it",
  edit_file: "Save it",
  append_blocks_from_attachment: "Add them",
  move_file: "Rename it",
  remove_file: "Remove file",
  create_pdf: "Create it",
  set_page_hidden: "Do it",
  undo_changes: "Undo them",
  create_image: "Save it",
  convert_page_from_html: "Bring it in",
  copy_website: "Make the prototype",
  check_site: "Check it",
  create_missing_pages: "Create them",
  write_search_text_for_all_pages: "Write it",
  publish_changes: "Publish now",
};

const json = (value: unknown) => JSON.stringify(value ?? null, null, 2);
const show = (value: unknown) => (value === undefined || value === null || value === "" ? "(not set)" : value === true ? "Yes" : value === false ? "No" : String(value));

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-zinc-500">{label}</dt>
          <dd className="whitespace-pre-wrap break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BeforeAfter({ rows }: { rows: [string, unknown, unknown][] }) {
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-zinc-500">
        <tr>
          <th className="pb-1 pr-2 font-normal" />
          <th className="pb-1 pr-2 font-normal">Now</th>
          <th className="pb-1 font-normal">After</th>
        </tr>
      </thead>
      <tbody className="align-top">
        {rows.map(([label, before, after]) => (
          <tr key={label}>
            <td className="py-1 pr-2 text-zinc-500">{label}</td>
            <td className="py-1 pr-2 text-zinc-500 line-through decoration-zinc-400">{show(before)}</td>
            <td className="py-1 font-medium">{show(after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The photos a page edit places: attached ones by name once added, the rest by path. */
function imageRows(images: unknown): [string, ReactNode][] {
  const list = Array.isArray(images) ? (images as string[]) : [];
  return list.length ? [["Photos", list.map((i) => (i.startsWith("att_") ? "an attached photo" : i)).join(", ")]] : [];
}

const LOGO_USES: Record<string, string> = {
  logo: "Logo",
  logoDark: "Logo on dark backgrounds",
  logoMark: "Small mark",
  favicon: "Browser-tab icon",
};

const svgUrl = (preview: unknown) => (typeof preview === "string" && preview.startsWith("data:image/svg+xml;") ? preview : null);

/**
 * A drawn image (create_image), shown on a light and a dark background so the owner sees it as the
 * header and the footer will, with its square version (the small mark and browser-tab icon) when it
 * has one. Previews are the checked SVGs as data: URLs, which an <img> never runs anything from.
 */
function DrawnImage({ preview, markPreview }: { preview: unknown; markPreview: unknown }) {
  const image = svgUrl(preview);
  const mark = svgUrl(markPreview);
  if (!image) return null;
  return (
    <div className="mt-2 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {["bg-white", "bg-zinc-900"].map((background) => (
          <div key={background} className={`grid h-24 place-items-center rounded-md border border-zinc-200 p-3 dark:border-zinc-800 ${background}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt="The drawn image" className="max-h-full max-w-full object-contain" />
          </div>
        ))}
      </div>
      {mark && (
        <div className="flex items-center gap-3 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
          {/* The size it's shown at in the header, then the browser tab's. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={mark} alt="Its square version" className="size-10" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={mark} alt="" className="size-4" />
          <span className="text-xs text-zinc-500">Small mark and browser-tab icon</span>
        </div>
      )}
    </div>
  );
}

/**
 * A picture the image model made (create_image with a prompt), shown from its copy kept with the
 * conversation (…/assistant/attachments/:id), with the drawn square version when there is one.
 */
function MadeImage({ attachment, markPreview }: { attachment: string; markPreview: unknown }) {
  const { owner, repo } = useSite();
  const url = attachmentUrl(owner, repo, attachment);
  return (
    <div className="mt-2 space-y-2">
      <a href={url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="The picture" className="max-h-72 w-full bg-zinc-100 object-contain dark:bg-zinc-900" />
      </a>
      <DrawnImage preview={markPreview} markPreview={null} />
    </div>
  );
}

/** What exactly the change does, for anyone who wants to check. */
function ChangeDetails({ action }: { action: AssistantAction }) {
  const input = action.input as Record<string, unknown>;
  const meta = action.meta as Record<string, unknown>;
  switch (action.tool) {
    case "design_header_and_footer":
      return <Rows rows={[["The AI's request to the designer", show(input.instruction || "Match the look of the site's pages")]]} />;
    case "edit_page":
      return (
        <Rows
          rows={[
            ["Page", show(meta.title)],
            ["The AI's request to the writer", show(input.instruction)],
            ...imageRows(input.images),
          ]}
        />
      );
    case "add_file_to_site":
      return (
        <Rows
          rows={[
            ["File", show(meta.file)],
            ["Goes to", `/${show(meta.path)}`],
            ...(meta.replaces ? ([["Replaces", "The file already there"]] as [string, ReactNode][]) : []),
          ]}
        />
      );
    case "move_file":
      return <Rows rows={[["From", show(input.file)], ["To", show(input.to)]]} />;
    case "create_pdf":
      return (
        <Rows
          rows={[
            ["Saved as", `/${show(meta.path)}`],
            ...(meta.replaces ? ([["Replaces", "The file already there"]] as [string, ReactNode][]) : []),
            ["Title", show(input.title)],
            ["What it says", show(input.content)],
          ]}
        />
      );
    case "set_page_hidden":
      return <Rows rows={[["Page", show(meta.title)], ["Visitors", input.hidden ? "Can't see it" : "Can see it"]]} />;
    case "update_site_scripts":
      return <LiveDiff before={json(meta.before)} after={json(input.scripts)} label="Changes" />;
    case "undo_changes":
      return <Rows rows={[["Goes back to the last published version", (input.files as string[]).join("\n")]]} />;
    case "edit_file":
    case "write_file":
      return (
        <div className="space-y-2">
          <Rows rows={[["File", show(input.file)], ...(/^(assets|static)\//.test(String(input.file)) ? ([["Published at", show(meta.address)]] as [string, ReactNode][]) : [])]} />
          <LiveDiff before={String(meta.before ?? "")} after={String(input.content ?? "")} label={meta.exists ? "Changes" : "New file"} />
        </div>
      );
    case "check_site":
      return <Rows rows={[["What it does", "Builds your site and looks for what would stop the live site from updating. It changes nothing."]]} />;
    case "copy_website":
      return (
        <Rows
          rows={[
            ["Website", show(input.url)],
            ["Pages, at most", show(input.maxPages)],
            ["Design", input.mode === "upgrade" ? "Copied, then upgraded" : "Same as the original"],
            ...(input.mode === "upgrade" && Array.isArray(input.upgrades) ? ([["Upgrades", (input.upgrades as string[]).join("; ")]] as [string, ReactNode][]) : []),
            ["What it does", "First a prototype: the pages it will build, pictured here (no credits). Build it brings them into your site looking the same, with their pictures, fonts and styles; its header and footer become your site's, and pages at the same addresses are replaced. Building uses some AI credits per page. Nothing is live until you publish."],
          ]}
        />
      );
    case "append_blocks_from_attachment": {
      const failed = (meta.failed ?? []) as { file: string; reason: string }[];
      return (
        <Rows
          rows={[
            ["From", show(meta.name)],
            ["Files to add to", show(meta.ready)],
            ...(meta.skipped ? ([["Already done", show(meta.skipped)]] as [string, ReactNode][]) : []),
            ...(failed.length ? ([["Can't be added", failed.map((f) => `${f.file}: ${f.reason}`).join("\n")]] as [string, ReactNode][]) : []),
            ["Files", ((meta.files ?? []) as string[]).join("\n")],
          ]}
        />
      );
    }
    case "remove_file":
      return (
        <Rows
          rows={[
            ["File", show(input.file)],
            ["Published at", show(meta.address)],
            ...((meta.usedBy as string[] | undefined)?.length ? ([["Still used by", (meta.usedBy as string[]).join(", ")]] as [string, ReactNode][]) : []),
          ]}
        />
      );
    case "convert_page_from_html":
      return (
        <Rows
          rows={[
            ["Page it replaces", show(meta.title)],
            ["From", show(meta.source)],
            ...((meta.extras as string[] | undefined)?.length ? ([["With", (meta.extras as string[]).join(", ")]] as [string, ReactNode][]) : []),
            ["Keeps its own look", show(input.keepStyles === true)],
            ...(input.direction ? ([["Direction", show(input.direction)]] as [string, ReactNode][]) : []),
          ]}
        />
      );
    case "create_page":
      return (
        <Rows
          rows={[
            ["Kind", PAGE_TYPES[input.type as string] ?? show(input.type)],
            ["Title", show(input.title)],
            ...(meta.address ? ([["Web address", show(meta.address)]] as [string, ReactNode][]) : input.slug ? ([["Web address", `/${input.slug}`]] as [string, ReactNode][]) : []),
            ...(meta.address ? [] : ([["Hidden at first", show(input.hidden === true)]] as [string, ReactNode][])),
            ...(input.brief ? ([["What it should say", show(input.brief)]] as [string, ReactNode][]) : []),
            ...imageRows(input.images),
          ]}
        />
      );
    case "delete_page":
      return <Rows rows={[["Page", show(meta.title)], ["File", show(input.file)]]} />;
    case "update_site_plan":
    case "update_stylesheet":
    case "update_notes_for_claude":
      return <LiveDiff before={String(meta.before ?? "")} after={String(input.content ?? "")} label="Changes" />;
    case "update_menu_and_footer":
      return <LiveDiff before={json(meta.before)} after={json(input.navigation)} label="Changes" />;
    case "update_site_details":
      return <LiveDiff before={json(meta.before)} after={json(input.data)} label={`Changes to ${show(meta.label)}`} />;
    case "update_page_search_settings": {
      const fields = (input.fields ?? {}) as Record<string, unknown>;
      const before = (meta.before ?? {}) as Record<string, unknown>;
      return <BeforeAfter rows={Object.keys(fields).map((f) => [SEO_LABELS[f] ?? f, before[f], fields[f]])} />;
    }
    case "create_image": {
      const useAs = Array.isArray(input.useAs) ? (input.useAs as string[]) : [];
      const markFields = input.markSvg && Array.isArray(input.markFields) ? (input.markFields as string[]) : [];
      const uses = (fields: string[]) => fields.map((f) => LOGO_USES[f] ?? f).join(", ");
      const picture = meta.picture as { prompt?: string; quality?: string; size?: string } | undefined;
      return (
        <Rows
          rows={[
            ...(picture
              ? ([
                  ["Made from", show(picture.prompt)],
                  ["Size", `${show(picture.size?.replace("x", " × "))}, ${show(picture.quality)} quality`],
                ] as [string, ReactNode][])
              : []),
            ["Saved as", `/${show(meta.path)}`],
            ["Used as", useAs.length ? uses(useAs) : "Not used anywhere yet"],
            ...(markFields.length ? ([["Square version", `/${show(meta.markPath)}, used as ${uses(markFields)}`]] as [string, ReactNode][]) : []),
          ]}
        />
      );
    }
    case "update_logo_settings": {
      const brand = (input.brand ?? {}) as Record<string, unknown>;
      const before = (meta.before ?? {}) as Record<string, unknown>;
      return <BeforeAfter rows={Object.keys(brand).map((f) => [f === "logoText" ? "Name" : f, before[f], brand[f]])} />;
    }
    case "schedule_page":
      return (
        <Rows
          rows={[
            ["Date", show(input.date)],
            ["Title", show(input.title)],
            ["Goes in", show(input.location)],
            ["Brief", show(input.brief)],
            ...(input.notes ? ([["Notes", show(input.notes)]] as [string, ReactNode][]) : []),
          ]}
        />
      );
    case "publish_changes":
      return <Rows rows={[["Note for the site's history", show(input.message)], ["Changes", show(meta.changes)]]} />;
    case "write_search_text_for_all_pages":
      return (
        <Rows
          rows={[
            ["Pages", input.force ? "Every page" : "Pages without their own search text"],
            ...(input.direction ? ([["Direction", show(input.direction)]] as [string, ReactNode][]) : []),
          ]}
        />
      );
    default:
      return null;
  }
}

function StatusBadge({ action, busy }: { action: AssistantAction; busy: boolean }) {
  if (busy || action.status === "running") return <Badge>{busy ? "Working…" : "Interrupted"}</Badge>;
  const label = { proposed: "Proposed", ready: "Ready to look at", applied: "Done", skipped: "Skipped", failed: "Didn't work" }[action.status];
  const tone =
    action.status === "applied"
      ? "border-green-300 text-green-800 dark:border-green-900 dark:text-green-300"
      : action.status === "failed"
        ? "border-red-300 text-red-700 dark:border-red-900 dark:text-red-400"
        : action.status === "ready"
          ? "border-sky-300 text-sky-800 dark:border-sky-900 dark:text-sky-300"
          : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400";
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${tone}`}>{label}</span>;
}

type CopiedPage = { id: string; url: string; address: string; title: string | null; shots: string[]; broughtIn: boolean; chromeSource: boolean; replaces?: boolean };

/**
 * A copied website's prototype (copy_website, "ready"): every page it will build, pictured on a
 * computer or a phone, with the design the owner chose and the upgrades planned. Nothing is in the
 * site yet; "Build it" builds it. While it builds, the progress shows here.
 */
function CopyPrototype({ action, building }: { action: AssistantAction; building: boolean }) {
  const { owner, repo, version } = useSite();
  const [copy, setCopy] = useState<{ host: string; url: string; pages: CopiedPage[]; skipped: { url: string; reason: string }[] } | null>(null);
  const [screen, setScreen] = useState<"computer" | "phone">("computer");
  const [progress, setProgress] = useState<CopyProgress | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ copy: typeof copy }>(workspacePath(owner, repo, "/copy-website"))
      .then((data) => !cancelled && setCopy(data.copy))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version, action.status]);

  useEffect(() => {
    const onProgress = (event: Event) => setProgress((event as CustomEvent<CopyProgress>).detail);
    window.addEventListener(COPY_PROGRESS_EVENT, onProgress);
    return () => window.removeEventListener(COPY_PROGRESS_EVENT, onProgress);
  }, []);

  if (!copy) return null;
  const upgrade = action.meta.mode === "upgrade";
  const upgrades = (action.meta.upgrades as string[] | undefined) ?? [];
  return (
    <div className="mt-2 space-y-2 rounded-md border border-sky-200 bg-sky-50/50 p-2 dark:border-sky-900 dark:bg-sky-950/20">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-sky-800 dark:text-sky-300">Prototype</span>
        <Badge>{upgrade ? "Copied, then upgraded" : "Same as the original"}</Badge>
        <span className="ml-auto inline-flex overflow-hidden rounded border border-zinc-300 text-xs dark:border-zinc-700">
          {(["computer", "phone"] as const).map((s) => (
            <button key={s} type="button" onClick={() => setScreen(s)} className={`px-2 py-0.5 ${screen === s ? "bg-foreground text-background" : ""}`}>
              {s === "computer" ? "Computer" : "Phone"}
            </button>
          ))}
        </span>
      </div>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        {copy.pages.length} {copy.pages.length === 1 ? "page" : "pages"} of {copy.host} {action.status === "applied" ? "were built into your site." : "will be built into your site, looking like this. Nothing is added until you press Build it."}
      </p>
      <ul className={`grid gap-2 ${screen === "computer" ? "grid-cols-2" : "grid-cols-3"}`}>
        {copy.pages.map((page) => {
          const src = workspacePath(owner, repo, `/copy-website/shots/${page.id}/${page.shots.includes(screen) ? screen : "computer"}`);
          return (
            <li key={page.id} className="overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
              <a href={src} target="_blank" rel="noreferrer" title="Open the full picture">
                {/* A private workspace picture: next/image adds nothing here. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`${page.title ?? page.address}, on a ${screen}`} loading="lazy" className={`w-full object-cover object-top ${screen === "computer" ? "h-28" : "h-40"}`} />
              </a>
              <div className="px-1.5 py-1">
                <span className="block truncate text-xs font-medium">{page.title ?? page.address}</span>
                <span className="block truncate text-[11px] text-zinc-500">
                  {page.address}
                  {page.chromeSource ? " · its header and footer" : ""}
                  {page.broughtIn ? " · built" : ""}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {upgrade && upgrades.length > 0 && (
        <div className="text-xs">
          <span className="font-medium">Upgrades once it&apos;s built:</span>
          <ul className="mt-0.5 list-disc pl-5 text-zinc-700 dark:text-zinc-300">
            {upgrades.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {copy.skipped.length > 0 && <p className="text-[11px] text-zinc-500">Left out: {copy.skipped.map((s) => s.url).join(", ")}</p>}
      {building && progress && (
        <p role="status" className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <Spinner />
          {progress.retryPass
            ? `Trying the pages that didn't work again in a moment (try ${progress.retryPass} of 3)…`
            : `Building page ${Math.min(progress.done + 1, progress.total)} of ${progress.total}${progress.working ? `: ${progress.working}` : ""}. You can keep working or reload: it carries on.`}
        </p>
      )}
    </div>
  );
}

export function ActionCard({ id }: { id: string }) {
  const { actions, working, apply, retry, skip, keep, throwAway, turn, applyingAll } = useAssistant();
  const { busy: siteBusy, editFile, showSection, showOnSite, overview } = useSite();
  const action = actions[id];
  if (!action) return null;

  const busy = working.has(id);
  // Proposals from an answer still being written can't be applied yet.
  const pending = turn?.status === "running" && turn.actions.some((a) => a.id === id);
  // While "Accept all" (or automatic changes) works through the cards, they wait their turn.
  const locked = busy || pending || applyingAll;
  const interrupted = action.status === "running" && !busy;
  const file = (action.input.file as string | undefined) ?? (/content\/[\w./-]+\.md/.exec(action.result ?? "")?.[0] ?? null);
  const settled = action.status === "applied" || action.status === "skipped";

  return (
    <div className={`rounded-lg border p-3 ${action.status === "ready" ? "border-sky-400 dark:border-sky-700" : "border-zinc-200 dark:border-zinc-800"} ${settled ? "opacity-80" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{action.title}</span>
        <StatusBadge action={action} busy={busy} />
      </div>
      <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{action.summary}</p>
      {action.tool === "create_image" &&
        (typeof action.meta.attachment === "string" ? (
          <MadeImage attachment={action.meta.attachment} markPreview={action.meta.markPreview} />
        ) : (
          <DrawnImage preview={(action.meta as Record<string, unknown>).preview} markPreview={(action.meta as Record<string, unknown>).markPreview} />
        ))}

      {action.tool === "copy_website" && (action.status === "ready" || action.status === "applied" || (busy && action.result)) && <CopyPrototype action={action} building={busy} />}

      <div className="mt-2">
        <Details summary="What exactly changes">
          <ChangeDetails action={action} />
        </Details>
      </div>

      {action.result && action.status !== "proposed" && (
        <p className={`mt-2 whitespace-pre-wrap break-words text-xs ${action.status === "failed" ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>{action.result}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {busy && (
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            <Spinner />{" "}
            {action.tool === "edit_page" || action.tool === "create_page" ? "The AI is writing the page…" : action.tool === "design_header_and_footer" ? "The AI is designing the header and footer…" : action.tool === "convert_page_from_html" ? "The AI is bringing in the page…" : "Working on it…"}
          </span>
        )}
        {action.status === "proposed" && !busy && (
          <>
            <Button variant={action.tool === "delete_page" || action.tool === "remove_file" || action.tool === "undo_changes" ? "danger" : "primary"} className="text-xs" disabled={locked} onClick={() => void apply(action)}>
              {APPLY_LABEL[action.tool] ?? "Apply"}
            </Button>
            <Button variant="ghost" className="text-xs" disabled={locked} onClick={() => void skip(action)}>
              Skip
            </Button>
          </>
        )}
        {action.status === "ready" && !busy && action.tool === "copy_website" && (
          <>
            <Button variant="primary" className="text-xs" disabled={siteBusy} onClick={() => void keep(action)}>
              Build it
            </Button>
            <Button className="text-xs" disabled={siteBusy} onClick={() => void throwAway(action)}>
              Not now
            </Button>
          </>
        )}
        {action.status === "ready" && !busy && action.tool !== "copy_website" && (
          <>
            <Button variant="primary" className="text-xs" disabled={siteBusy} onClick={() => void keep(action)}>
              Keep this version
            </Button>
            <Button className="text-xs" disabled={siteBusy} onClick={() => void throwAway(action)}>
              Throw it away
            </Button>
            {action.tool === "design_header_and_footer" ? (
              <Button variant="ghost" className="text-xs underline" onClick={() => showSection("design")}>
                Look at it first
              </Button>
            ) : (
              file && (
                <Button variant="ghost" className="text-xs underline" onClick={() => void editFile(file, "edit")}>
                  Look at it first
                </Button>
              )
            )}
          </>
        )}
        {/* A finished page: open it on Edit site, at any time later too. */}
        {!busy && (() => {
          const target = seeItOf(action, overview?.collections.flatMap((c) => c.pages) ?? []);
          return (
            target && (
              <Button variant="primary" className="text-xs" onClick={() => showOnSite(target.url)}>
                {action.tool === "design_header_and_footer" ? "See it on your site" : "See the page"}
              </Button>
            )
          );
        })()}
        {(action.status === "failed" || interrupted) && !busy && (
          <>
            <Button className="text-xs" onClick={() => void retry(action)}>
              Try again
            </Button>
            <Button variant="ghost" className="text-xs" onClick={() => void skip(action)}>
              Skip
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
