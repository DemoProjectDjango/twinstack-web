"use client";

import { DomainSettings } from "./DomainSettings";
import { useSite } from "./site-context";
import { Button, ErrorText, Notice, ScreenHeader, Spinner } from "./ui";

/**
 * "Your domain": connecting the owner's own domain name, a screen of its own in the menu. It used to
 * be only at the foot of the Publish screen ("What's changed"), and only once Pages was on, so
 * owners didn't find it. Before the site is published it says what to do first.
 */
export function DomainPanel() {
  const { publishing, busy } = useSite();
  const info = publishing.publishing;

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="Your domain"
        description="Use your own web address (like www.yourbusiness.com) instead of the free github.io one. You'll add two or three records where you bought the domain; the steps are below."
      />
      {!info ? (
        publishing.error ? (
          <ErrorText error={publishing.error} />
        ) : (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner /> Loading your web address…
          </p>
        )
      ) : !info.canConfigure ? (
        <Notice tone="warning">
          Only the owner (an admin) of this site&apos;s GitHub repository can connect a domain. Ask them to open this screen, or to make you an admin of the repository.
        </Notice>
      ) : !info.enabled ? (
        <Notice tone="info">
          <span className="font-medium">Your site isn&apos;t on the web yet.</span> Turn publishing on first; then connect your domain here.{" "}
          <Button variant="primary" className="ml-1" disabled={busy || publishing.working !== null} onClick={() => void publishing.act("enable")}>
            {publishing.working === "enable" ? "Turning it on…" : "Turn on publishing"}
          </Button>
          <ErrorText error={publishing.error} />
        </Notice>
      ) : (
        <>
          {info.url && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Your site is at{" "}
              <a href={info.url} target="_blank" rel="noreferrer" className="font-medium underline">
                {info.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
              </a>
              .
            </p>
          )}
          <DomainSettings
            publishing={info}
            defaultOpen
            onChange={(next) => {
              publishing.setPublishing(next);
              // A domain change starts a redeploy: watch it closely.
              publishing.watch();
            }}
          />
        </>
      )}
    </div>
  );
}
