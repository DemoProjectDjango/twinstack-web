import { githubFetch } from "./github.js";
import { starterHomepage } from "./site-files.js";

// A brand-new copy's first commit of its own, made by the duplicate route (index.js) once Pages is
// on, so the deploy it starts publishes a working site:
//   - the name its owner typed, in place of the template's placeholder in site.config.json
//     (`name`, `shortName`, `brand.logoText`), leaving the rest of the file byte for byte;
//   - a starter homepage (starterHomepage in site-files.js, the page the editor's "Create" makes),
//     when the pages collection has no pages. The template ships none, but its 404 page links to
//     "/", and check.js refuses a site that links to a missing page, so without one the first
//     deploy fails and the editor opens on "Your site links to a page that doesn't exist yet".
// One commit through GitHub's Git Data API, so one deploy. It never throws: a site that couldn't
// be set up is still created, and the editor's own "Create" for the homepage still works.

// The template's placeholder name, in site.config.json's `name`, `shortName` and `brand.logoText`.
const TEMPLATE_SITE_NAME = "My Website";
const PLACEHOLDER_FIELDS = new RegExp(`("(?:name|shortName|logoText)"\\s*:\\s*)${JSON.stringify(TEMPLATE_SITE_NAME)}`, "g");

async function json(pathname, accessToken, init) {
  const res = await githubFetch(pathname, accessToken, init);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`GitHub ${init?.method ?? "GET"} ${pathname} returned ${res.status}`);
  return body;
}

const encodePath = (filePath) => filePath.split("/").map(encodeURIComponent).join("/");

/** Names and homepage `fullName` as described above. Returns the files it committed ([] if none). */
export async function setUpNewSite({ accessToken, fullName, displayName }) {
  try {
    const repo = await json(`/repos/${fullName}`, accessToken);
    const branch = encodeURIComponent(repo.default_branch);
    const head = (await json(`/repos/${fullName}/git/ref/heads/${branch}`, accessToken)).object.sha;

    // A file at the commit being built on, or null when it isn't there.
    const read = async (filePath) => {
      const res = await githubFetch(`/repos/${fullName}/contents/${encodePath(filePath)}?ref=${head}`, accessToken);
      if (!res.ok) return null;
      const file = await res.json();
      return file.type === "file" && file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : null;
    };

    const files = [];
    const configText = await read("site.config.json");
    if (configText === null) return [];
    let config = configText;
    if (displayName) {
      config = configText.replace(PLACEHOLDER_FIELDS, (_, key) => `${key}${JSON.stringify(displayName)}`);
      if (config !== configText) files.push({ path: "site.config.json", content: config });
    }
    const site = JSON.parse(config); // Never commit a config the site's scripts can't read.

    const pagesDir = site.collections?.pages?.dir;
    if (typeof pagesDir === "string" && pagesDir) {
      const res = await githubFetch(`/repos/${fullName}/contents/${encodePath(pagesDir)}?ref=${head}`, accessToken);
      const listing = res.ok ? await res.json() : [];
      const hasPages = Array.isArray(listing) && listing.some((entry) => entry.type === "file" && entry.name.endsWith(".md"));
      const home = hasPages ? null : await starterHomepage(site, read);
      if (home) files.push({ path: home.file, content: home.content });
    }
    if (!files.length) return [];

    const baseTree = (await json(`/repos/${fullName}/git/commits/${head}`, accessToken)).tree.sha;
    const tree = await json(`/repos/${fullName}/git/trees`, accessToken, {
      method: "POST",
      body: { base_tree: baseTree, tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })) },
    });
    const what = [files.some((f) => f.path === "site.config.json") && "its name", files.some((f) => f.path !== "site.config.json") && "a homepage"];
    const commit = await json(`/repos/${fullName}/git/commits`, accessToken, {
      method: "POST",
      body: { message: `Set up ${displayName ? `"${displayName}"` : "the site"}: ${what.filter(Boolean).join(" and ")}`, tree: tree.sha, parents: [head] },
    });
    await json(`/repos/${fullName}/git/refs/heads/${branch}`, accessToken, { method: "PATCH", body: { sha: commit.sha } });
    return files.map((f) => f.path);
  } catch (err) {
    console.warn(`Couldn't set up the new site ${fullName}: ${err.message}`);
    return [];
  }
}
