import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Optimistic check only: the cookie's signature is verified by the API when the
// page loads the user. This just avoids rendering protected pages for guests.
export function proxy(request: NextRequest) {
  if (!request.cookies.has("session")) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/sites/:path*"],
};
