import Link from "next/link";
import type { ReactNode } from "react";
import { GitHubIcon } from "@/components/GitHubIcon";
import { getUser } from "@/lib/session";

const errorMessages: Record<string, string> = {
  access_denied: "You cancelled the GitHub sign-in.",
  invalid_state: "Your sign-in session expired. Please try again.",
};

const STEPS = [
  { id: "get-access", title: "Get access", text: "Sign in with GitHub and add your Anthropic key." },
  { id: "copy", title: "Copy the site", text: "Duplicate twinstack-site into your account." },
  { id: "work", title: "Work on it", text: "Pages, navigation, Claude edits and previews." },
  { id: "publish", title: "Publish", text: "Review the changes and open a pull request." },
];

const TABS = [
  ["Build & preview", "Build the site and check it for broken links, or build a preview that includes drafts.", "npm run check"],
  ["Pages", "Create a page, product, service, blog post or case study, and see every page in the site.", "npm run new"],
  ["Navigation", "Add or remove header links, including menus that list a collection automatically.", "nav:add, nav:remove"],
  ["Edit with Claude", "Change one file from a plain-English instruction, or queue several edits. Preview first.", "page:edit"],
  ["Site tree", "Edit the list of pages the site should have, then create the ones that are missing.", "scaffold"],
  ["Schedule", "Plan pages for a date: Claude writes them from your brief, or a finished file is moved into place.", "scaffold:schedule"],
  ["Changes", "See every changed file, discard what you don't want, and publish the rest.", "git"],
];

const HELP = [
  {
    q: "It says my GitHub access has expired, or asks me to sign in again",
    a: "Click Sign in again. GitHub access can expire, and older sign-ins may lack a permission the app now needs. Your Anthropic key is kept.",
  },
  {
    q: "A repository I expect is missing from the dashboard",
    a: "Check the Private / Public / All filter. For an organisation's repository, the organisation has to allow this app under Settings → Third-party access. You can request that from your GitHub application settings.",
  },
  {
    q: "“Site management isn't enabled for your account”",
    a: "Opening a site runs its build scripts on the server, so only approved GitHub accounts can use the site manager. Ask the administrator to add your GitHub username.",
  },
  {
    q: "“This isn't a TwinStack site repository”",
    a: "The site manager only opens copies of the template that have site.config.json and scripts/build.js on the default branch. Duplicate the template and manage the copy.",
  },
  {
    q: "“The workspace is busy”",
    a: "Only one command runs at a time. Watch the Output panel. You can cancel the running command there.",
  },
  {
    q: "The Claude buttons are disabled",
    a: "Add your Anthropic API key on the dashboard. The previews for scheduled pages work without one.",
  },
  {
    q: "Publishing failed",
    a: "Your commit is kept in the workspace. Fix the cause shown, then press Push on the Changes tab to try again.",
  },
];

export default async function Home({ searchParams }: PageProps<"/">) {
  const [user, { error }] = await Promise.all([getUser(), searchParams]);
  const errorCode = typeof error === "string" ? error : undefined;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-24">
      {/* Hero */}
      <section className="py-16 text-center sm:py-20">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Run the TwinStack site from your browser</h1>
        <p className="mx-auto mt-4 max-w-xl text-zinc-500">
          Copy twinstack-site into your GitHub account, then add pages, edit them with Claude, preview the result and publish it.
          No terminal needed.
        </p>

        {errorCode && (
          <p role="alert" className="mx-auto mt-6 max-w-sm rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {errorMessages[errorCode] ?? "Sign-in failed. Please try again."}
          </p>
        )}

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {user ? (
            <Link
              href="/dashboard"
              className="inline-flex items-center justify-center rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-90"
            >
              Continue as {user.login}
            </Link>
          ) : (
            // Plain <a>: this is a full-page navigation to the Express OAuth route.
            <a
              href="/auth/github"
              className="inline-flex items-center justify-center gap-2 rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-90"
            >
              <GitHubIcon className="size-4" />
              Sign in with GitHub
            </a>
          )}
          <a
            href="#guide"
            className="inline-flex items-center justify-center rounded-md border border-zinc-300 px-5 py-2.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Read the guide
          </a>
        </div>
      </section>

      {/* Step overview */}
      <section id="guide" aria-labelledby="guide-heading">
        <h2 id="guide-heading" className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          How it works
        </h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2">
          {STEPS.map((step, index) => (
            <li key={step.id}>
              <a
                href={`#${step.id}`}
                className="flex h-full gap-3 rounded-lg border border-zinc-200 p-4 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <StepNumber>{index + 1}</StepNumber>
                <span>
                  <span className="block font-medium">{step.title}</span>
                  <span className="block text-sm text-zinc-500">{step.text}</span>
                </span>
              </a>
            </li>
          ))}
        </ol>
      </section>

      <Step id="get-access" number={1} title="Get access">
        <ol className="list-decimal space-y-3 pl-5">
          <li>
            <strong>Sign in with GitHub.</strong> GitHub asks you to approve four permissions: read your profile, read your email
            address, access your repositories (public and private, read and write) and update GitHub Actions workflows. The app
            needs repository access to list, copy and push your repositories. It needs the workflow permission because the site
            includes a deploy workflow, and GitHub refuses pushes that contain workflow files without it.
          </li>
          <li>
            <strong>Check that you can use the site manager.</strong> Opening a site runs its build scripts on the server, so it&apos;s
            limited to approved GitHub accounts. If you see &ldquo;Site management isn&apos;t enabled for your account&rdquo;, ask
            the administrator to add your GitHub username.
          </li>
          <li>
            <strong>Add your Anthropic API key</strong> on the{" "}
            <Link href="/dashboard#anthropic-key" className="underline">
              dashboard
            </Link>{" "}
            if you want to use Claude (Edit with Claude and scheduled pages). The key is checked with Anthropic, then stored
            encrypted on the server for your account. Usage is billed to your Anthropic account, and you can remove the key any
            time. Everything else works without a key.
          </li>
        </ol>
        <Tip>
          Repositories that belong to an organisation only appear if the organisation allows this app, under Settings →
          Third-party access.
        </Tip>
      </Step>

      <Step id="copy" number={2} title="Copy the site to your account">
        <ol className="list-decimal space-y-3 pl-5">
          <li>
            Open the{" "}
            <Link href="/dashboard#repositories" className="underline">
              dashboard
            </Link>{" "}
            and find <code className="font-mono text-sm">twinstack-site</code>. Use the filter box and the Private / Public / All
            switch.
          </li>
          <li>
            Click <strong>Duplicate</strong>, choose a name for your copy and whether it&apos;s private, then click{" "}
            <strong>Create &amp; push</strong>.
          </li>
          <li>
            The new repository is created in your account with every branch, tag and commit. Once it&apos;s done, it&apos;s added to your list.
          </li>
        </ol>
        <Tip>
          Issues, pull requests, wikis, repository settings and Git LFS files aren&apos;t copied. If copying fails partway, try
          again with the same name: the empty repository that was left behind is reused. The template itself can&apos;t be managed. Your changes always go into your own copy.
        </Tip>
      </Step>

      <Step id="work" number={3} title="Work on your site">
        <p>
          Click <strong>Manage site</strong> next to your copy. The first time, the server clones the repository and installs its
          dependencies, which takes about a minute. After that, opening the site fetches the latest from GitHub. Work you
          haven&apos;t published yet is kept, even if you close the page.
        </p>
        <div className="mt-5 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-3 py-2 font-medium">Tab</th>
                <th className="px-3 py-2 font-medium">What you can do</th>
                <th className="px-3 py-2 font-medium">Same as</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {TABS.map(([tab, what, command]) => (
                <tr key={tab}>
                  <td className="whitespace-nowrap px-3 py-2 font-medium">{tab}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">{what}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-500">{command}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Tip>
          One command runs at a time. Its output appears in the Output panel, where you can also cancel it. Claude edits have a
          Preview button that shows the proposed file without writing it.
        </Tip>
      </Step>

      <Step id="publish" number={4} title="Publish your changes">
        <ol className="list-decimal space-y-3 pl-5">
          <li>
            Open the <strong>Changes</strong> tab. Expand a file to see its diff, or select files and discard them.
          </li>
          <li>
            Write a commit message and choose how to publish:
            <ul className="mt-2 list-disc space-y-2 pl-5">
              <li>
                <strong>New branch and pull request</strong> (recommended). Your changes go to a new branch, named{" "}
                <code className="font-mono text-sm">twinstack/&lt;date&gt;-&lt;time&gt;</code> unless you pick a name, and a pull
                request is opened into the default branch. Review and merge it on GitHub. Later commits on that branch update the
                same pull request.
              </li>
              <li>
                <strong>Push directly</strong> to the current branch. This skips review. If the site&apos;s deploy workflow builds
                from that branch, the live site changes straight away.
              </li>
            </ul>
          </li>
          <li>
            When the pull request is merged, click <strong>Start a new change</strong> to go back to the default branch. If GitHub
            has newer commits, click <strong>Update to latest</strong>. Both are available once there are no unpublished changes.
          </li>
        </ol>
      </Step>

      <section id="help" className="mt-16 border-t border-zinc-200 pt-10 dark:border-zinc-800">
        <h2 className="text-2xl font-semibold tracking-tight">Troubleshooting</h2>
        <dl className="mt-6 space-y-5">
          {HELP.map((item) => (
            <div key={item.q}>
              <dt className="font-medium">{item.q}</dt>
              <dd className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{item.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="mt-16 text-center">
        {user ? (
          <Link href="/dashboard" className="text-sm font-medium underline">
            Go to your dashboard →
          </Link>
        ) : (
          <a href="/auth/github" className="text-sm font-medium underline">
            Sign in with GitHub to start →
          </a>
        )}
      </div>
    </main>
  );
}

function StepNumber({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-sm font-medium text-background">
      {children}
    </span>
  );
}

function Step({ id, number, title, children }: { id: string; number: number; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="mt-16">
      <div className="flex items-center gap-3">
        <StepNumber>{number}</StepNumber>
        <h2 id={`${id}-heading`} className="text-2xl font-semibold tracking-tight">
          {title}
        </h2>
      </div>
      <div className="mt-5 leading-relaxed text-zinc-700 dark:text-zinc-300">{children}</div>
    </section>
  );
}

function Tip({ children }: { children: ReactNode }) {
  return (
    <p className="mt-5 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      {children}
    </p>
  );
}
