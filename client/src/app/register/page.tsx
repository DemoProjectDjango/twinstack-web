import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { safeNext } from "@/lib/safe-next";
import { getUser } from "@/lib/session";

export const metadata: Metadata = { title: "Create an account · Twinstack" };

export default async function RegisterPage({ searchParams }: PageProps<"/register">) {
  const [user, { next }] = await Promise.all([getUser(), searchParams]);
  const nextPath = typeof next === "string" ? next : undefined;
  if (user) redirect(safeNext(nextPath));

  return (
    <main className="flex flex-1 items-start justify-center px-4 py-16">
      <AuthForm mode="register" next={nextPath} />
    </main>
  );
}
