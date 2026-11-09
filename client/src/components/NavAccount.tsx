import Link from "next/link";
import { CreditBadge } from "./CreditBadge";

type AccountUser = { name: string; email: string; github?: { avatarUrl: string } | null };

/** Credits, who's signed in and Sign out: in the top navbar, and in the site editor's own header. */
export function NavAccount({ user, compact = false }: { user: AccountUser; compact?: boolean }) {
  return (
    <>
      <CreditBadge />
      <Link href="/settings" title={`${user.email}: settings`} className="flex items-center gap-2 text-sm text-zinc-600 hover:text-foreground dark:text-zinc-400">
        {user.github ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.github.avatarUrl} alt="" width={24} height={24} className="size-6 rounded-full" />
        ) : (
          <span aria-hidden="true" className="grid size-6 place-items-center rounded-full bg-zinc-200 text-xs font-medium dark:bg-zinc-800">
            {user.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className={compact ? "hidden 2xl:inline" : "hidden md:inline"}>{user.name}</span>
      </Link>
      <form action="/auth/logout" method="post">
        <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
          Sign out
        </button>
      </form>
    </>
  );
}
