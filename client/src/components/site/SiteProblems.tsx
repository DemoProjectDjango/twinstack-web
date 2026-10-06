"use client";

import { useState } from "react";
import { toast } from "@/lib/toast";
import { api, workspacePath, type ProblemPage, type SiteCheckReport, type SiteProblem, type WorkspaceStatus } from "@/lib/site-api";
import { useAssistant } from "./assistant/AssistantProvider";
import { useSite } from "./site-context";
import { Button, Details, ErrorText, Spinner } from "./ui";

/** A fix the owner can make by hand: a page to open, or a page to add. */
type Fix = { label: string } & ({ open: string } | { add: { path: string; body: Record<string, string>; name: string } } | { screen: "design" | "tools" });

/** Problems that need the same fix, said once: "Your site has no homepage. About and Contact link to it." */
type Group = { key: string; text: string; fixes: Fix[] };

const quoted = (title: string) => `“${title}”`;

/** "About", "About and Contact", "About, Contact and Blog", "About, Contact, Blog, FAQ and 3 more". */
function titles(pages: ProblemPage[]) {
  const names = [...new Set(pages.map((p) => quoted(p.title)))];
  const shown = names.slice(0, 4);
  if (names.length > shown.length) return `${shown.join(", ")} and ${names.length - shown.length} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "A page");
}

const linkTo = (pages: ProblemPage[]) => `${titles(pages)} ${new Set(pages.map((p) => p.file)).size === 1 ? "links" : "link"} to it`;

/** The problems in plain words, grouped by what fixes them: the missing page first, then each page to change. */
function groupProblems(problems: SiteProblem[]): Group[] {
  const groups = new Map<string, Group & { pages: ProblemPage[] }>();
  const add = (key: string, make: () => Omit<Group, "key">, page?: ProblemPage | null) => {
    if (!groups.has(key)) groups.set(key, { key, ...make(), pages: [] });
    if (page) groups.get(key)!.pages.push(page);
  };

  for (const problem of problems) {
    switch (problem.kind) {
      case "missing-link": {
        const { page, href } = problem;
        if (problem.target === "home") {
          add("home", () => ({ text: "Your site has no homepage.", fixes: [{ label: "Add a homepage", add: { path: "/pages/homepage", body: {}, name: "Homepage" } }] }), page);
        } else if (problem.target === "listing" && problem.listing) {
          const { collection, label } = problem.listing;
          add(
            `listing:${collection}`,
            () => ({ text: `Your site has no ${label} page.`, fixes: [{ label: `Add the ${label} page`, add: { path: "/pages/listing", body: { collection }, name: `The ${label} page` } }] }),
            page,
          );
        } else if (problem.target === "hidden" && problem.hiddenPage) {
          const hidden = problem.hiddenPage;
          add(`hidden:${hidden.file}:${page?.file}`, () => ({
            text: `${page ? quoted(page.title) : "A page"} links to ${quoted(hidden.title)}, which is hidden.`,
            fixes: page ? [{ label: `Open ${quoted(page.title)}`, open: page.file }] : [],
          }));
        } else if (problem.inPageText && page) {
          add(`text:${page.file}:${href}`, () => ({
            text: `${quoted(page.title)} links to ${href}, which ${problem.target === "file" ? "isn't a file on your site" : "isn't a page on your site"}.`,
            fixes: [{ label: `Open ${quoted(page.title)}`, open: page.file }],
          }));
        } else {
          // The logo, menu, footer, a layout or the homepage's sections make this link, on every page they're on.
          add(
            `design:${href}`,
            () => ({ text: `Your site's design links to ${href}, which ${problem.target === "file" ? "isn't a file on your site" : "isn't a page on your site"}.`, fixes: [{ label: "Open Design", screen: "design" }] }),
            page,
          );
        }
        break;
      }
      case "duplicate":
        add(`duplicate:${problem.url}`, () => ({
          text: `${titles(problem.pages)} have the same web address (${problem.url}). Each page needs its own.`,
          fixes: problem.pages.map((p) => ({ label: `Open ${quoted(p.title)}`, open: p.file })),
        }));
        break;
      case "no-date":
        add(`no-date:${problem.page.file}`, () => ({
          text: `The blog post ${quoted(problem.page.title)} has no date.`,
          fixes: [{ label: `Open ${quoted(problem.page.title)}`, open: problem.page.file }],
        }));
        break;
      default:
        add(`other:${problem.message}`, () => ({ text: problem.message, fixes: [] }));
    }
  }

  // Missing pages say who links to them; the others already name their page.
  const order = (key: string) => (key === "home" ? 0 : key.startsWith("listing:") ? 1 : 2);
  return [...groups.values()]
    .sort((a, b) => order(a.key) - order(b.key))
    .map(({ pages, ...group }) => ({
      ...group,
      text: pages.length && (group.key === "home" || group.key.startsWith("listing:") || group.key.startsWith("design:")) ? `${group.text} ${linkTo(pages)}.` : group.text,
    }));
}

/** What Claude is asked, in the owner's words: Claude reads the details itself (read_site_problems). */
function claudeRequest(report: SiteCheckReport, groups: Group[]) {
  if (report.buildFailed) {
    return `My site can't be built, so it can't go live. Please find out why and fix it. This is the error:\n\n${report.failure ?? "(no details)"}`;
  }
  return `Please fix the problems that stop my site from going live:\n${groups.map((g) => `- ${g.text}`).join("\n")}`;
}

/**
 * What stops the live site from updating, found by the same check the deploy runs, beside the
 * Publish button: each problem in plain words with a fix to make by hand, and one button that asks
 * Claude to fix them all. The editor checks again by itself after every change.
 */
export function SiteProblems() {
  const { owner, repo, busy, claude, siteCheck, editFile, showSection, setStatus, refresh } = useSite();
  const { send, turn } = useAssistant();
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { report, fresh, checking, checkNow } = siteCheck;

  if (checking) {
    return (
      <p className="flex items-center gap-2 text-sm text-zinc-500">
        <Spinner /> Checking your site for problems…
      </p>
    );
  }
  if (!report) return null;
  if (!fresh) {
    return (
      <p className="text-sm text-zinc-500">
        Your site changed since it was last checked.{" "}
        <Button variant="ghost" className="ml-1 px-1.5 py-0.5 underline" disabled={busy} onClick={checkNow}>
          Check it now
        </Button>
      </p>
    );
  }
  if (report.ok) {
    return (
      <p className="text-sm text-green-700 dark:text-green-400">
        <span aria-hidden="true">✓</span> No problems found. Your site is ready to go live.
      </p>
    );
  }

  const groups = groupProblems(report.problems);
  const count = report.buildFailed ? 1 : groups.length + report.moreProblems;
  const locked = busy || working !== null;

  async function apply(fix: Fix) {
    if ("open" in fix) return void editFile(fix.open);
    if ("screen" in fix) return showSection(fix.screen);
    setWorking(fix.label);
    setError(null);
    try {
      const { file, status } = await api<{ file: string; status: WorkspaceStatus }>(workspacePath(owner, repo, fix.add.path), { method: "POST", body: fix.add.body });
      setStatus(status);
      await refresh();
      toast.success(
        <span>
          {fix.add.name} added, with placeholder text for now.{" "}
          <button type="button" className="font-medium underline" onClick={() => void editFile(file)}>
            Write it
          </button>
        </span>,
      );
    } catch (err) {
      setError(err);
    } finally {
      setWorking(null);
    }
  }

  return (
    <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-red-950 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100">
      <p className="font-medium">
        {report.buildFailed
          ? "Your site can't be built, so your live site can't update."
          : `${count} problem${count === 1 ? "" : "s"} will stop your live site from updating.`}
      </p>
      <p className="mt-1 text-sm opacity-80">
        {report.buildFailed
          ? claude.ready
            ? "Claude can find the cause and fix it. The full log has every detail."
            : "The full log has every detail."
          : `Fix ${count === 1 ? "it" : "them"} yourself with the buttons below${claude.ready ? `, or let Claude fix ${count === 1 ? "it" : "them"} for you` : ""}.`}
      </p>

      {report.buildFailed ? (
        <div className="mt-3 space-y-2">
          <Details summary="What went wrong" open>
            <pre className="max-h-64 overflow-auto rounded border border-red-200 bg-background p-2 font-mono text-xs text-foreground dark:border-red-900">{report.failure}</pre>
          </Details>
          <Button className="px-2.5 py-1 text-xs" onClick={() => showSection("tools")}>
            See the full log
          </Button>
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {groups.map((group) => (
            <li key={group.key} className="rounded-md border border-red-200 bg-background p-3 text-sm text-foreground dark:border-red-900">
              <p>{group.text}</p>
              {group.fixes.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {group.fixes.map((fix, i) => (
                    <Button key={`${fix.label}-${i}`} className="px-2.5 py-1 text-xs" disabled={locked} onClick={() => void apply(fix)}>
                      {working === fix.label ? "Adding…" : fix.label}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          ))}
          {report.moreProblems > 0 && <li className="text-sm">…and {report.moreProblems} more.</li>}
        </ul>
      )}

      {error ? (
        <div className="mt-2">
          <ErrorText error={error} />
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {claude.ready && (
          <Button variant="primary" disabled={turn?.status === "running"} onClick={() => void send(claudeRequest(report, groups))}>
            <span aria-hidden="true">✦</span> Fix with Claude
          </Button>
        )}
        <Button disabled={locked} onClick={checkNow}>
          Check again
        </Button>
      </div>
    </div>
  );
}
