"use client";

import { useEffect, useState } from "react";
import { api, workspacePath, type FileDiff, type WorkspaceStatus } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Badge, Button, ErrorText, Field, Notice, Section, inputClass } from "./ui";

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

export function ChangesPanel() {
  const { owner, repo, status, busy, setStatus, refresh, version } = useSite();
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState<"discard" | "commit" | null>(null);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"pr" | "direct">("pr");
  const [branch, setBranch] = useState("");
  const [result, setResult] = useState<CommitResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ files: FileDiff[] }>(workspacePath(owner, repo, "/diff"))
      .then(({ files: next }) => {
        if (cancelled) return;
        setFiles(next);
        setSelected((prev) => new Set([...prev].filter((p) => next.some((f) => f.path === p))));
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function discard() {
    if (!confirm(`Discard changes to ${selected.size} file${selected.size === 1 ? "" : "s"}? This can't be undone.`)) return;
    setWorking("discard");
    setError(null);
    try {
      setStatus(await api<WorkspaceStatus>(workspacePath(owner, repo, "/discard"), { method: "POST", body: { paths: [...selected] } }));
      setSelected(new Set());
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setWorking(null);
    }
  }

  async function commit(e: React.FormEvent) {
    e.preventDefault();
    setWorking("commit");
    setError(null);
    setResult(null);
    try {
      const body = { message, mode, ...(mode === "pr" && status.onDefaultBranch && branch.trim() && { branch: branch.trim() }) };
      const committed = await api<CommitResult>(workspacePath(owner, repo, "/commit"), { method: "POST", body });
      setResult(committed);
      setStatus(committed.status);
      setMessage("");
      setBranch("");
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

  return (
    <>
      <Section title="Changed files" description="Everything commands and edits have changed in this workspace since the last commit.">
        <ErrorText error={error} />
        {!files && !error && <p className="text-sm text-zinc-500">Loading…</p>}
        {files?.length === 0 && <p className="text-sm text-zinc-500">No changes.</p>}
        {files && files.length > 0 && (
          <>
            <ul className="space-y-2">
              {files.map((file) => (
                <li key={file.path} className="rounded-md border border-zinc-200 dark:border-zinc-800">
                  <details>
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(file.path)}
                        onChange={() => toggle(file.path)}
                        onClick={(e) => e.stopPropagation()}
                        disabled={disabled}
                        aria-label={`Select ${file.path}`}
                      />
                      <span className="font-mono text-xs">{file.path}</span>
                      <Badge>{file.status}</Badge>
                      <span className="ml-auto text-xs text-zinc-500">Show diff</span>
                    </summary>
                    <pre className="max-h-96 overflow-auto border-t border-zinc-200 py-2 font-mono text-xs dark:border-zinc-800">
                      {file.diff.split("\n").map((line, i) => (
                        <div key={i} className={`px-3 ${lineClass(line)}`}>
                          {line || " "}
                        </div>
                      ))}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <Button variant="ghost" disabled={disabled} onClick={() => setSelected(new Set(files.map((f) => f.path)))}>
                Select all
              </Button>
              <Button variant="danger" disabled={disabled || selected.size === 0} onClick={discard}>
                {working === "discard" ? "Discarding…" : `Discard selected (${selected.size})`}
              </Button>
            </div>
          </>
        )}
      </Section>

      <Section title="Publish" description="Commits every change above and pushes it to GitHub.">
        {result && (
          <div className="mb-4">
            <Notice tone="success">
              Pushed <code className="font-mono">{result.commit.slice(0, 7)}</code> to{" "}
              <code className="font-mono">{result.branch}</code>.{" "}
              {result.pullRequest && (
                <a href={result.pullRequest.url} target="_blank" rel="noreferrer" className="font-medium underline">
                  Pull request #{result.pullRequest.number} ↗
                </a>
              )}
            </Notice>
          </div>
        )}
        <form onSubmit={commit} className="space-y-3">
          <Field label="Commit message">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required={hasChanges}
              maxLength={5000}
              placeholder="Add the partners page"
              className={inputClass}
              disabled={disabled}
            />
          </Field>
          <fieldset className="space-y-1.5 text-sm">
            <label className="flex items-start gap-2">
              <input type="radio" checked={mode === "pr"} onChange={() => setMode("pr")} disabled={disabled} className="mt-1" />
              <span>
                {status.onDefaultBranch ? (
                  <>New branch and pull request into {status.defaultBranch} (recommended)</>
                ) : (
                  <>
                    Commit to <code className="font-mono">{status.branch}</code> and update its pull request
                  </>
                )}
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" checked={mode === "direct"} onChange={() => setMode("direct")} disabled={disabled} className="mt-1" />
              <span>
                Push directly to <code className="font-mono">{status.branch}</code>
              </span>
            </label>
          </fieldset>
          {mode === "pr" && status.onDefaultBranch && (
            <Field label="Branch name (optional)" hint="Defaults to twinstack/<date>-<time>.">
              <input value={branch} onChange={(e) => setBranch(e.target.value)} className={`${inputClass} font-mono`} disabled={disabled} />
            </Field>
          )}
          {mode === "direct" && status.onDefaultBranch && (
            <Notice tone="warning">
              This skips review. If your deploy workflow builds from {status.defaultBranch}, the live site changes straight away.
            </Notice>
          )}
          <Button type="submit" variant="primary" disabled={disabled || !canPublish || (hasChanges && !message.trim())}>
            {working === "commit" ? "Publishing…" : hasChanges ? "Commit and push" : "Push"}
          </Button>
        </form>
      </Section>
    </>
  );
}
