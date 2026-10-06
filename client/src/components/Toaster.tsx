"use client";

import { ToastContainer } from "react-toastify";
import { ConfirmHost } from "@/lib/confirm";

/** Where every toast (lib/toast.tsx) and confirmation modal (lib/confirm.tsx) in the app appears. */
export function Toaster() {
  return (
    <>
      <ToastContainer position="top-center" newestOnTop limit={4} />
      <ConfirmHost />
    </>
  );
}
