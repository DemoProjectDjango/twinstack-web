import type { Change, Overview } from "./site-api";

const STATUS: Record<Change["status"], string> = {
  added: "New",
  modified: "Changed",
  deleted: "Removed",
  renamed: "Renamed",
};

const baseName = (path: string) => path.split("/").pop() ?? path;

/** What a changed file is, in words for someone who doesn't know the site's layout. */
export function describeChange(change: Change, overview: Overview | null): { what: string; status: string } {
  const path = change.path;
  const status = change.untracked ? "New" : STATUS[change.status];
  const page = overview?.collections.flatMap((c) => c.pages).find((p) => p.file === path);

  let what: string;
  if (page) what = `Page: ${page.title}`;
  else if (path.startsWith("content/") && path.endsWith(".md")) what = `Page: ${baseName(path).replace(/\.md$/, "")}`;
  else if (path === "content/data/navigation.json") what = "Menu and footer";
  else if (path.startsWith("content/data/")) what = `Site details: ${baseName(path).replace(/\.json$/, "")}`;
  else if (path === "site.config.json") what = "Site settings and logo";
  else if (path.startsWith("assets/img/")) what = `Image: ${baseName(path)}`;
  else if (path.startsWith("assets/css/") || path.startsWith("assets/js/") || path.startsWith("styles/")) what = `Styles and scripts: ${baseName(path)}`;
  else if (path.startsWith("knowledge/")) what = "What Claude remembers";
  else if (path === "scripts/site-tree.md") what = "Site plan";
  else if (path === "scripts/scaffold-schedule.md") what = "Scheduled pages";
  else if (path.startsWith("scripts/") || path.startsWith("templates/") || path.startsWith(".github/") || /^package(-lock)?\.json$/.test(path)) {
    what = `Site tools: ${baseName(path)}`;
  } else what = path;

  return { what, status };
}

/** A version note for a publish, from what changed ("Update About us and 2 more"). */
export function summarizeChanges(changes: Change[], overview: Overview | null) {
  if (changes.length === 0) return "";
  const names = [...new Set(changes.map((c) => describeChange(c, overview).what.replace(/^[^:]+: /, "")))];
  const first = names.slice(0, 2).join(" and ");
  const rest = names.length - 2;
  return `Update ${first}${rest > 0 ? ` and ${rest} more` : ""}`.slice(0, 200);
}
