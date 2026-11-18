import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// The browser's editor id (server/src/workspace.js: each browser has its own copy of a site). Given
// here, with the page, so every request the editor then makes carries the same one: when the API
// handed them out, a new browser's first requests (sent together) each got a different id, and so a
// different copy, and its work went to one copy while the screen showed another. The API still
// gives one to a request without it, and renews it (routes/helpers.js `editorCookie`).
const EDITOR_COOKIE = "twinstack_editor";
const EDITOR_ID = /^[0-9a-f]{16}$/;
const EDITOR_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

function newEditorId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Optimistic check only: the cookie's signature is verified by the API when the
// page loads the user. This just avoids rendering protected pages for guests.
export function proxy(request: NextRequest) {
  if (!request.cookies.has("session")) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  const response = NextResponse.next();
  if (!EDITOR_ID.test(request.cookies.get(EDITOR_COOKIE)?.value ?? "")) {
    response.cookies.set(EDITOR_COOKIE, newEditorId(), {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: EDITOR_MAX_AGE_SECONDS,
    });
  }
  return response;
}

export const config = {
  matcher: ["/dashboard/:path*", "/sites/:path*", "/settings/:path*", "/credits/:path*", "/admin/:path*"],
};
