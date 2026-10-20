import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";

export type GithubAccount = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string;
  profileUrl: string;
};

/** Whether the account may create sites: it asks once, and an admin approves or denies it. */
export type Access = {
  status: "none" | "pending" | "approved" | "denied";
  requestedAt: string | null;
};

/** An email + password account; GitHub is connected to it separately. */
export type User = {
  id: string;
  email: string;
  name: string;
  /** Reviews access requests on /admin/access (ADMIN_EMAILS on the server). */
  admin: boolean;
  access: Access;
  github: GithubAccount | null;
};

const apiUrl = process.env.API_URL ?? "http://localhost:4000";

export const SESSION_COOKIE = "session";

/** The API couldn't say who's signed in (it's restarting, or its database is unreachable): not the same as signed out. */
export class SessionUnavailableError extends Error {
  constructor() {
    super("Twinstack's server isn't answering right now, so your account couldn't be loaded.");
    this.name = "SessionUnavailableError";
  }
}

// Waits before each retry: a restarting API is usually back within a couple of seconds.
const RETRY_DELAYS_MS = [400, 1200];

/**
 * Resolves the current user by asking the Express API to verify the session cookie.
 * Cached per request, so the navbar and the page share one API call.
 *
 * Null only when the API says the session isn't valid (401/403). A failure to reach it, or an
 * error from it, is retried and then thrown as SessionUnavailableError, so a brief outage shows the
 * error page (app/error.tsx, with "Try again") instead of sending a signed-in owner to log in.
 */
export const getUser = cache(async (): Promise<User | null> => {
  const session = (await cookies()).get(SESSION_COOKIE);
  if (!session) return null;

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${apiUrl}/api/me`, {
        headers: { cookie: `${SESSION_COOKIE}=${session.value}` },
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) return null;
      if (res.ok) return ((await res.json()) as { user: User }).user;
    } catch {
      // Not reachable: try again, below.
    }
    if (attempt >= RETRY_DELAYS_MS.length) throw new SessionUnavailableError();
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
});
