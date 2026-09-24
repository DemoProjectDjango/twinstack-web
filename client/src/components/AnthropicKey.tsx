"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/site-api";

type Settings = { anthropicKey: string | null };

/** The user's own Anthropic API key, kept only in their encrypted session cookie. */
export function AnthropicKey() {
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    api<Settings>("/api/settings")
      .then((s) => setSaved(s.anthropicKey))
      .catch(() => setSaved(null));
  }, []);

  async function update(method: "PUT" | "DELETE") {
    setWorking(true);
    setError(null);
    try {
      const s = await api<Settings>("/api/settings/anthropic-key", { method, body: method === "PUT" ? { key } : undefined });
      setSaved(s.anthropicKey);
      setKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the key.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <section id="anthropic-key" className="mt-10 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-lg font-semibold">Anthropic API key</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Used for Claude commands in the site manager and billed to your Anthropic account. It&apos;s checked with Anthropic, then
        stored only in your encrypted session cookie on this browser. Signing out removes it.
      </p>

      {saved === undefined ? (
        <p className="mt-4 text-sm text-zinc-500">Loading…</p>
      ) : saved ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
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
    </section>
  );
}
