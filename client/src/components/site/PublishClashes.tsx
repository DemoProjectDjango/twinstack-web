"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { describeChange } from "@/lib/change-labels";
import { ApiError, api, workspacePath, type ClashResolution, type Overview, type PublishClash, type WorkspaceStatus } from "@/lib/site-api";
import { Button, ErrorText, Notice, inputClass } from "./ui";

// Before a publish: files this browser changed that someone else also changed, in the same places,
// in what they published (server/src/publish-sync.js). Nothing moves until the owner has chosen
// what to keep in every one; then both people's work is combined, and publishing can go on.

type Pick = "mine" | "theirs" | "both";
/** How the owner is settling one file. */
type Choice =
  | { by: "parts"; picks: (Pick | null)[] } // text: one pick per clashing place
  | { by: "text"; text: string; fromAi: boolean } // text: the combined text, written or the AI's
  | { by: "whole"; keep: "mine" | "theirs" | null }; // one version or the other

const isClash = (part: { same: string } | { mine: string; theirs: string }): part is { mine: string; theirs: string } => !("same" in part);

function startingChoice(clash: PublishClash): Choice {
  if (clash.kind === "text" && clash.parts) return { by: "parts", picks: clash.parts.filter(isClash).map(() => null) };
  return { by: "whole", keep: null };
}

/** The file as combined from the picks so far (a place not chosen yet keeps the published version). */
function compose(clash: PublishClash, picks: (Pick | null)[]) {
  let n = 0;
  return (clash.parts ?? [])
    .map((part) => {
      if (!isClash(part)) return part.same;
      const pick = picks[n++];
      return pick === "mine" ? part.mine : pick === "both" ? part.theirs + part.mine : part.theirs;
    })
    .join("");
}

function settled(choice: Choice) {
  if (choice.by === "parts") return choice.picks.every((p) => p !== null);
  if (choice.by === "text") return true;
  return choice.keep !== null;
}

function resolutionOf(clash: PublishClash, choice: Choice): ClashResolution {
  if (choice.by === "whole") return { file: clash.file, keep: choice.keep! };
  const text = choice.by === "text" ? choice.text : compose(clash, choice.picks);
  return { file: clash.file, content: text };
}

/** The same clash shown again (after someone published once more): its choice still applies. */
const sameClash = (a: PublishClash, b: PublishClash) => a.kind === b.kind && a.mine === b.mine && a.theirs === b.theirs && JSON.stringify(a.parts) === JSON.stringify(b.parts);

const WHOLE_TEXT: Record<Exclude<PublishClash["kind"], "text">, { says: string; mine: string; theirs: string }> = {
  whole: {
    says: "You and someone else both changed this file. It can't be combined part by part, so keep one of the two versions.",
    mine: "Keep your version",
    theirs: "Keep the published version",
  },
  "removed-there": {
    says: "Someone removed this file in what they published, and you changed it here.",
    mine: "Keep it, with your changes",
    theirs: "Remove it",
  },
  "removed-here": {
    says: "You removed this file, and someone else changed it in what they published.",
    mine: "Remove it",
    theirs: "Keep it, with their changes",
  },
};

/** Long unchanged stretches folded to their first and last lines. */
function SameText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.replace(/\n$/, "").split("\n");
  if (open || lines.length <= 7) return <pre className="whitespace-pre-wrap break-words px-3 py-1 text-xs text-zinc-500">{lines.join("\n")}</pre>;
  return (
    <div className="px-3 py-1 text-xs text-zinc-500">
      <pre className="whitespace-pre-wrap break-words">{lines.slice(0, 3).join("\n")}</pre>
      <button type="button" onClick={() => setOpen(true)} className="my-1 rounded bg-zinc-100 px-2 py-0.5 font-medium hover:bg-zinc-200 dark:bg-zinc-900 dark:hover:bg-zinc-800">
        Show {lines.length - 6} unchanged lines
      </button>
      <pre className="whitespace-pre-wrap break-words">{lines.slice(-3).join("\n")}</pre>
    </div>
  );
}

function Version({ title, text, chosen, tone }: { title: string; text: string; chosen: boolean; tone: "mine" | "theirs" }) {
  const ring = chosen ? (tone === "mine" ? "border-indigo-500 ring-1 ring-indigo-500" : "border-emerald-500 ring-1 ring-emerald-500") : "border-zinc-200 dark:border-zinc-800";
  return (
    <div className={`min-w-0 flex-1 rounded-md border ${ring}`}>
      <p className={`border-b border-inherit px-3 py-1 text-xs font-semibold ${tone === "mine" ? "text-indigo-700 dark:text-indigo-300" : "text-emerald-700 dark:text-emerald-300"}`}>{title}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-xs">{text.replace(/\n$/, "") || <span className="italic text-zinc-400">(nothing)</span>}</pre>
    </div>
  );
}

/** What one place holds with `pick` chosen. */
const picked = (part: { mine: string; theirs: string }, pick: Pick) => (pick === "mine" ? part.mine : pick === "both" ? part.theirs + part.mine : part.theirs);

/** Setting names (`title:`) a page's settings block lists more than once. */
function repeatedSettings(text: string) {
  const names = text
    .split("\n")
    .map((line) => /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
  return [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
}

function ClashParts({ clash, picks, onPick }: { clash: PublishClash; picks: (Pick | null)[]; onPick: (index: number, pick: Pick) => void }) {
  const total = picks.length;
  const parts = clash.parts ?? [];
  // Each clashing place's number among them, for its pick.
  const numbers = parts.map((part, i) => (isClash(part) ? parts.slice(0, i).filter(isClash).length : -1));
  // Whether a place is in the page's settings (between the --- lines at the top), where each
  // setting is one line: both versions of one would make it twice, which the site can't read.
  const inSettings = parts.map((_, i) => {
    const before = parts
      .slice(0, i)
      .map((p) => (isClash(p) ? p.theirs : p.same))
      .join("");
    return /^---\r?\n/.test(before) && before.split("\n").filter((line) => line.trim() === "---").length === 1;
  });
  return (
    <div className="space-y-2 rounded-md border border-zinc-200 py-1 dark:border-zinc-800">
      {parts.map((part, i) => {
        if (!isClash(part)) return <SameText key={i} text={part.same} />;
        const index = numbers[i];
        const pick = picks[index];
        const option = (value: Pick, label: string) => (
          <button
            type="button"
            aria-pressed={pick === value}
            onClick={() => onPick(index, value)}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
              pick === value ? "border-foreground bg-foreground text-background" : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            }`}
          >
            {label}
          </button>
        );
        return (
          <div key={i} className="mx-2 rounded-md bg-amber-50 p-2 dark:bg-amber-950/40">
            <p className="mb-2 text-xs font-semibold text-amber-900 dark:text-amber-200">
              {total > 1 ? `Difference ${index + 1} of ${total}` : "The difference"}
              {pick === null && <span className="ml-2 font-normal">· choose what to keep</span>}
            </p>
            <div className="flex flex-col gap-2 md:flex-row">
              <Version title="Your version" text={part.mine} chosen={pick === "mine" || pick === "both"} tone="mine" />
              <Version title="Published by someone else" text={part.theirs} chosen={pick === "theirs" || pick === "both"} tone="theirs" />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {option("mine", "Keep yours")}
              {option("theirs", "Keep theirs")}
              {/* In the page settings, both only when that wouldn't list a setting twice (two titles). */}
              {inSettings[i] && repeatedSettings(part.theirs + part.mine).length > 0 ? (
                <span className="text-xs text-amber-900 dark:text-amber-200">Page settings: keep one version, or edit the text yourself.</span>
              ) : (
                option("both", "Keep both")
              )}
            </div>
            {pick !== null && <PickResult text={picked(part, pick)} settings={inSettings[i]} />}
          </div>
        );
      })}
    </div>
  );
}

/** What the file will hold at this place with the choice made, before anything is combined. */
function PickResult({ text, settings }: { text: string; settings: boolean }) {
  const repeated = settings ? repeatedSettings(text) : [];
  return (
    <div className="mt-2 rounded-md border border-emerald-500 bg-background">
      <p className="border-b border-emerald-500/40 px-3 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">Result</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-xs">{text.replace(/\n$/, "") || <span className="italic text-zinc-400">(this part is removed)</span>}</pre>
      {repeated.length > 0 && (
        <p className="border-t border-amber-300 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300">
          This lists {repeated.map((name) => `“${name}”`).join(", ")} more than once, and a page can only have one of each. Choose one version, or edit the text and remove the extra line.
        </p>
      )}
    </div>
  );
}

export type PublishClashesProps = {
  owner: string;
  repo: string;
  overview: Overview | null;
  sha: string;
  clashes: PublishClash[];
  subjects: string[];
  /** Asks the server again (someone published once more): new clashes, or none left. */
  onMoved: () => Promise<void>;
  /** Everything combined: the copy's new status. */
  onCombined: (status: WorkspaceStatus) => void;
  /** Publishing goes on (the window's "Publish now"). */
  onPublish: () => void;
  onClose: () => void;
};

export function PublishClashes({ owner, repo, overview, sha, clashes, subjects, onMoved, onCombined, onPublish, onClose }: PublishClashesProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>(() => Object.fromEntries(clashes.map((c) => [c.file, startingChoice(c)])));
  const [current, setCurrent] = useState(clashes[0]?.file ?? "");
  const [working, setWorking] = useState<"combine" | "ai" | "moved" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  // Shown again after someone published once more: choices for clashes that didn't change are kept.
  const previous = useRef(clashes);
  useEffect(() => {
    if (previous.current === clashes) return;
    const before = previous.current;
    previous.current = clashes;
    setChoices((old) =>
      Object.fromEntries(
        clashes.map((c) => {
          const was = before.find((b) => b.file === c.file);
          return [c.file, was && sameClash(was, c) && old[c.file] ? old[c.file] : startingChoice(c)];
        }),
      ),
    );
    setCurrent((file) => (clashes.some((c) => c.file === file) ? file : (clashes[0]?.file ?? "")));
  }, [clashes]);

  const names = useMemo(
    () => Object.fromEntries(clashes.map((c) => [c.file, describeChange({ path: c.file, status: "modified", untracked: false }, overview).what])),
    [clashes, overview],
  );
  const clash = clashes.find((c) => c.file === current) ?? clashes[0];
  const choice = clash ? (choices[clash.file] ?? startingChoice(clash)) : null;
  const whole = clash && clash.kind !== "text" ? WHOLE_TEXT[clash.kind] : null;
  const left = clashes.filter((c) => !settled(choices[c.file] ?? startingChoice(c))).length;

  const setChoice = (file: string, next: Choice) => setChoices((old) => ({ ...old, [file]: next }));
  const nextUnsettled = (after: string) => {
    const order = [...clashes.slice(clashes.findIndex((c) => c.file === after) + 1), ...clashes];
    return order.find((c) => c.file !== after && !settled(choices[c.file] ?? startingChoice(c)))?.file;
  };

  function close() {
    if (working === "combine") return;
    onClose();
  }

  async function combineWithAi() {
    if (!clash) return;
    setWorking("ai");
    setError(null);
    try {
      const { content } = await api<{ content: string }>(workspacePath(owner, repo, "/publish/combine"), { method: "POST", body: { sha, file: clash.file } });
      setChoice(clash.file, { by: "text", text: content, fromAi: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "publish_moved") await moved();
      else setError(err);
    } finally {
      setWorking((w) => (w === "ai" ? null : w));
    }
  }

  async function moved() {
    setWorking("moved");
    setError(null);
    try {
      await onMoved();
    } catch (err) {
      setError(err);
    } finally {
      setWorking(null);
    }
  }

  async function combine() {
    setWorking("combine");
    setError(null);
    try {
      const resolutions = clashes.map((c) => resolutionOf(c, choices[c.file] ?? startingChoice(c)));
      const result = await api<{ status: WorkspaceStatus }>(workspacePath(owner, repo, "/publish/resolve"), { method: "POST", body: { sha, resolutions } });
      onCombined(result.status);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "publish_moved") {
        setWorking(null);
        await moved();
        return;
      }
      setError(err);
    } finally {
      setWorking((w) => (w === "combine" ? null : w));
    }
  }

  const busy = working !== null;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="publish-clashes-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      className={`m-auto w-[calc(100%-2rem)] overflow-hidden rounded-lg border border-zinc-200 bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50 dark:border-zinc-800 ${done ? "max-w-md" : "h-[calc(100dvh-2rem)] max-h-[56rem] max-w-6xl"}`}
    >
      {done ? (
        <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="text-3xl" aria-hidden="true">
            ✓
          </p>
          <h2 id="publish-clashes-title" className="text-lg font-semibold">
            Combined
          </h2>
          <p className="max-w-md text-sm text-zinc-600 dark:text-zinc-400">
            Your changes now sit on top of what was published, with the choices you made. Publish now, or look over your site first and press Publish when you&apos;re ready.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button variant="primary" onClick={onPublish}>
              Publish now
            </Button>
            <Button onClick={onClose}>Look at my site first</Button>
          </div>
        </div>
      ) : (
        <div className="flex h-full flex-col">
          <div className="border-b border-zinc-200 p-4 sm:px-6 dark:border-zinc-800">
            <h2 id="publish-clashes-title" className="text-lg font-semibold">
              Someone else published changes to the same {clashes.length === 1 ? "part" : "parts"} of your site
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {subjects.length > 0 && <>They published: {subjects.slice(0, 3).join("; ")}{subjects.length > 3 ? ` and ${subjects.length - 3} more` : ""}. </>}
              Everything else was combined by itself. For {clashes.length === 1 ? "this file" : `these ${clashes.length} files`}, choose what to keep. Nothing changes until you press Combine.
            </p>
          </div>

          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <nav aria-label="Files to settle" className="shrink-0 overflow-y-auto border-b border-zinc-200 p-2 md:w-64 md:border-r md:border-b-0 dark:border-zinc-800">
              <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
                {clashes.map((c) => {
                  const ok = settled(choices[c.file] ?? startingChoice(c));
                  return (
                    <li key={c.file} className="shrink-0">
                      <button
                        type="button"
                        onClick={() => setCurrent(c.file)}
                        aria-current={c.file === clash?.file ? "true" : undefined}
                        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm ${c.file === clash?.file ? "bg-zinc-100 font-medium dark:bg-zinc-900" : "hover:bg-zinc-50 dark:hover:bg-zinc-900/60"}`}
                      >
                        <span aria-hidden="true" className={`grid size-5 shrink-0 place-items-center rounded-full text-xs ${ok ? "bg-emerald-600 text-white" : "border border-amber-500 text-amber-600"}`}>
                          {ok ? "✓" : "!"}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate">{names[c.file]}</span>
                          <span className="block truncate text-xs font-normal text-zinc-500">{ok ? "Settled" : "Choose what to keep"}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 sm:px-6">
              {clash && choice && (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-semibold">{names[clash.file]}</h3>
                      <p className="truncate text-xs text-zinc-500">{clash.file}</p>
                    </div>
                    {clash.kind === "text" && (
                      <div className="flex flex-wrap gap-2">
                        {choice.by === "parts" ? (
                          <Button onClick={() => setChoice(clash.file, { by: "text", text: compose(clash, choice.picks), fromAi: false })}>Edit the text myself</Button>
                        ) : (
                          <Button onClick={() => setChoice(clash.file, startingChoice(clash))}>Back to choosing</Button>
                        )}
                        <Button disabled={busy} onClick={() => void combineWithAi()}>
                          {working === "ai" ? "The AI is combining…" : "✦ Combine with AI"}
                        </Button>
                      </div>
                    )}
                  </div>

                  {choice.by === "parts" && (
                    <ClashParts
                      clash={clash}
                      picks={choice.picks}
                      onPick={(index, pick) => setChoice(clash.file, { by: "parts", picks: choice.picks.map((p, i) => (i === index ? pick : p)) })}
                    />
                  )}

                  {choice.by === "text" && (
                    <div className="space-y-2">
                      {choice.fromAi && <Notice>The AI&apos;s suggestion, combining both versions. Read it through and change anything that isn&apos;t right.</Notice>}
                      <textarea
                        aria-label={`The combined ${names[clash.file]}`}
                        value={choice.text}
                        onChange={(e) => setChoice(clash.file, { by: "text", text: e.target.value, fromAi: choice.fromAi })}
                        spellCheck={false}
                        className={`${inputClass} h-[45vh] font-mono text-xs`}
                      />
                    </div>
                  )}

                  {choice.by === "whole" && whole && (
                    <div className="space-y-3">
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">{whole.says}</p>
                      {clash.kind !== "whole" && (
                        <div className="flex flex-col gap-2 md:flex-row">
                          <Version title="Your version" text={clash.mine ?? "(removed)"} chosen={choice.keep === "mine"} tone="mine" />
                          <Version title="Published by someone else" text={clash.theirs ?? "(removed)"} chosen={choice.keep === "theirs"} tone="theirs" />
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {(["mine", "theirs"] as const).map((keep) => (
                          <button
                            key={keep}
                            type="button"
                            aria-pressed={choice.keep === keep}
                            onClick={() => setChoice(clash.file, { by: "whole", keep })}
                            className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                              choice.keep === keep ? "border-foreground bg-foreground text-background" : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                            }`}
                          >
                            {whole[keep]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {settled(choice) && left > 0 && (
                    <div className="flex justify-end">
                      <Button onClick={() => setCurrent(nextUnsettled(clash.file) ?? clash.file)}>Next file →</Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="space-y-2 border-t border-zinc-200 p-4 sm:px-6 dark:border-zinc-800">
            <ErrorText error={error} />
            {working === "moved" && <p className="text-sm text-zinc-500">Someone published again just now. Getting the latest…</p>}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-zinc-500" aria-live="polite">
                {left === 0 ? "Everything is settled." : `${clashes.length - left} of ${clashes.length} settled`}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button disabled={working === "combine"} onClick={close}>
                  Not now
                </Button>
                <Button variant="primary" disabled={left > 0 || busy} onClick={() => void combine()}>
                  {working === "combine" ? "Combining…" : "Combine"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}
