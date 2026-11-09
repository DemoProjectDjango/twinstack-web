"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Leaves out the app's top navbar on a site's editor, which has the same things in its own layout. */
export function HideInSiteEditor({ children }: { children: ReactNode }) {
  return /^\/sites\/[^/]+\/[^/]+/.test(usePathname()) ? null : children;
}
