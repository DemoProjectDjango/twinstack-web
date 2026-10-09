"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { refreshCredits } from "@/lib/credits";
import { api } from "@/lib/site-api";

type ClaudeModel = { id: string; name: string; description: string };
type Settings = { ownKeys?: boolean; anthropicKey: string | null; model?: string; models?: ClaudeModel[] };

/**
 * The model Claude uses, and (only while the server allows own keys, `ownKeys`) the user's own
 * Anthropic API key, stored encrypted on the server (the browser only sees a masked hint).
 */
export function AnthropicKey() {
  const [ownKeys, setOwnKeys] = useState(false);
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [models, setModels] = useState<ClaudeModel[]>([]);

  useEffect(() => {
    api<Settings>("/api/settings")
      .then((s) => {
        setSaved(s.anthropicKey);
        // Servers from before credits always took a key.
        setOwnKeys(s.ownKeys ?? true);
        setModel(s.model ?? null);
        setModels(s.models ?? []);
      })
      .catch(() => setSaved(null));
  }, []);

  async function update(method: "PUT" | "DELETE") {
    setWorking(true);
    setError(null);
    try {
      const s = await api<Settings>("/api/settings/anthropic-key", { method, body: method === "PUT" ? { key } : undefined });
      setSaved(s.anthropicKey);
      setKey("");
      // Claude now runs on (or off) the account's own key.
      void refreshCredits();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the key.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <section id="claude" className="mt-6 scroll-mt-20 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      {ownKeys ? (
        <>
          <h2 className="text-lg font-semibold">
            Your own Anthropic key <span className="text-sm font-normal text-zinc-500">(optional)</span>
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            Claude runs on your{" "}
            <Link href="/credits" className="underline">
              Claude credits
            </Link>
            . If you&apos;d rather pay Anthropic directly, add your own API key: Claude then uses it, and no credits are taken.
          </p>
          {saved === null && (
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
              <li>
                Sign in at{" "}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="underline">
                  console.anthropic.com
                </a>{" "}
                (or create an account) and add some credit.
              </li>
              <li>Create an API key and copy it.</li>
              <li>Paste it below and save.</li>
            </ol>
          )}
          <p className="mt-3 text-xs text-zinc-500">
            With your own key, Claude&apos;s use is billed to your Anthropic account. The key is checked with Anthropic, then stored
            encrypted for your account, so it works on any device you sign in from. Only a masked version is ever shown again. Remove
            it any time to go back to credits.
          </p>

          {saved === undefined ? (
            <p className="mt-4 text-sm text-zinc-500">Loading…</p>
          ) : saved ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="text-sm text-green-700 dark:text-green-400">✓ Claude uses your own key</span>
              <code className="rounded bg-zinc-100 px-2 py-1 font-mono text-sm dark:bg-zinc-900">{saved}</code>
              <button
                type="button"
                onClick={() => update("DELETE")}
                disabled={working}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Remove
              </button>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void update("PUT");
              }}
              className="mt-4 flex flex-wrap gap-2"
            >
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="sk-ant-…"
                autoComplete="off"
                aria-label="Anthropic API key"
                required
                disabled={working}
                className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-2 font-mono text-sm dark:border-zinc-700"
              />
              <button
                type="submit"
                disabled={working || !key.trim()}
                className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60"
              >
                {working ? "Checking…" : "Save key"}
              </button>
            </form>
          )}
          {error && (
            <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

        </>
      ) : (
        <>
          <h2 className="text-lg font-semibold">Claude</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Claude writes and changes your pages, and answers in Ask Claude. Each request uses your{" "}
            <Link href="/credits" className="underline">
              Claude credits
            </Link>
            .
          </p>
        </>
      )}

      {model && models.length > 0 && <ModelPicker model={model} models={models} onSaved={setModel} />}
    </section>
  );
}

/** Which Claude model writes pages and answers in Ask Claude. Saved as soon as one is picked. */
function ModelPicker({ model, models, onSaved }: { model: string; models: ClaudeModel[]; onSaved: (model: string) => void }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  async function choose(id: string) {
    if (id === model) return;
    setWorking(true);
    setError(null);
    setSavedNote(false);
    try {
      const s = await api<{ model: string }>("/api/settings/model", { method: "PUT", body: { model: id } });
      onSaved(s.model);
      setSavedNote(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your choice.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <fieldset className="mt-6 border-t border-zinc-200 pt-5 dark:border-zinc-800" disabled={working}>
      <legend className="sr-only">Claude model</legend>
      <h3 className="font-medium">Which Claude to use</h3>
      <p className="mt-1 text-sm text-zinc-500">
        Used when Claude writes or changes your pages and when you ask Claude. More capable models use more credits.
      </p>
      <div className="mt-3 grid gap-2">
        {models.map((m) => (
          <label
            key={m.id}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-zinc-200 p-3 has-checked:border-zinc-900 dark:border-zinc-800 dark:has-checked:border-zinc-100"
          >
            <input
              type="radio"
              name="claude-model"
              value={m.id}
              checked={m.id === model}
              onChange={() => void choose(m.id)}
              className="mt-1"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{m.name}</span>
              <span className="block text-sm text-zinc-500">{m.description}</span>
            </span>
          </label>
        ))}
      </div>
      <p aria-live="polite" className="mt-2 min-h-5 text-sm">
        {working ? (
          <span className="text-zinc-500">Saving…</span>
        ) : error ? (
          <span role="alert" className="text-red-600 dark:text-red-400">
            {error}
          </span>
        ) : savedNote ? (
          <span className="text-green-700 dark:text-green-400">✓ Saved. Claude uses it from the next request.</span>
        ) : null}
      </p>
    </fieldset>
  );
}
