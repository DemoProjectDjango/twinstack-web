"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavLink = { href: string; label: string; match: (pathname: string) => boolean };

const GUEST_LINKS: NavLink[] = [
  { href: "/#how", label: "How it works", match: () => false },
  { href: "/#help", label: "Help", match: () => false },
];

const USER_LINKS: NavLink[] = [
  { href: "/dashboard", label: "Your sites", match: (p) => p.startsWith("/dashboard") || p.startsWith("/sites") },
  { href: "/settings", label: "Settings", match: (p) => p.startsWith("/settings") },
  { href: "/#help", label: "Help", match: () => false },
];

const ADMIN_LINK: NavLink = { href: "/admin/access", label: "Admin", match: (p) => p.startsWith("/admin") };

/** `withoutSites`: the site editor has its own way back to the list of sites. */
export function NavLinks({ signedIn, admin = false, withoutSites = false }: { signedIn: boolean; admin?: boolean; withoutSites?: boolean }) {
  const pathname = usePathname();
  const all = signedIn ? (admin ? [...USER_LINKS, ADMIN_LINK] : USER_LINKS) : GUEST_LINKS;
  const links = withoutSites ? all.filter((link) => link.href !== "/dashboard") : all;

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
