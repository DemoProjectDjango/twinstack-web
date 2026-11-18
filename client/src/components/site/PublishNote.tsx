"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Field, inputClass } from "./ui";

const MAX_NOTE = 2000;

/**
 * The top bar's Publish: one optional note, added to this version's description in the site's
 * history (publishMessage in site-hooks.ts), so whoever looks later knows who changed what and why.
 */
export function PublishNote({ changes, onPublish, onCancel }: { changes: number; onPublish: (note: string) => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="publish-note-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-zinc-200 bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50 dark:border-zinc-800"
    >
      <form
        className="space-y-4 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          onPublish(note);
        }}
      >
        <div>
          <h2 id="publish-note-title" className="text-lg font-semibold">
            Publish your changes
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {changes > 0 ? `${changes} ${changes === 1 ? "change goes" : "changes go"} live. ` : ""}
            If someone else published in the meantime, their work is combined with yours first.
          </p>
        </div>
        <Field label="Note (optional)" hint="Added to the description of this version in your site's history: who made the change, or why.">
          <textarea
            autoFocus
            value={note}
            maxLength={MAX_NOTE}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter publishes; Enter alone makes a new line.
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                onPublish(note);
              }
            }}
            rows={3}
            placeholder="e.g. Added the summer opening hours (Sam)"
            className={inputClass}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary">
            Publish
          </Button>
        </div>
      </form>
    </dialog>
  );
}
