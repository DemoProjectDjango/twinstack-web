"use client";

import { SiteUpdateCard, ToolsNotice, formatDay } from "./HomePanel";
import { JobLog } from "./JobLog";
import { useSite } from "./site-context";
import { Button, Notice, ScreenHeader, Section } from "./ui";

/** Advanced: the commands the editor normally runs by itself, their full output, and where the site stands in git. */
export function BuildPanel() {
  const { status, busy, run, siteUpdate } = useSite();
  const info = siteUpdate.info;
  const needsInstall = status.needsInstall;

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="Build tools and log"
        description="The editor builds the preview and installs what the site needs by itself. Use these when something looks wrong, and read the full output below."
      />

      <ToolsNotice />

      <Section
        title="Build"
        description="Build and check is the same check the live site runs before publishing: it fails on broken links between pages or two pages at the same address, and warns about missing search settings."
      >
        {needsInstall && (
          <div className="mb-4">
            <Notice tone="warning">The site&apos;s dependencies need installing before anything can build.</Notice>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy || needsInstall} onClick={() => run("check")}>
            Build and check
          </Button>
          <Button disabled={busy || needsInstall} onClick={() => run("preview")}>
            Rebuild the preview (with hidden pages)
          </Button>
          <Button disabled={busy} onClick={() => run("install")}>
            Install dependencies
          </Button>
          <Button disabled={busy || needsInstall} onClick={() => run("changelog")}>
            Regenerate changelog
          </Button>
        </div>
      </Section>

      <Section
        title="Site updates"
        description="Every change pushed to the site template reaches your site as an update. Updating keeps your pages, content and design."
      >
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-zinc-500">Your site has changes up to</dt>
          <dd>{info ? (info.current?.date ? formatDay(info.current.date) : "unknown") : "Couldn't check for updates"}</dd>
          <dt className="text-zinc-500">Latest template change</dt>
          <dd>
            {info?.latest?.date ? formatDay(info.latest.date) : "unknown"}
            {info && !info.available && " (your site has it)"}
          </dd>
        </dl>
        <div className="mt-4 space-y-3">
          <SiteUpdateCard showChanges />
        </div>
      </Section>

      <Section title="Where the site stands">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-zinc-500">Repository</dt>
          <dd>
            <a href={status.htmlUrl} target="_blank" rel="noreferrer" className="underline">
              {status.fullName} on GitHub ↗
            </a>
          </dd>
          <dt className="text-zinc-500">Branch</dt>
          <dd className="font-mono">
            {status.branch}
            {!status.onDefaultBranch && <span className="font-sans text-zinc-500"> (the live branch is {status.defaultBranch})</span>}
          </dd>
          <dt className="text-zinc-500">Unpublished files</dt>
          <dd>{status.changes.length}</dd>
          <dt className="text-zinc-500">Commits not pushed</dt>
          <dd>{status.ahead ?? "unknown"}</dd>
          <dt className="text-zinc-500">Newer commits on GitHub</dt>
          <dd>{status.behind ?? "unknown"}</dd>
        </dl>
      </Section>

      <JobLog />
    </div>
  );
}
