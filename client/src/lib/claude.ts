// Whether the signed-in user can run Claude commands, and where to go when they can't.
// Every panel asks this one place, so a later way to pay for Claude (credits on the
// app's own account) only changes how `claudeAccess` is worked out.

export type ClaudeAccess = {
  /** Claude commands can run. */
  ready: boolean;
  /** Shown when they can't, e.g. on a disabled Claude button. */
  reason: string;
  /** Where the user sets Claude up. */
  setupHref: string;
  setupLabel: string;
  /** What one Claude run costs the user, beside the buttons that start one. */
  costNote: string;
};

export const CLAUDE_SETUP_HREF = "/settings#claude";

export function claudeAccess({ anthropicKey }: { anthropicKey: string | null }): ClaudeAccess {
  const costNote = "Each try is one Claude request, billed to your Anthropic account.";
  return anthropicKey
    ? { ready: true, reason: "", setupHref: CLAUDE_SETUP_HREF, setupLabel: "Claude settings", costNote }
    : {
        ready: false,
        reason: "Set up Claude in Settings to let it write and change pages for you.",
        setupHref: CLAUDE_SETUP_HREF,
        setupLabel: "Set up Claude",
        costNote,
      };
}
