"use client";

import { useEffect, useState } from "react";
import { describeChange, summarizeChanges } from "@/lib/change-labels";
import { confirmModal } from "@/lib/confirm";
import { api, workspacePath, type FileDiff, type WorkspaceStatus } from "@/lib/site-api";
import { DomainSettings } from "./DomainSettings";
import { markVisited, wasVisited } from "./HomePanel";
import { SiteDetailsStep } from "./SiteDetailsStep";
import { useSite } from "./site-context";
import { SiteProblems } from "./SiteProblems";
import { Badge, Button, Details, EmptyState, ErrorText, Field, Notice, ScreenHeader, Section, inputClass } from "./ui";

type CommitResult = {
  branch: string;
  commit: string;
  pullRequest: { number: number; url: string } | null;
  status: WorkspaceStatus;
};

function lineClass(line: string) {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-zinc-500";
  if (line.startsWith("+")) return "bg-green-500/10 text-green-800 dark:text-green-300";
  if (line.startsWith("-")) return "bg-red-500/10 text-red-800 dark:text-red-300";
  if (line.startsWith("@@")) return "text-sky-700 dark:text-sky-400";
  return "";
}

/**
 * The Publish screen: what's changed since the last publish, in plain words, with undo, and one
 * button that commits everything and pushes it. Straight to the default branch (live) by default;
 * a pull request for review is an option.
 */
export function ChangesPanel() {
  const { owner, repo, status, overview, busy, setStatus, refresh, version, publishing, siteCheck } = useSite();
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState<"discard" | "commit" | null>(null);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"pr" | "direct">(status.onDefaultBranch ? "direct" : "pr");
  const [branch, setBranch] = useState("");
  const [result, setResult] = useState<(CommitResult & { mode: "pr" | "direct" }) | null>(null);
  // The first publish asks to check the site details first, unless they've been looked at already.
  const [detailsChecked, setDetailsChecked] = useState(() => wasVisited(owner, repo, "details"));
  const [checkingDetails, setCheckingDetails] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ files: FileDiff[] }>(workspacePath(owner, repo, "/diff"))
      .then(({ files: next }) => !cancelled && setFiles(next))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  async function discard(paths: string[], what: string) {
    if (!(await confirmModal(`Undo ${what}? This can't be undone.`, { confirmLabel: "Undo", danger: true }))) return;
    setWorking("discard");
    setError(null);
    try {
      setStatus(await api<WorkspaceStatus>(workspacePath(owner, repo, "/discard"), { method: "POST", body: { paths } }));
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setWorking(null);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (goesLive && !detailsChecked) setCheckingDetails(true);
    else void commit();
  }

  function detailsDone() {
    markVisited(owner, repo, "details");
    setDetailsChecked(true);
    setCheckingDetails(false);
    void commit();
  }

  async function commit() {
    const { report, fresh } = siteCheck;
    if (
      fresh &&
      report &&
      !report.ok &&
      !(await confirmModal("Your site still has problems that stop it from updating. If you publish now, your changes are saved, but your live site stays as it is until they're fixed.", {
        title: "Publish with problems?",
        confirmLabel: "Publish anyway",
        danger: true,
      }))
    ) {
      return;
    }
    setWorking("commit");
    setError(null);
    setResult(null);
    try {
      const note = message.trim() || summarizeChanges(status.changes, overview) || "Update the site";
      const body = { message: note, mode, ...(mode === "pr" && status.onDefaultBranch && branch.trim() && { branch: branch.trim() }) };
      const committed = await api<CommitResult>(workspacePath(owner, repo, "/commit"), { method: "POST", body });
      setResult({ ...committed, mode });
      setStatus(committed.status);
      setMessage("");
      setBranch("");
      publishing.watch();
      await refresh();
    } catch (err) {
      setError(err);
      // A failed push may still have committed locally.
      await refresh().catch(() => {});
    } finally {
      setWorking(null);
    }
  }

  const hasChanges = status.changes.length > 0;
  // With nothing new to commit, publishing still retries an earlier failed push.
  const canPublish = hasChanges || Boolean(status.ahead) || !status.onDefaultBranch;
  const disabled = busy || working !== null;
  const liveUrl = publishing.publishing?.enabled ? publishing.publishing.url : null;
  const goesLive = mode === "direct" && status.onDefaultBranch;
  // GitHub didn't put the last publish live (usually a problem the check below finds).
  const run = publishing.publishing?.run;
  const deployFailed = run?.status === "completed" && run.conclusion !== "success" && run.conclusion !== "cancelled";

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="Publish"
        description="Everything you've changed since you last published. Publish to put it on your live site, or undo anything you don't want."
      />

      {result && (
        <Notice tone="success">
          {result.mode === "direct" && result.branch === status.defaultBranch ? (
            <>
              <span className="font-medium">Published.</span> Your live site updates in about a minute.{" "}
              {liveUrl && (
                <a href={liveUrl} target="_blank" rel="noreferrer" className="font-medium underline">
                  View your site ↗
                </a>
              )}
            </>
          ) : (
            <>
              <span className="font-medium">Sent for review.</span> Your site changes once the review is approved on GitHub.{" "}
              {result.pullRequest && (
                <a href={result.pullRequest.url} target="_blank" rel="noreferrer" className="font-medium underline">
                  Open the review ↗
                </a>
              )}
            </>
          )}
        </Notice>
      )}

      <ErrorText error={error} />

      {!canPublish && deployFailed && !result && (
        <Section title="Your last publish didn't go live" description="Your changes reached GitHub, but your live site couldn't be updated with them.">
          <div className="space-y-3">
            <SiteProblems />
            {siteCheck.fresh && siteCheck.report?.ok && publishing.publishing?.workflowReady && (
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" disabled={busy || publishing.working !== null} onClick={() => void publishing.act("deploy")}>
                  {publishing.working === "deploy" ? "Starting…" : "Try again"}
                </Button>
                {run?.url && (
                  <a href={run.url} target="_blank" rel="noreferrer" className="text-sm text-zinc-500 hover:underline">
                    What GitHub said ↗
                  </a>
                )}
              </div>
            )}
          </div>
        </Section>
      )}

      {!hasChanges && !canPublish && !deployFailed && !result && (
        <EmptyState
          title="Everything is published"
          action={
            liveUrl ? (
              <a
                href={liveUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                View your site ↗
              </a>
            ) : null
          }
        >
          When you change something, it shows up here until you publish it.
        </EmptyState>
      )}

      {hasChanges && (
        <Section title={`Your changes (${status.changes.length})`}>
          <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {status.changes.map((change) => {
              const { what, status: label } = describeChange(change, overview);
              const diff = files?.find((f) => f.path === change.path)?.diff;
              return (
                <li key={change.path} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{label}</Badge>
                    <span className="min-w-0 flex-1 text-sm font-medium">{what}</span>
                    <Button variant="ghost" className="px-2 py-0.5 text-xs" disabled={disabled} onClick={() => void discard([change.path], `the change to "${what}"`)}>
                      Undo
                    </Button>
                  </div>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-zinc-500">Technical details</summary>
                    <p className="mt-1 font-mono text-xs text-zinc-500">{change.path}</p>
                    {diff && (
                      <pre className="mt-1 max-h-96 overflow-auto rounded border border-zinc-200 py-2 font-mono text-xs dark:border-zinc-800">
                        {diff.split("\n").map((line, i) => (
                          <div key={i} className={`px-3 ${lineClass(line)}`}>
                            {line || " "}
                          </div>
                        ))}
                      </pre>
                    )}
                  </details>
                </li>
              );
            })}
          </ul>
          {status.changes.length > 1 && (
            <div className="mt-3">
              <Button
                variant="danger"
                disabled={disabled}
                onClick={() => void discard(status.changes.map((c) => c.path), `all ${status.changes.length} changes`)}
              >
                {working === "discard" ? "Undoing…" : "Undo all changes"}
              </Button>
            </div>
          )}
        </Section>
      )}

      {canPublish && (
        <Section title={goesLive ? "Put your changes live" : "Send your changes"}>
          {!hasChanges && Boolean(status.ahead) && (
            <div className="mb-3">
              <Notice tone="warning">Your last publish didn&apos;t reach GitHub. Publish again to finish it.</Notice>
            </div>
          )}
          {deployFailed && !result && (
            <div className="mb-3">
              <Notice tone="warning">Your last publish didn&apos;t go live. Fix anything listed below, then publish again.</Notice>
            </div>
          )}
          <div className="mb-4">
            <SiteProblems />
          </div>
          {checkingDetails ? (
            <SiteDetailsStep onDone={detailsDone} onCancel={() => setCheckingDetails(false)} />
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="primary" className="px-5 py-2" disabled={disabled}>
                  {working === "commit" ? "Publishing…" : goesLive ? "Publish now" : status.onDefaultBranch ? "Send for review" : "Add to the review"}
                </Button>
                <span className="text-sm text-zinc-500">
                  {goesLive
                    ? "Your live site updates about a minute later."
                    : "Nothing changes on your live site until the review is approved on GitHub."}
                </span>
              </div>

              <Details summary="More options">
                <div className="space-y-3">
                  <Field label="A note about this version (optional)" hint="Kept in your site's history. Made from your changes if you leave it empty.">
                    <input
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      maxLength={5000}
                      placeholder={summarizeChanges(status.changes, overview) || "Update the site"}
                      className={inputClass}
                      disabled={disabled}
                    />
                  </Field>
                  <fieldset className="space-y-1.5 text-sm">
                    <legend className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">How to publish</legend>
                    <label className="flex items-start gap-2">
                      <input type="radio" checked={mode === "direct"} onChange={() => setMode("direct")} disabled={disabled} className="mt-1" />
                      <span>
                        {status.onDefaultBranch ? (
                          "Publish straight away (recommended)"
                        ) : (
                          <>
                            Save straight to <code className="font-mono">{status.branch}</code>
                          </>
                        )}
                      </span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input type="radio" checked={mode === "pr"} onChange={() => setMode("pr")} disabled={disabled} className="mt-1" />
                      <span>
                        {status.onDefaultBranch
                          ? "Send for review first: someone approves it on GitHub before it goes live"
                          : "Add to the review that's already open"}
                      </span>
                    </label>
                  </fieldset>
                  {mode === "pr" && status.onDefaultBranch && (
                    <Field label="Review name (optional)" hint="Defaults to twinstack/<date>-<time>.">
                      <input value={branch} onChange={(e) => setBranch(e.target.value)} className={`${inputClass} font-mono`} disabled={disabled} />
                    </Field>
                  )}
                </div>
              </Details>
            </form>
          )}
        </Section>
      )}

      {publishing.publishing?.enabled && publishing.publishing.canConfigure && (
        <Section title="Your web address" description="Your site is on a free github.io address. You can use your own domain name instead.">
          <DomainSettings publishing={publishing.publishing} onChange={(next) => {
            publishing.setPublishing(next);
            // A domain change starts a redeploy: watch it closely.
            publishing.watch();
          }} />
        </Section>
      )}
    </div>
  );
}
