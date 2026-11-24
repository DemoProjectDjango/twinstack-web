"use client";

import { SiteUpdateCard, ToolsNotice, formatDay } from "./HomePanel";
import { JobLog } from "./JobLog";
import { useSite } from "./site-context";
import { ScreenHeader, Section } from "./ui";

/** Advanced: site updates, where the site stands in git, and the full output of the last command. The testing tools (build, install, changelog, preview with hidden pages) were taken out on Nov 24: the editor runs them by itself. */
export function BuildPanel() {
  const { status, siteUpdate } = useSite();
  const info = siteUpdate.info;

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="Technical log"
        description="Site updates, where your site stands, and the full output of the last thing that ran, for when something didn't work."
      />

      <ToolsNotice />

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
