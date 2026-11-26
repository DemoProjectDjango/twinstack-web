import Link from "next/link";
import { CreditBadge } from "./CreditBadge";
import { ThemeToggle } from "./ThemeToggle";

type AccountUser = { name: string; email: string; github?: { avatarUrl: string } | null };

/** Credits, who's signed in and Sign out: in the top navbar, and in the site editor's own header. */
export function NavAccount({ user, compact = false }: { user: AccountUser; compact?: boolean }) {
  return (
    <>
      <ThemeToggle />
      <CreditBadge />
      <Link href="/settings" title={`${user.email}: settings`} className="flex items-center gap-2 text-sm text-zinc-600 hover:text-foreground dark:text-zinc-400">
        {user.github ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.github.avatarUrl} alt="" width={24} height={24} className="size-6 shrink-0 rounded-full" />
        ) : (
          <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-zinc-200 text-xs font-medium dark:bg-zinc-800">
            {user.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className={compact ? "hidden 2xl:inline" : "hidden md:inline"}>{user.name}</span>
      </Link>
      <form action="/auth/logout" method="post">
        <button
          type="submit"
          title="Sign out"
          className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm hover:bg-zinc-100 sm:px-3 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {/* On a phone the door icon alone, so the header stays on one line. */}
          <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 sm:hidden" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <path d="m16 17 5-5-5-5" />
            <path d="M21 12H9" />
          </svg>
          <span className="sr-only sm:not-sr-only">Sign out</span>
        </button>
      </form>
    </>
  );
}
