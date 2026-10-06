"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, workspacePath, type BrandInfo, type Publishing } from "@/lib/site-api";
import { confirmModal } from "@/lib/confirm";
import { useSite, type SiteSection } from "./site-context";
import { Button, EmptyState, ErrorText, Notice, ScreenHeader, Segmented, Spinner, StepList, type Step } from "./ui";

/** Remembers, per browser, that someone has looked at a screen (for ticking off "check your details"). */
function visitedKey(owner: string, repo: string, section: SiteSection) {
  return `twinstack:visited:${owner}/${repo}:${section}`;
}

export function markVisited(owner: string, repo: string, section: SiteSection) {
  try {
    localStorage.setItem(visitedKey(owner, repo, section), "1");
  } catch {
    // Storage can be blocked; the step just stays unticked.
  }
}

function wasVisited(owner: string, repo: string, section: SiteSection) {
  try {
    return localStorage.getItem(visitedKey(owner, repo, section)) === "1";
  } catch {
    return false;
  }
}

/** The site at a glance: is it live, what's unpublished, what to do next, and what it looks like now. */
export function HomePanel() {
  const { owner, repo, status, overview, claude, version, busy, run, showSection, publishing } = useSite();
  const [brand, setBrand] = useState<BrandInfo | null>(null);
  // Read once per visit to Home: the other screens mark themselves visited.
  const [detailsSeen] = useState(() => wasVisited(owner, repo, "details"));
  const [pagesSeen] = useState(() => wasVisited(owner, repo, "pages"));

  useEffect(() => {
    let cancelled = false;
    api<BrandInfo>(workspacePath(owner, repo, "/brand"))
      .then((b) => !cancelled && setBrand(b))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  const pageCount = overview?.collections.reduce((n, c) => n + c.pages.length, 0) ?? null;
  const changes = status.changes.length;
  const live = publishing.publishing?.run?.conclusion === "success";

  const steps: Step[] = [
    {
      id: "logo",
      title: "Add your logo and colours",
      text: "Upload your logo and choose the colours of the top and bottom of every page.",
      done: Boolean(brand?.brand.logo || brand?.brand.logoMark),
      action: <Button onClick={() => showSection("design")}>Open Design</Button>,
    },
    {
      id: "pages",
      title: "Add and write your pages",
      text: claude.ready ? "Write each page yourself, or give Claude your notes and let it write the page." : "Write what each page should say.",
      done: pagesSeen && pageCount !== null && pageCount > 0,
      action: <Button onClick={() => showSection("pages")}>Open Pages</Button>,
    },
    {
      id: "details",
      title: "Check your business details",
      text: "Your business name, email, phone and address appear across the whole site.",
      done: detailsSeen,
      action: <Button onClick={() => showSection("details")}>Open Site details</Button>,
    },
    {
      id: "publish",
      title: "Publish",
      text: "Put your changes on the web for everyone to see.",
      done: live && changes === 0 && !status.ahead,
      action: (
        <Button variant="primary" onClick={() => showSection("publish")}>
          Review and publish
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <ScreenHeader title="Home" description="Your site at a glance. Follow the steps, and check the preview as you go." />

      <LiveCard />

      <ToolsNotice />

      {changes > 0 && (
        <Notice>
          <span className="font-medium">
            You have {changes} change{changes === 1 ? "" : "s"} that {changes === 1 ? "isn't" : "aren't"} on your live site yet.
          </span>{" "}
          <Button variant="ghost" className="ml-1 underline" onClick={() => showSection("publish")}>
            Review and publish
          </Button>
        </Notice>
      )}

      {!claude.ready && (
        <Notice>
          <span className="font-medium">Claude can write and improve your pages for you.</span> It&apos;s optional: you can
          also write everything yourself.{" "}
          <Link href={claude.setupHref} className="ml-1 underline">
            {claude.setupLabel}
          </Link>
        </Notice>
      )}

      <section aria-labelledby="next-steps" className="space-y-3">
        <h3 id="next-steps" className="font-semibold">
          Next steps
        </h3>
        <StepList steps={steps} />
      </section>

      <Preview
        empty={status.build === "empty" || pageCount === 0}
        onStarterPages={() => run("scaffold", { dryRun: false, force: false })}
        onAddPage={() => showSection("pages")}
        busy={busy}
      />
    </div>
  );
}

function deployLabel(p: Publishing): { text: string; tone: string } | null {
  const run = p.run;
  if (!run) return null;
  if (run.status !== "completed") return { text: "Updating now…", tone: "text-sky-700 dark:text-sky-400" };
  if (run.conclusion === "success") return { text: "Live", tone: "text-green-700 dark:text-green-400" };
  if (run.conclusion === "cancelled") return { text: "The last update was cancelled", tone: "text-zinc-500" };
  return { text: "The last update didn't work", tone: "text-red-700 dark:text-red-400" };
}

/** Where the site is on the web, and whether the latest version has gone out. */
function LiveCard() {
  const { busy, publishing: state, showSection } = useSite();
  const { publishing, error, working, act } = state;

  if (!publishing) {
    return error ? <ErrorText error={error} /> : null;
  }

  const label = deployLabel(publishing);
  const failed = publishing.run?.status === "completed" && publishing.run.conclusion !== "success";
  const locked = busy || working !== null;

  return (
    <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      {publishing.enabled && publishing.url ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-zinc-500">Your site&apos;s address</p>
            <a href={publishing.url} target="_blank" rel="noreferrer" className="break-all text-lg font-medium hover:underline">
              {publishing.url.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
            </a>
            {label ? (
              <p className={`mt-1 text-sm ${label.tone}`}>{label.text}</p>
            ) : (
              <p className="mt-1 text-sm text-zinc-500">Not published yet. Publish your changes to put it online.</p>
            )}
          </div>
          {failed && publishing.run?.conclusion !== "cancelled" && (
            <Button variant="primary" onClick={() => showSection("publish")}>
              See why
            </Button>
          )}
          {failed && publishing.workflowReady && (
            <Button disabled={locked} onClick={() => void act("deploy")}>
              {working === "deploy" ? "Starting…" : "Try again"}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Your site isn&apos;t on the web yet</p>
            <p className="mt-1 text-sm text-zinc-500">
              Turn on publishing to give it a web address. It&apos;s free.
              {publishing.private && " A private site needs a paid GitHub plan to go on the web."}
            </p>
          </div>
          {publishing.canConfigure && (
            <Button variant="primary" disabled={locked} onClick={() => void act("enable")}>
              {working === "enable" ? "Turning on…" : "Turn on publishing"}
            </Button>
          )}
        </div>
      )}
      {error ? (
        <div className="mt-2">
          <ErrorText error={error} />
        </div>
      ) : null}
    </section>
  );
}

/** Some features are switched off until this copy gets the template's newer files. */
export function ToolsNotice({ compact = false }: { compact?: boolean }) {
  const { busy, tools, showSection, status } = useSite();

  // Until it's published: the update is an ordinary change.
  if (tools.written && tools.outdated.length === 0 && status.changes.length > 0) {
    return (
      <Notice tone="success">
        Site tools updated.{" "}
        <Button variant="ghost" className="ml-1 underline" onClick={() => showSection("publish")}>
          Publish to finish
        </Button>
      </Notice>
    );
  }
  if (tools.outdated.length === 0) return null;

  return (
    <Notice tone="warning">
      {compact ? (
        "This needs newer site tools. "
      ) : (
        <>
          <span className="font-medium">Your site&apos;s tools are out of date,</span> so some things are switched off (
          {tools.outdated.join(", ")}).{" "}
        </>
      )}
      <Button
        variant="ghost"
        className="ml-1 underline"
        disabled={busy || tools.updating}
        onClick={async () => {
          const ok = await confirmModal(
            "Update your site's tools to the latest version? Any changes made by hand to those tool files are replaced. You'll publish the update like any other change.",
            { confirmLabel: "Update site tools" },
          );
          if (ok) void tools.update();
        }}
      >
        {tools.updating ? "Updating…" : "Update site tools"}
      </Button>
      {tools.error ? (
        <div className="mt-2">
          <ErrorText error={tools.error} />
        </div>
      ) : null}
    </Notice>
  );
}

/** The latest build of the site, rebuilt by the editor after every change. */
function Preview({ empty, onStarterPages, onAddPage, busy }: { empty: boolean; onStarterPages: () => void; onAddPage: () => void; busy: boolean }) {
  const { status, version, job } = useSite();
  const [width, setWidth] = useState<"desktop" | "phone">("desktop");
  const updating = job?.status === "running" && (job.command === "preview" || job.command === "install");

  return (
    <section aria-labelledby="preview-heading" className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="preview-heading" className="font-semibold">
          Preview
        </h3>
        {updating && (
          <span className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner /> Updating…
          </span>
        )}
        <span className="ml-auto flex items-center gap-3">
          <Segmented
            label="Preview size"
            value={width}
            onChange={setWidth}
            options={[
              { value: "desktop", label: "Computer" },
              { value: "phone", label: "Phone" },
            ]}
          />
          {status.previewUrl && (
            <a href={status.previewUrl} target="_blank" rel="noreferrer" className="text-sm text-zinc-500 hover:underline">
              Open full size ↗
            </a>
          )}
        </span>
      </div>
      <p className="text-sm text-zinc-500">
        This is how your site looks with your latest changes, including pages you&apos;ve hidden. It updates by itself.
      </p>

      {empty && !updating ? (
        <EmptyState
          title="Your site has no pages yet"
          action={
            <>
              <Button variant="primary" disabled={busy} onClick={onStarterPages}>
                Create the starter pages
              </Button>
              <Button onClick={onAddPage}>Add a page</Button>
            </>
          }
        >
          Start with the pages the site plan lists (home, about, contact and so on), or add your own one at a time.
        </EmptyState>
      ) : status.previewUrl ? (
        // Sandboxed without allow-same-origin: the site's scripts can't act as the user on this app.
        <iframe
          key={version}
          src={status.previewUrl}
          title="Site preview"
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          className={`mx-auto block h-[40rem] rounded-md border border-zinc-200 bg-white dark:border-zinc-800 ${
            width === "phone" ? "w-[390px] max-w-full" : "w-full"
          } ${updating ? "opacity-60" : ""}`}
        />
      ) : (
        <div className="flex h-60 items-center justify-center gap-3 rounded-md border border-dashed border-zinc-300 text-sm text-zinc-500 dark:border-zinc-700">
          {updating ? (
            <>
              <Spinner /> Preparing the preview…
            </>
          ) : (
            "The preview appears here once your site has been built."
          )}
        </div>
      )}
    </section>
  );
}
