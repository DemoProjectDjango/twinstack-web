/** Only same-site paths, so ?next= can't send someone to another website after login. */
export function safeNext(next: string | undefined) {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/dashboard";
}
