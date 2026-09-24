"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { safeNext } from "@/lib/safe-next";

const inputClass =
  "mt-1 w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm disabled:opacity-60 dark:border-zinc-700";

export function AuthForm({ mode, next }: { mode: "login" | "register"; next?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const register = mode === "register";
  const destination = safeNext(next);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(register ? "/auth/register" : "/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(register ? { name, email, password } : { email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Something went wrong. Try again.");
        setWorking(false);
        return;
      }
      // refresh() re-renders server components (the navbar) with the new session.
      router.replace(destination);
      router.refresh();
    } catch {
      setError("Network error. Check your connection and try again.");
      setWorking(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="text-2xl font-semibold tracking-tight">{register ? "Create your account" : "Log in"}</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {register
          ? "You'll connect your GitHub account after this."
          : "Welcome back. Log in to manage your TwinStack site."}
      </p>

      <form onSubmit={submit} className="mt-6 space-y-4">
        {register && (
          <label className="block text-sm font-medium">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              autoComplete="name"
              disabled={working}
              className={inputClass}
            />
          </label>
        )}
        <label className="block text-sm font-medium">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={254}
            autoComplete="email"
            disabled={working}
            className={inputClass}
          />
        </label>
        <label className="block text-sm font-medium">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={register ? 8 : undefined}
            maxLength={200}
            autoComplete={register ? "new-password" : "current-password"}
            disabled={working}
            className={inputClass}
          />
          {register && <span className="mt-1 block text-xs font-normal text-zinc-500">At least 8 characters.</span>}
        </label>

        {error && (
          <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={working}
          className="w-full rounded-md bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60"
        >
          {working ? (register ? "Creating account…" : "Logging in…") : register ? "Create account" : "Log in"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-zinc-500">
        {register ? "Already have an account?" : "New here?"}{" "}
        <Link
          href={`${register ? "/login" : "/register"}${next ? `?next=${encodeURIComponent(destination)}` : ""}`}
          className="font-medium text-foreground underline"
        >
          {register ? "Log in" : "Create an account"}
        </Link>
      </p>
    </div>
  );
}
