"use client";

import { useSite } from "./site-context";
import { Button, Notice, Section } from "./ui";

export function BuildPanel() {
  const { status, busy, run, version } = useSite();
  const needsInstall = status.needsInstall;

  return (
    <>
      <Section
        title="Build"
        description="Build and check is the same gate as npm run check: it fails on broken internal links or duplicate URLs, and warns about SEO gaps."
      >
        {needsInstall && (
          <div className="mb-4">
            <Notice tone="warning">Dependencies need installing before anything can build.</Notice>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy || needsInstall} onClick={() => run("check")}>
            Build and check
          </Button>
          <Button disabled={busy || needsInstall} onClick={() => run("preview")}>
            Build preview (with drafts)
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
        title="Preview"
        description="Shows the last build. Build and check leaves drafts out; Build preview includes drafts and future-dated posts."
      >
        {status.previewUrl ? (
          <>
            <div className="mb-2 flex justify-end">
              <a href={status.previewUrl} target="_blank" rel="noreferrer" className="text-sm text-zinc-500 hover:underline">
                Open in a new tab ↗
              </a>
            </div>
            {/* Sandboxed without allow-same-origin: the site's scripts can't act as the user on this app. */}
            <iframe
              key={version}
              src={status.previewUrl}
              title="Site preview"
              sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
              className="h-[36rem] w-full rounded-md border border-zinc-200 bg-white dark:border-zinc-800"
            />
          </>
        ) : (
          <p className="text-sm text-zinc-500">Nothing built yet. Run a build to see the site here.</p>
        )}
      </Section>
    </>
  );
}
