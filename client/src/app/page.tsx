import Link from "next/link";
import { getUser } from "@/lib/session";

const STEPS = [
  {
    title: "Sign up and connect GitHub",
    text: "Create your account, then connect GitHub: the free service that stores your site and puts it on the web.",
  },
  {
    title: "Create your site",
    text: "Give it a name. You get your own copy of the TwinStack website with its own web address.",
  },
  {
    title: "Make it yours and publish",
    text: "Add your logo and pages, check the preview, and press Publish. Your site is live a minute later.",
  },
];

const FEATURES = [
  ["Pages", "Add pages, blog posts, services and products, and write them in plain text."],
  ["Design", "Upload your logo, pick colours, and arrange the menu and footer with a live preview."],
  ["Claude, if you want it", "Give Claude your notes and it writes the page, or ask it to change a page in your own words. You always see the result first."],
  ["Bring your old site", "Upload pages saved from your old website and Claude fits them into the new one."],
  ["Found on Google", "See how each page shows up in search results and when it's shared, and improve it."],
  ["One-click publishing", "See every change before it goes live, undo what you don't want, and publish with one button."],
];

const HELP = [
  {
    q: "Do I need to know how to code?",
    a: "No. You write text, pick colours and press buttons. The technical parts are tucked away under Advanced for anyone who wants them.",
  },
  {
    q: "What is GitHub, and why do I need it?",
    a: "GitHub is a free service that stores your site's files and publishes your site on the web. You create a GitHub account once and connect it; after that, Twinstack does everything there for you.",
  },
  {
    q: "What does Claude cost?",
    a: "Claude is optional. To use it, add your own Anthropic API key in Settings; its use is billed to your Anthropic account. Everything else works without it.",
  },
  {
    q: "It says my GitHub connection has expired",
    a: "Click Reconnect GitHub. Connections can expire, and an older one may lack a permission the app now needs. Your account, sites and settings are kept.",
  },
  {
    q: "I can't create a site",
    a: "Your GitHub account needs access to the TwinStack template. Ask its owner to share it with you, then refresh the page.",
  },
  {
    q: "A button is greyed out while something is happening",
    a: "One thing runs at a time on a site. A message at the bottom of the screen says what's happening, and you can cancel it there.",
  },
  {
    q: "Publishing didn't work",
    a: "Nothing is lost: your changes stay on the Publish screen. Fix what the message says (often reconnecting GitHub), then press Publish again.",
  },
  {
    q: "Can someone check changes before they go live?",
    a: "Yes. On the Publish screen, open More options and choose Send for review. The changes go live once the review is approved on GitHub.",
  },
];

export default async function Home() {
  const user = await getUser();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24">
      {/* Hero */}
      <section className="py-16 text-center sm:py-24">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Build your website, step by step</h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-zinc-500">
          Start from a ready-made site, make it yours, and publish it with one click. No code, no technical setup.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {user ? (
            <Link
              href="/dashboard"
              className="inline-flex items-center justify-center rounded-md bg-foreground px-6 py-3 text-sm font-medium text-background hover:opacity-90"
            >
              Go to your sites
            </Link>
          ) : (
            <>
              <Link
                href="/register"
                className="inline-flex items-center justify-center rounded-md bg-foreground px-6 py-3 text-sm font-medium text-background hover:opacity-90"
              >
                Get started
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center justify-center rounded-md border border-zinc-300 px-6 py-3 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Log in
              </Link>
            </>
          )}
        </div>
      </section>

      <section id="how" aria-labelledby="how-heading" className="scroll-mt-20">
        <h2 id="how-heading" className="text-center text-2xl font-semibold tracking-tight">
          How it works
        </h2>
        <ol className="mt-8 grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
              <span className="grid size-8 place-items-center rounded-full bg-foreground text-sm font-medium text-background">
                {index + 1}
              </span>
              <p className="mt-4 font-medium">{step.title}</p>
              <p className="mt-1 text-sm text-zinc-500">{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="features-heading" className="mt-20">
        <h2 id="features-heading" className="text-center text-2xl font-semibold tracking-tight">
          What you can do
        </h2>
        <ul className="mt-8 grid gap-x-8 gap-y-6 sm:grid-cols-2">
          {FEATURES.map(([title, text]) => (
            <li key={title}>
              <p className="font-medium">{title}</p>
              <p className="mt-1 text-sm text-zinc-500">{text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section id="help" aria-labelledby="help-heading" className="mt-20 scroll-mt-20 border-t border-zinc-200 pt-12 dark:border-zinc-800">
        <h2 id="help-heading" className="text-2xl font-semibold tracking-tight">
          Questions and help
        </h2>
        <div className="mt-6 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {HELP.map((item) => (
            <details key={item.q} className="group px-4 py-3">
              <summary className="cursor-pointer list-none font-medium">
                <span className="mr-2 inline-block text-zinc-400 transition-transform group-open:rotate-90">▸</span>
                {item.q}
              </summary>
              <p className="mt-2 pl-5 text-sm text-zinc-600 dark:text-zinc-400">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <div className="mt-16 text-center">
        <Link href={user ? "/dashboard" : "/register"} className="text-sm font-medium underline">
          {user ? "Go to your sites →" : "Create your free account →"}
        </Link>
      </div>
    </main>
  );
}
