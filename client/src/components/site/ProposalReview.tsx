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
/** What an extra file in a proposal is, for its heading in the review. */
function extraFileRole(file: string) {
  if (file.startsWith("content/data/")) return "data the page shows, which other pages may show too";
  if (file.startsWith("assets/js/imported/")) return "one of the page's own scripts";
  if (file.startsWith("styles/global/")) return "a global stylesheet from the site tree, replaced by your upload";
  return "the old page's CSS, scoped to this page";
}

export function ProposalReview() {
  const { owner, repo, busy, version, job, overview, run, setStatus, refresh } = useSite();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [draft, setDraft] = useState("");
  // The text the page preview was last built from, to say when the draft has moved on since.
  const [previewedDraft, setPreviewedDraft] = useState<string | null>(null);
  const loadedAt = useRef<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [applied, setApplied] = useState<{ file: string; files: string[]; page: boolean } | null>(null);

  // After every command re-read the proposal. The text is only replaced when a new proposal arrives.
  useEffect(() => {
    let cancelled = false;
    api<{ proposal: Proposal | null }>(workspacePath(owner, repo, "/proposal"))
      .then(({ proposal: found }) => {
        if (cancelled) return;
        // The SEO tab shows its own suggestions.
        const next = found?.mode === "seo" ? null : found;
        setProposal(next);
        const stamp = next ? `${next.file}@${next.createdAt}` : null;
        if (stamp !== loadedAt.current) {
          loadedAt.current = stamp;
          setDraft(next?.content ?? "");
          setPreviewedDraft(null);
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

  // The page itself, built with this proposal applied (the edited text, if edited), shown under the diff.
  const canPreview = Boolean(overview?.features.proposalPreview);
  const pageProposal = Boolean(proposal) && proposal?.mode !== "markdown";
  const previewJob = job?.command === "proposal-preview" ? job : null;
  const building = previewJob?.status === "running";

  async function previewPage() {
    if (!proposal) return;
    setError(null);
    // Only edited text is sent: Claude's own version is already on the server.
    if (await run("proposal-preview", draft !== proposal.content ? { content: draft } : {})) setPreviewedDraft(draft);
  }

  // Build it as soon as a new proposal arrives, once per proposal: a failed build isn't retried by itself.
  const autoBuilt = useRef<string | null>(null);
  useEffect(() => {
    if (!proposal || proposal.mode === "markdown" || !canPreview || proposal.preview || busy) return;
    const stamp = `${proposal.file}@${proposal.createdAt}`;
    if (autoBuilt.current === stamp) return;
    autoBuilt.current = stamp;
    void run("proposal-preview", {}).then((started) => started && setPreviewedDraft(proposal.content));
  }, [proposal, canPreview, busy, run]);

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
              <details
                key={extra.file}
                open={extra.file.startsWith("content/data/")}
                className="rounded-md border border-zinc-200 p-2 text-sm dark:border-zinc-800"
              >
                <summary className="cursor-pointer">
                  Also writes <code className="font-mono">{extra.file}</code> ({Math.ceil(extra.content.length / 1024)} KB):{" "}
                  {extraFileRole(extra.file)}
                </summary>
                {extra.file.startsWith("content/data/") && extra.original != null ? (
                  <div className="mt-2">
                    <LiveDiff before={extra.original} after={extra.content} label={`Changes to ${extra.file}`} />
                  </div>
                ) : (
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{extra.content}</pre>
                )}
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
            {pageProposal && (
              <PagePreview
              proposal={proposal}
              supported={canPreview}
              building={building}
              failedOutput={previewJob?.status === "failed" ? previewJob.output : null}
              outdated={previewedDraft !== null && draft !== previewedDraft}
              disabled={applying || busy || !draft.trim()}
              onBuild={previewPage}
              />
            )}
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

/**
 * The proposed page as the site would build it, under the diff. Sites whose scripts/build.js
 * predates --proposal get an explanation and the template's build files instead.
 */
function PagePreview({
  proposal,
  supported,
  building,
  failedOutput,
  outdated,
  disabled,
  onBuild,
}: {
  proposal: Proposal;
  supported: boolean;
  building: boolean;
  failedOutput: string | null;
  outdated: boolean;
  disabled: boolean;
  onBuild: () => void;
}) {
  const { owner, repo, busy, setStatus, refresh } = useSite();
  const [width, setWidth] = useState<"desktop" | "phone">("desktop");
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const preview = proposal.preview ?? null;

  async function updateBuildFiles() {
    setUpdating(true);
    setError(null);
    try {
      const result = await api<{ status: WorkspaceStatus }>(workspacePath(owner, repo, "/install/publishing"), { method: "POST", body: {} });
      setStatus(result.status);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium">The page with this change</h4>
        {preview && (
          <span className="text-xs text-zinc-500">
            {preview.edited ? "built from your edited text" : "built from Claude's version"}, not saved
          </span>
        )}
        {supported && (
          <span className="ml-auto flex items-center gap-1">
            {(["desktop", "phone"] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWidth(w)}
                aria-pressed={width === w}
                className={`rounded px-2.5 py-1 text-xs font-medium ${width === w ? "bg-foreground text-background" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
              >
                {w === "desktop" ? "Desktop" : "Phone"}
              </button>
            ))}
            {preview && (
              <a href={preview.url} target="_blank" rel="noreferrer" className="ml-2 text-sm text-zinc-500 hover:underline">
                Open in a new tab ↗
              </a>
            )}
          </span>
        )}
      </div>

      {!supported ? (
        <Notice>
          This site&apos;s build script is older than page previews, so only the text changes are shown above. Update its build files
          from the template (<code className="font-mono">scripts/build.js</code>, <code className="font-mono">check.js</code>,{" "}
          <code className="font-mono">lib/content.js</code>, <code className="font-mono">lib/seo.js</code> and the deploy workflow,
          as uncommitted changes you review on the Changes tab), then preview the change again.{" "}
          <Button variant="ghost" className="underline" disabled={busy || updating} onClick={updateBuildFiles}>
            {updating ? "Updating…" : "Update the build files"}
          </Button>
          <ErrorText error={error} />
        </Notice>
      ) : (
        <>
          {failedOutput !== null && !building && (
            <Notice tone="warning">
              The page couldn&apos;t be built:
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
                {failedOutput.trim().split("\n").slice(-12).join("\n")}
              </pre>
            </Notice>
          )}
          {(outdated || (!preview && !building)) && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-zinc-500">
                {outdated ? "You've edited the text since this was built." : "Not built yet."}
              </span>
              <Button disabled={disabled} onClick={onBuild}>
                {outdated ? "Update the preview" : "Build the page"}
              </Button>
            </div>
          )}
          {building && <p className="text-sm text-zinc-500">Building the page with this change…</p>}
          {preview && (
            // Sandboxed without allow-same-origin, like the Build tab's preview.
            <iframe
              key={preview.builtAt}
              src={preview.url}
              title={`Preview of ${proposal.file} with the change`}
              sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
              className={`mx-auto block h-[40rem] rounded-md border border-zinc-200 bg-white dark:border-zinc-800 ${building ? "opacity-50" : ""} ${width === "phone" ? "w-[390px] max-w-full" : "w-full"}`}
            />
          )}
        </>
      )}
    </div>
  );
}
