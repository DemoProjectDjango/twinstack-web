import Link from "next/link";
import { getUser } from "@/lib/session";
import { NavAccount } from "./NavAccount";
import { NavLinks } from "./NavLinks";

export async function Navbar() {
  // While the server isn't answering, the page below shows why; the navbar just leaves the account out.
  const user = await getUser().catch(() => null);

  return (
    <header className="sticky top-0 z-100 border-b border-zinc-200 bg-background/90 backdrop-blur dark:border-zinc-800">
      <nav aria-label="Main" className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4">
        <Link href={user ? "/dashboard" : "/"} className="flex items-center gap-2 font-semibold tracking-tight">
          <span aria-hidden="true" className="grid size-7 place-items-center rounded-md bg-foreground text-xs text-background">
            TS
          </span>
          Twinstack
        </Link>

        <div className="hidden sm:block">
          <NavLinks signedIn={Boolean(user)} admin={user?.admin} />
        </div>

        <div className="ml-auto flex items-center gap-3">
          {user ? (
            <NavAccount user={user} />
          ) : (
            <>
              <Link href="/login" className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:text-foreground dark:text-zinc-400">
                Log in
              </Link>
              <Link
                href="/register"
                className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
              >
                Sign up
              </Link>
            </>
          )}
        </div>
      </nav>

      {/* Small screens: the links get their own row. */}
      <div className="border-t border-zinc-200 px-2 py-1 sm:hidden dark:border-zinc-800">
        <NavLinks signedIn={Boolean(user)} admin={user?.admin} />
      </div>
    </header>
  );
}
