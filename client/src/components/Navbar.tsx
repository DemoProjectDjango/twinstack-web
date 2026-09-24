import Link from "next/link";
import { getUser } from "@/lib/session";
import { NavLinks } from "./NavLinks";

export async function Navbar() {
  const user = await getUser();

  return (
    <header className="sticky top-0 z-20 border-b border-zinc-200 bg-background/90 backdrop-blur dark:border-zinc-800">
      <nav aria-label="Main" className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4">
        <Link href={user ? "/dashboard" : "/"} className="flex items-center gap-2 font-semibold tracking-tight">
          <span aria-hidden="true" className="grid size-7 place-items-center rounded-md bg-foreground text-xs text-background">
            TS
          </span>
          Twinstack
        </Link>

        <div className="hidden sm:block">
          <NavLinks signedIn={Boolean(user)} />
        </div>

        <div className="ml-auto flex items-center gap-3">
          {user ? (
            <>
              <Link
                href="/dashboard"
                title={user.email}
                className="flex items-center gap-2 text-sm text-zinc-600 hover:text-foreground dark:text-zinc-400"
              >
                {user.github ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={user.github.avatarUrl} alt="" width={24} height={24} className="size-6 rounded-full" />
                ) : (
                  <span aria-hidden="true" className="grid size-6 place-items-center rounded-full bg-zinc-200 text-xs font-medium dark:bg-zinc-800">
                    {user.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="hidden md:inline">{user.name}</span>
              </Link>
              <form action="/auth/logout" method="post">
                <button
                  type="submit"
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  Sign out
                </button>
              </form>
            </>
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
        <NavLinks signedIn={Boolean(user)} />
      </div>
    </header>
  );
}
