"use client";

import { useEffect, useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { toast } from "@/lib/toast";
import { Badge, Button, EmptyState, Notice, Spinner } from "./site/ui";

type Request = {
  id: string;
  email: string;
  name: string;
  githubLogin: string | null;
  status: "pending" | "approved" | "denied";
  message: string;
  requestedAt: string | null;
  decidedAt: string | null;
};

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; requests: Request[] };

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const STATUS_LABELS = { pending: "Waiting", approved: "Approved", denied: "Denied" };

/** The admin's list of access requests (GET /api/admin/access), with Approve and Deny. */
export function AccessRequests() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/access")
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) return setState({ status: "error", message: data.error ?? "The requests couldn't be loaded." });
        setState({ status: "ready", requests: data.requests });
      })
      .catch(() => !cancelled && setState({ status: "error", message: "The requests couldn't be loaded. Refresh to try again." }));
    return () => {
      cancelled = true;
    };
  }, []);

  async function decide(request: Request, status: "approved" | "denied") {
    if (request.status === "approved" && status === "denied") {
      const ok = await confirmModal(
        `${request.email} won't be able to create new sites or update the ones they have. Sites they already made stay in their GitHub account.`,
        { title: "Remove access?", confirmLabel: "Remove access", danger: true },
      );
      if (!ok) return;
    }
    setBusy(request.id);
    try {
      const res = await fetch(`/api/admin/access/${encodeURIComponent(request.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(data.error ?? "That didn't work. Try again.");
      setState({ status: "ready", requests: data.requests });
      const done = status === "approved" ? `${request.email} is approved.` : `${request.email} is denied.`;
      if (data.emailed) toast.success(`${done} They've been emailed.`);
      else toast.warning(`${done} The email couldn't be sent: check RESEND_API_KEY and EMAIL_FROM in the server's log.`);
    } catch {
      toast.error("Network error. Refresh to see whether it was saved.");
    } finally {
      setBusy(null);
    }
  }

  if (state.status === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-zinc-500">
        <Spinner /> Loading requests…
      </p>
    );
  }
  if (state.status === "error") return <Notice tone="warning">{state.message}</Notice>;
  if (!state.requests.length) return <EmptyState title="No requests yet">New requests appear here, and you get an email for each.</EmptyState>;

  return (
    <ul className="space-y-3">
      {state.requests.map((request) => (
        <li
          key={request.id}
          className={`flex flex-wrap items-start gap-3 rounded-lg border p-4 ${
            request.status === "pending" ? "border-foreground" : "border-zinc-200 dark:border-zinc-800"
          }`}
        >
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium">{request.name || request.email}</span>
              <Badge>{STATUS_LABELS[request.status]}</Badge>
            </p>
            <p className="mt-0.5 truncate text-sm text-zinc-500">
              {request.email}
              {request.githubLogin ? (
                <>
                  {" · GitHub "}
                  <a href={`https://github.com/${request.githubLogin}`} target="_blank" rel="noreferrer" className="hover:underline">
                    @{request.githubLogin}
                  </a>
                </>
              ) : (
                " · GitHub not connected yet"
              )}
            </p>
            {request.message && <p className="mt-2 whitespace-pre-line text-sm">{request.message}</p>}
            <p className="mt-1 text-xs text-zinc-500">
              {request.requestedAt && <>Asked {dateFormat.format(new Date(request.requestedAt))}</>}
              {request.requestedAt && request.decidedAt && " · "}
              {request.decidedAt && <>Answered {dateFormat.format(new Date(request.decidedAt))}</>}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {request.status !== "approved" && (
              <Button variant="primary" disabled={busy !== null} onClick={() => void decide(request, "approved")}>
                Approve
              </Button>
            )}
            {request.status === "pending" && (
              <Button disabled={busy !== null} onClick={() => void decide(request, "denied")}>
                Deny
              </Button>
            )}
            {request.status === "approved" && (
              <Button variant="danger" disabled={busy !== null} onClick={() => void decide(request, "denied")}>
                Remove access
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
