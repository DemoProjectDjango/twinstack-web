"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/access", label: "Access requests" },
  { href: "/admin/models", label: "AI models" },
  { href: "/admin/purchases", label: "Purchases" },
  { href: "/admin/providers", label: "AI providers" },
];

/** Moves between the admin pages. */
export function AdminTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin" className="mb-6 flex w-fit max-w-full flex-wrap gap-1 rounded-md border border-zinc-200 p-1 dark:border-zinc-800">
      {TABS.map((tab) => {
        const active = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`rounded px-3 py-1 text-sm font-medium ${active ? "bg-foreground text-background" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
