import Link from "next/link";
import { GitHubIcon } from "@/components/GitHubIcon";
import { getUser } from "@/lib/session";

const errorMessages: Record<string, string> = {
  access_denied: "You cancelled the GitHub sign-in.",
  invalid_state: "Your sign-in session expired. Please try again.",
};

export default async function Home({ searchParams }: PageProps<"/">) {
  const [user, { error }] = await Promise.all([getUser(), searchParams]);
  const errorCode = typeof error === "string" ? error : undefined;

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Twinstack</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Next.js + Express, authenticated with GitHub.
        </p>

        {errorCode && (
          <p role="alert" className="mt-6 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {errorMessages[errorCode] ?? "Sign-in failed. Please try again."}
          </p>
        )}

        <div className="mt-8">
          {user ? (
            <Link
              href="/dashboard"
              className="inline-flex w-full items-center justify-center rounded-md bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:opacity-90"
            >
              Continue as {user.login}
            </Link>
          ) : (
            // Plain <a>: this is a full-page navigation to the Express OAuth route.
            <a
              href="/auth/github"
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-foreground px-4 py-2.5 text-sm font-medium text-background hover:opacity-90"
            >
              <GitHubIcon className="size-4" />
              Sign in with GitHub
            </a>
          )}
        </div>
      </div>
    </main>
  );
}
