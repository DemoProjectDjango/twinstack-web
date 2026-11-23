import type { Metadata } from "next";
import { FeatureTour } from "@/components/features/FeatureTour";
import { getUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Try Twinstack's features · Twinstack",
  description: "Try the Twinstack website builder on a pretend site: edit words, ask the AI, pick colours, add pages and publish, in about two minutes.",
};

export default async function FeaturesPage() {
  const user = await getUser();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24">
      <header className="py-10 sm:py-12">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Try it yourself</h1>
        <p className="mt-3 max-w-2xl text-lg text-zinc-500">
          Here&apos;s a pretend bakery website. Play with it to see what Twinstack can do. Nothing you do here is saved.
        </p>
      </header>
      <FeatureTour signedIn={!!user} />
    </main>
  );
}
