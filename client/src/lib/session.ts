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

/**
 * Resolves the current user by asking the Express API to verify the session cookie.
 * Cached per request, so the navbar and the page share one API call.
 */
export const getUser = cache(async (): Promise<User | null> => {
  const session = (await cookies()).get(SESSION_COOKIE);
  if (!session) return null;

  try {
    const res = await fetch(`${apiUrl}/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${session.value}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { user: User };
    return data.user;
  } catch {
    return null;
  }
});
