"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavLink = { href: string; label: string; match: (pathname: string) => boolean };

const GUEST_LINKS: NavLink[] = [{ href: "/#guide", label: "Guide", match: () => false }];

const USER_LINKS: NavLink[] = [
  { href: "/#guide", label: "Guide", match: () => false },
  { href: "/dashboard", label: "Dashboard", match: (p) => p.startsWith("/dashboard") },
  { href: "/dashboard#repositories", label: "Sites", match: (p) => p.startsWith("/sites") },
  { href: "/dashboard#anthropic-key", label: "API key", match: () => false },
];

export function NavLinks({ signedIn }: { signedIn: boolean }) {
  const pathname = usePathname();
  const links = signedIn ? USER_LINKS : GUEST_LINKS;

  return (
    <ul className="flex items-center gap-1 text-sm">
      {links.map((link) => {
        const active = link.match(pathname);
        return (
          <li key={link.label}>
            <Link
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-md px-2.5 py-1.5 ${
                active ? "font-medium text-foreground" : "text-zinc-500 hover:text-foreground"
              }`}
            >
              {link.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
