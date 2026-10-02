import type { NavigationInfo, NavItem } from "@/lib/site-api";

// Helpers shared by the Header & footer tab's editor and preview.

/** The addresses of the pages the site builds, and of its drafts (which the build leaves out). */
export type PageIndex = { live: Set<string>; draft: Set<string> };

export function pageIndex(info: NavigationInfo): PageIndex {
  return {
    live: new Set(info.pages.filter((page) => !page.draft).map((page) => page.url)),
    draft: new Set(info.pages.filter((page) => page.draft).map((page) => page.url)),
  };
}

// Files the build writes besides pages (scripts/lib/content.js → GENERATED_FILES).
const GENERATED = new Set(["/sitemap.xml", "/rss.xml", "/robots.txt", "/search-index.json"]);

/**
 * Whether a link leads somewhere once the site is built, the way the site's
 * linkTarget() decides: the build leaves out header and footer links to
 * pages it doesn't have. Links elsewhere (https:, mailto:, anchors) are "ok".
 */
export function linkStatus(url: string | undefined, index: PageIndex): "ok" | "empty" | "missing" | "draft" {
  if (!url || !url.trim()) return "empty";
  if (!url.startsWith("/") || url.startsWith("//")) return "ok";
  const bare = url.split(/[?#]/)[0] || "/";
  // Files in assets/ and static/ count too; the editor can't see them, so it trusts them.
  if (GENERATED.has(bare) || bare.startsWith("/assets/")) return "ok";
  const trimmed = bare.length > 1 ? bare.replace(/\/$/, "") : bare;
  const candidates = [bare, `${trimmed}/`, trimmed, `${trimmed}.html`];
  if (candidates.some((u) => index.live.has(u))) return "ok";
  if (candidates.some((u) => index.draft.has(u))) return "draft";
  return "missing";
}

/** A header item is a plain link, a dropdown of links, or a menu that lists a collection's pages. */
export type ItemKind = "link" | "dropdown" | "collection";

export function kindOf(item: NavItem): ItemKind {
  if (item.type === "collection") return "collection";
  return Array.isArray(item.children) ? "dropdown" : "link";
}

/** The item turned into another kind, keeping its label, link and any other fields it has. */
export function withKind(item: NavItem, kind: ItemKind, defaultCollection: string): NavItem {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { type, collection, limit, children, ...rest } = item;
  if (kind === "link") return { ...rest, url: rest.url ?? "" };
  if (kind === "dropdown") return { ...rest, children: children?.length ? children : [{ label: "", url: "" }] };
  return { ...rest, type: "collection", collection: collection ?? defaultCollection, limit: limit ?? 8 };
}

/** Moves an entry of `list` (in place) by `by` places; does nothing at either end. */
export function move<T>(list: T[], index: number, by: number) {
  const to = index + by;
  if (to < 0 || to >= list.length) return;
  const [entry] = list.splice(index, 1);
  list.splice(to, 0, entry);
}
