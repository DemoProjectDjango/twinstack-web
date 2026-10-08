"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "@/lib/toast";
import { api, workspacePath, type MissingPage, type MissingPages as MissingPagesState, type WorkspaceStatus } from "@/lib/site-api";
import { useAssistant } from "./assistant/AssistantProvider";
import { useSite } from "./site-context";
import { Button, ErrorText } from "./ui";

const quoted = (title: string) => `“${title}”`;

/** "Home", "Home and About", "Home, About and 3 more". */
function linkedFrom(page: MissingPage) {
  const names = page.from.map((f) => quoted(f.title));
  if (names.length > 3) return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "a page");
}

/** The link's own text as a title, when it reads like one. */
const titleFrom = (page: MissingPage) => (page.label && page.label.length <= 60 && !page.label.startsWith("/") ? page.label : undefined);

const what = (page: MissingPage) => (page.kind === "home" ? "Your homepage" : page.kind === "listing" ? `The ${page.collection ?? ""} listing page`.replace("  ", " ") : page.href);

const dismissKey = (owner: string, repo: string) => `twinstack:missing-pages:${owner}/${repo}`;
function readDismissed(owner: string, repo: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(dismissKey(owner, repo)) ?? "[]");
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Pages the site links to but doesn't have, right after the build that found them (every change
 * rebuilds the preview by itself), on whatever screen the owner is on: each with "Create" (a page
 * at exactly that address, ready to write) and, with Claude set up, "Create and write with
 * Claude", which asks the assistant to make it at that address and write it. "Not now" hides the
 * ones shown until another link to a missing page turns up.
 */
export function MissingPages() {
  const { owner, repo, version, busy, claude, setStatus, refresh, editFile } = useSite();
  const { send, turn } = useAssistant();
  const [state, setState] = useState<MissingPagesState | null>(null);
  // Nothing shows before the first fetch, so reading storage here can't differ from the server render.
  const [dismissed, setDismissed] = useState<string[]>(() => readDismissed(owner, repo));
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    api<MissingPagesState>(workspacePath(owner, repo, "/missing-pages"))
      .then((next) => !cancelled && setState(next))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  const pages = useMemo(
    () => (state?.fresh ? (state.report?.missing ?? []) : []).filter((p) => !dismissed.includes(p.href)),
    [state, dismissed],
  );
  if (!pages.length) return null;

  const locked = busy || working !== null;
  const claudeBusy = turn?.status === "running";

  /** Makes one page; returns its file. */
  async function create(page: MissingPage) {
    const title = titleFrom(page);
    const [route, body] =
      page.kind === "home"
        ? ["/pages/homepage", { title }]
        : page.kind === "listing"
          ? ["/pages/listing", { collection: page.collection, title }]
          : ["/pages/at", { url: page.href, title }];
    const made = await api<{ file: string; status: WorkspaceStatus }>(workspacePath(owner, repo, route), { method: "POST", body });
    setStatus(made.status);
    return made.file;
  }

  async function createSome(list: MissingPage[], label: string) {
    setWorking(label);
    setError(null);
    try {
      const files: string[] = [];
      for (const page of list) files.push(await create(page));
      await refresh();
      const first = files[0];
      toast.success(
        <span>
          {files.length === 1 ? "Page added" : `${files.length} pages added`}, with placeholder text for now.{" "}
          {first && (
            <button type="button" className="font-medium underline" onClick={() => void editFile(first)}>
              Write {files.length === 1 ? "it" : "the first"}
            </button>
          )}
        </span>,
      );
    } catch (err) {
      setError(err);
    } finally {
      setWorking(null);
    }
  }

  function withClaude(list: MissingPage[]) {
    const lines = list.map((p) => `- ${what(p)}${p.label ? ` (the link says "${p.label}")` : ""}, linked from ${linkedFrom(p)}`);
    void send(
      `My site links to ${list.length === 1 ? "a page that doesn't" : "pages that don't"} exist yet. Create ${list.length === 1 ? "it" : "each one"} with create_page at exactly the address the link points to (for an ordinary page, type page with that address), and write ${list.length === 1 ? "it" : "each"} from what the rest of my site says, in the site's look:\n${lines.join("\n")}`,
    );
  }

  function notNow() {
    const next = [...new Set([...dismissed, ...pages.map((p) => p.href)])];
    setDismissed(next);
    try {
      localStorage.setItem(dismissKey(owner, repo), JSON.stringify(next.slice(-200)));
    } catch {
      // Private mode: hidden for this visit only.
    }
  }

  return (
    <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
      <p className="font-medium">
        Your site links to {pages.length === 1 ? "a page that doesn't" : `${pages.length} pages that don't`} exist yet.
      </p>
      <p className="mt-1 text-sm opacity-80">
        Visitors who follow {pages.length === 1 ? "that link" : "those links"} get an error page, and they stop your site from going live. Make{" "}
        {pages.length === 1 ? "it" : "them"} now{claude.ready ? ", empty or written by Claude" : ""}.
      </p>
      <ul className="mt-3 space-y-2">
        {pages.map((page) => (
          <li key={page.href} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-amber-200 bg-background p-3 text-sm text-foreground dark:border-amber-900">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{page.kind === "page" ? <code className="font-mono">{page.href}</code> : what(page)}</span>
              {page.label && page.kind === "page" ? <span className="text-zinc-500"> “{page.label}”</span> : null}
              <span className="block text-xs text-zinc-500">Linked from {linkedFrom(page)}</span>
            </span>
            <Button className="px-2.5 py-1 text-xs" disabled={locked} onClick={() => void createSome([page], page.href)}>
              {working === page.href ? "Adding…" : "Create"}
            </Button>
            {claude.ready && (
              <Button className="px-2.5 py-1 text-xs" disabled={locked || claudeBusy} onClick={() => withClaude([page])}>
                <span aria-hidden="true">✦</span> Create and write with Claude
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error ? (
        <div className="mt-2">
          <ErrorText error={error} />
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {pages.length > 1 && claude.ready && (
          <Button variant="primary" disabled={locked || claudeBusy} onClick={() => withClaude(pages)}>
            <span aria-hidden="true">✦</span> Let Claude create and write them all
          </Button>
        )}
        {pages.length > 1 && (
          <Button disabled={locked} onClick={() => void createSome(pages, "all")}>
            {working === "all" ? "Adding…" : "Create them all, empty"}
          </Button>
        )}
        <Button variant="ghost" disabled={locked} onClick={notNow}>
          Not now
        </Button>
      </div>
    </div>
  );
}
