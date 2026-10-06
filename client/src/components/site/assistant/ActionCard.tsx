"use client";

import type { ReactNode } from "react";
import type { AssistantAction } from "@/lib/assistant-api";
import { LiveDiff } from "../LiveDiff";
import { useSite } from "../site-context";
import { Badge, Button, Details, Spinner } from "../ui";
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
  create_page: "Create it",
  delete_page: "Remove page",
  add_file_to_site: "Add it",
  convert_page_from_html: "Bring it in",
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

/** What exactly the change does, for anyone who wants to check. */
function ChangeDetails({ action }: { action: AssistantAction }) {
  const input = action.input as Record<string, unknown>;
  const meta = action.meta as Record<string, unknown>;
  switch (action.tool) {
    case "edit_page":
      return (
        <Rows
          rows={[
            ["Page", show(meta.title)],
            ["Claude's request to the writer", show(input.instruction)],
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

export function ActionCard({ id }: { id: string }) {
  const { actions, working, apply, skip, keep, throwAway, turn } = useAssistant();
  const { busy: siteBusy, editFile } = useSite();
  const action = actions[id];
  if (!action) return null;

  const busy = working.has(id);
  // Proposals from an answer still being written can't be applied yet.
  const pending = turn?.status === "running" && turn.actions.some((a) => a.id === id);
  const locked = busy || pending;
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
            {action.tool === "edit_page" || action.tool === "create_page" ? "Claude is writing the page…" : action.tool === "convert_page_from_html" ? "Claude is bringing in the page…" : "Working on it…"}
          </span>
        )}
        {action.status === "proposed" && !busy && (
          <>
            <Button variant={action.tool === "delete_page" ? "danger" : "primary"} className="text-xs" disabled={locked} onClick={() => void apply(action)}>
              {APPLY_LABEL[action.tool] ?? "Apply"}
            </Button>
            <Button variant="ghost" className="text-xs" disabled={locked} onClick={() => void skip(action)}>
              Skip
            </Button>
          </>
        )}
        {action.status === "ready" && !busy && (
          <>
            <Button variant="primary" className="text-xs" disabled={siteBusy} onClick={() => void keep(action)}>
              Keep this version
            </Button>
            <Button className="text-xs" disabled={siteBusy} onClick={() => void throwAway(action)}>
              Throw it away
            </Button>
            {file && (
              <Button variant="ghost" className="text-xs underline" onClick={() => void editFile(file, "edit")}>
                Look at it first
              </Button>
            )}
          </>
        )}
        {(action.status === "failed" || interrupted) && !busy && (
          <>
            <Button className="text-xs" onClick={() => void apply(action)}>
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
