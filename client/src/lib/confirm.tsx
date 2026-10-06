"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

type ConfirmOptions = {
  /** A short heading above the message. */
  title?: string;
  /** The button that goes ahead, e.g. "Remove". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button, for things that can't be undone. */
  danger?: boolean;
};

type Request = ConfirmOptions & { id: number; message: ReactNode; resolve: (answer: boolean) => void };

// Questions waiting to be answered, shown one at a time by <ConfirmHost />.
let queue: Request[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Asks a yes/no question in a modal, in place of the browser's confirm(). Resolves to true only
 * when the confirm button is pressed; Cancel, Escape or a click outside count as no.
 */
export function confirmModal(message: ReactNode, options: ConfirmOptions = {}) {
  return new Promise<boolean>((resolve) => {
    queue = [...queue, { ...options, id: nextId++, message, resolve }];
    emit();
  });
}

function answer(id: number, value: boolean) {
  const request = queue.find((r) => r.id === id);
  if (!request) return;
  queue = queue.filter((r) => r.id !== id);
  emit();
  request.resolve(value);
}

/** Shows the oldest open question. Mounted once, in the root layout. */
export function ConfirmHost() {
  const current = useSyncExternalStore(subscribe, () => queue[0] ?? null, () => null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  // showModal() traps focus, puts the dialog above everything and dims the page behind it.
  // Focus starts on Cancel for anything destructive, so a stray Enter can't do harm.
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (current) {
      if (!el.open) el.showModal();
      (current.danger ? cancelButton : confirmButton).current?.focus();
    } else if (el.open) {
      el.close();
    }
  }, [current]);

  const {
    title = "Are you sure?",
    confirmLabel = "Continue",
    cancelLabel = "Cancel",
    danger = false,
  } = current ?? {};

  return (
    <dialog
      ref={dialog}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
      // Escape fires "cancel": answer no, and let React close it.
      onCancel={(e) => {
        e.preventDefault();
        if (current) answer(current.id, false);
      }}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => {
        if (e.target === e.currentTarget && current) answer(current.id, false);
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-zinc-200 bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50 dark:border-zinc-800"
    >
      {current && (
        <div className="p-6">
          <h2 id="confirm-title" className="text-lg font-semibold">
            {title}
          </h2>
          <p id="confirm-message" className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            {current.message}
          </p>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button
              ref={cancelButton}
              type="button"
              onClick={() => answer(current.id, false)}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {cancelLabel}
            </button>
            <button
              ref={confirmButton}
              type="button"
              onClick={() => answer(current.id, true)}
              className={`rounded-md px-4 py-2 text-sm font-medium ${
                danger ? "bg-red-600 text-white hover:bg-red-700" : "bg-foreground text-background hover:opacity-90"
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
