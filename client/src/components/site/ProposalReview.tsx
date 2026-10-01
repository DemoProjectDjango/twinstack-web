"use client";

import { useEffect, useRef, useState } from "react";
import { api, workspacePath, type Proposal, type WorkspaceStatus } from "@/lib/site-api";
import { LiveDiff } from "./LiveDiff";
import { useSite } from "./site-context";
import { Button, ErrorText, Notice, Section, inputClass } from "./ui";

/** Claude commands whose preview this shows. */
export const CLAUDE_PAGE_COMMANDS = ["page-edit", "page-generate", "page-convert", "md-edit"];

/**
 * The pending preview from either kind of Claude page run: the complete
 * proposed file, which the user can adjust and then apply without calling
 * Claude again.
 */
export function ProposalReview() {
  const { owner, repo, busy, version, job, setStatus, refresh } = useSite();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [draft, setDraft] = useState("");
  const loadedAt = useRef<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [applied, setApplied] = useState<{ file: string; files: string[]; page: boolean } | null>(null);

  // After every command re-read the proposal. The text is only replaced when a new proposal arrives.
  useEffect(() => {
    let cancelled = false;
    api<{ proposal: Proposal | null }>(workspacePath(owner, repo, "/proposal"))
      .then(({ proposal: next }) => {
        if (cancelled) return;
        setProposal(next);
        const stamp = next ? `${next.file}@${next.createdAt}` : null;
        if (stamp !== loadedAt.current) {
          loadedAt.current = stamp;
          setDraft(next?.content ?? "");
          if (next) setApplied(null);
        }
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  async function apply() {
    if (!proposal) return;
    setApplying(true);
    setError(null);
    try {
      const result = await api<{ file: string; files?: string[]; status: WorkspaceStatus }>(
        workspacePath(owner, repo, "/proposal/apply"),
        { method: "POST", body: { content: draft } },
      );
      setStatus(result.status);
      setApplied({ file: result.file, files: result.files ?? [], page: proposal.mode !== "markdown" });
      setProposal(null);
      loadedAt.current = null;
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setApplying(false);
    }
  }

  async function discard() {
    setError(null);
    try {
      await api(workspacePath(owner, repo, "/proposal"), { method: "DELETE" });
      setProposal(null);
      loadedAt.current = null;
      setDraft("");
    } catch (err) {
      setError(err);
    }
  }

  const claudeJob = job && CLAUDE_PAGE_COMMANDS.includes(job.command) ? job : null;
  const generated = proposal?.mode === "generate";
  const converted = proposal?.mode === "convert";

  return (
    <>
      {applied && (
        <Notice tone="success">
          Saved <code className="font-mono">{applied.file}</code>
          {applied.files.map((f) => (
            <span key={f}>
              {" "}
              and <code className="font-mono">{f}</code>
            </span>
          ))}
          .{" "}
          {applied.page ? "Build a preview to see it, or review it on the Changes tab." : "Review it on the Changes tab."}
        </Notice>
      )}
      {claudeJob?.status === "failed" && !proposal && (
        // The Claude tab has no Output panel, so the end of the run's output is shown here.
        <Notice tone="warning">
          Claude&apos;s run didn&apos;t complete:
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
            {claudeJob.output.trim().split("\n").slice(-15).join("\n")}
          </pre>
        </Notice>
      )}
      {!proposal && error !== null && <ErrorText error={error} />}

      {proposal && (
        <Section
          title={generated ? "Finished page" : converted ? "Converted page" : proposal.mode === "markdown" ? "Proposed file" : "Proposed page"}
          description={
            <>
              {generated
                ? "Claude's finished version of your draft of"
                : converted
                  ? `Claude's conversion of ${proposal.source ?? "the HTML page"} into`
                  : "Claude's complete new version of"}{" "}
              <code className="font-mono">{proposal.file}</code>. Nothing is saved yet. Edit the text if you want, then apply it.
              Applying doesn&apos;t call Claude again.
            </>
          }
        >
          <div className="space-y-3">
            {proposal.instruction && (
              <p className="text-sm">
                <span className="text-zinc-500">{generated || converted ? "Direction:" : "Instruction:"}</span> {proposal.instruction}
              </p>
            )}
            {proposal.images.length > 0 && (
              <p className="break-all text-sm">
                <span className="text-zinc-500">Images:</span> {proposal.images.join(", ")}
              </p>
            )}
            {proposal.files.map((extra) => (
              <details key={extra.file} className="rounded-md border border-zinc-200 p-2 text-sm dark:border-zinc-800">
                <summary className="cursor-pointer">
                  Also writes <code className="font-mono">{extra.file}</code> ({Math.ceil(extra.content.length / 1024)} KB): the old
                  page&apos;s CSS, scoped to this page
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{extra.content}</pre>
              </details>
            ))}
            {proposal.checks?.length > 0 && (
              <div className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                <span className="font-medium">Tested before showing you this:</span>
                <ul className="mt-1 list-disc pl-5 text-zinc-600 dark:text-zinc-400">
                  {proposal.checks.map((check) => (
                    <li key={check}>{check}</li>
                  ))}
                </ul>
              </div>
            )}
            {proposal.summary?.length > 0 && (
              <div className="text-sm">
                <span className="text-zinc-500">Work-log summary, saved with the change when you apply it:</span>
                <ul className="mt-1 list-disc pl-5">
                  {proposal.summary.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            )}
            {proposal.problems.length > 0 && (
              <Notice tone="warning">
                The script wouldn&apos;t write this version itself. Check this before applying:
                <ul className="mt-1 list-disc pl-5">
                  {proposal.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </Notice>
            )}
            {proposal.warnings.length > 0 && (
              <Notice>
                Worth a look:
                <ul className="mt-1 list-disc pl-5">
                  {proposal.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Notice>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={24}
                spellCheck={false}
                aria-label={`Proposed contents of ${proposal.file}`}
                className={`${inputClass} font-mono text-xs leading-relaxed`}
                disabled={applying || busy}
              />
              <LiveDiff before={proposal.original ?? ""} after={draft} label={`Changes to ${proposal.file}`} />
            </div>
            <ErrorText error={error} />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={applying || busy || !draft.trim()} onClick={apply}>
                {applying ? "Applying…" : "Apply this version"}
              </Button>
              <Button disabled={applying || busy} onClick={discard}>
                Discard
              </Button>
              {draft !== proposal.content && (
                <>
                  <span className="text-xs text-zinc-500">Edited by you.</span>
                  <Button variant="ghost" className="text-xs" disabled={applying || busy} onClick={() => setDraft(proposal.content)}>
                    Reset to Claude&apos;s version
                  </Button>
                </>
              )}
            </div>
          </div>
        </Section>
      )}
    </>
  );
}
