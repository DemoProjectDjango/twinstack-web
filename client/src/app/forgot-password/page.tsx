import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/ForgotPasswordForm";

export const metadata: Metadata = { title: "Reset your password · Twinstack" };

// Not redirected when signed in, unlike /login: the reset signs the browser in part way
// through, and a redirect then would skip the "sign out other devices?" question.
export default async function ForgotPasswordPage({ searchParams }: PageProps<"/forgot-password">) {
  const { email, next } = await searchParams;
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <ForgotPasswordForm
        initialEmail={typeof email === "string" ? email.slice(0, 254) : undefined}
        next={typeof next === "string" ? next : undefined}
      />
    </main>
  );
}
