// A full review of the site as it's built (the AI's review_site tool): for every page, the facts an
// upgrade plan should rest on, measured rather than guessed. Its outline, how much it says, what it
// asks visitors to do, its forms and where they send, its pictures (missing alt text, oversized
// files, ones still loading from another website), links back to an old website, search settings
// and structured data. Then the site as a whole: contact details, social links, favicon, analytics,
// the site agent. No AI, no credits; the AI reads this, looks at pages with view_page, and writes
// the plan.

import fs from "node:fs/promises";
import path from "node:path";
import { builtSite } from "./assistant/view-page.js";
import { sitePages } from "./navigation.js";
import { readSiteConfig } from "./site-files.js";
import { workspaceDir } from "./workspace.js";

const MAX_PAGES = 30;
const BIG_IMAGE = 400 * 1024;

const text = (html) =>
  html
    .replace(/<(script|style|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const attr = (tag, name) => new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']*)\\1`, "i").exec(tag)?.[2] ?? null;

/** The built file for a page address. */
function builtFile(root, url) {
  const clean = decodeURIComponent(url.split(/[?#]/)[0]);
  if (clean === "/" || clean.endsWith("/")) return path.join(root, clean, "index.html");
  return path.join(root, clean.endsWith(".html") ? clean : `${clean}.html`);
}

async function size(file) {
  return (await fs.stat(file).catch(() => null))?.size ?? null;
}

/** One page's facts from its built HTML. */
async function reviewPage(root, page, ownHosts) {
  const html = await fs.readFile(builtFile(root, page.url), "utf8").catch(() => null);
  if (html === null) return { url: page.url, title: page.title ?? null, missing: true };
  const main = /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html;
  const head = /<head\b[\s\S]*?<\/head>/i.exec(html)?.[0] ?? "";
  const words = text(main).split(" ").filter(Boolean).length;
  const headings = [...main.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => `${m[1].toLowerCase()}: ${text(m[2]).slice(0, 90)}`).filter((h) => !/:\s*$/.test(h));

  // What it asks visitors to do: buttons and button-looking links.
  const actions = [];
  for (const m of main.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const label = text(m[3]).slice(0, 60);
    if (!label) continue;
    const cls = attr(m[0], "class") ?? "";
    if (m[1].toLowerCase() === "button" || /\b(btn|button|cta)\b/i.test(cls)) actions.push(label);
  }
  const hrefs = [...main.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1/gi)].map((m) => m[2]);
  const oldSite = hrefs.filter((h) => /^https?:\/\//i.test(h) && !ownHosts.some((host) => h.includes(host)));

  const forms = [...main.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((m) => {
    const action = attr(`<form ${m[1]}>`, "action") ?? "";
    const fields = (m[2].match(/<(input|textarea|select)\b(?![^>]*type\s*=\s*["']?(hidden|submit|button))/gi) ?? []).length;
    return {
      fields,
      sendsTo: !action ? "nowhere (no action: it does nothing on a static site)" : /^https?:\/\//i.test(action) ? `another website (${new URL(action).host})` : action,
    };
  });

  const images = [];
  for (const m of main.matchAll(/<img\b[^>]*>/gi)) {
    const src = attr(m[0], "src") ?? attr(m[0], "data-src") ?? "";
    if (!src || src.startsWith("data:")) continue;
    const alt = attr(m[0], "alt");
    const local = src.startsWith("/") && !src.startsWith("//");
    const bytes = local ? await size(path.join(root, decodeURIComponent(src.split(/[?#]/)[0]).replace(/^\/[^/]+(?=\/assets\/)/, ""))) : null;
    images.push({ src, missingAlt: alt === null || !alt.trim(), outside: !local, bytes });
  }

  const phones = (main.match(/href\s*=\s*["']tel:/gi) ?? []).length;
  const emails = (main.match(/href\s*=\s*["']mailto:/gi) ?? []).length;
  return {
    url: page.url,
    title: (/<title>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "").trim().slice(0, 120),
    description: attr(/<meta\b[^>]*name\s*=\s*["']description["'][^>]*>/i.exec(head)?.[0] ?? "", "content"),
    words,
    h1: headings.filter((h) => h.startsWith("h1")).length,
    outline: headings.slice(0, 14),
    actions: [...new Set(actions)].slice(0, 10),
    forms,
    phoneLinks: phones,
    emailLinks: emails,
    images: {
      total: images.length,
      missingAlt: images.filter((i) => i.missingAlt).length,
      oversized: images.filter((i) => i.bytes && i.bytes > BIG_IMAGE).map((i) => ({ src: i.src.split("/").pop(), kb: Math.round(i.bytes / 1024) })).slice(0, 8),
      fromAnotherWebsite: images.filter((i) => i.outside).length,
    },
    linksToOtherWebsites: oldSite.length,
    oldWebsiteLinks: [...new Set(oldSite.map((h) => { try { return new URL(h).host; } catch { return null; } }).filter(Boolean))].slice(0, 5),
    structuredData: /application\/ld\+json/i.test(html),
    socialImage: /property\s*=\s*["']og:image["']/i.test(head),
    copiedDesign: /class\s*=\s*["'][^"']*imported-page/i.test(html),
  };
}

/** The whole site's review: `{ pages, site, notes }`. */
export async function reviewSite(key) {
  const root = await builtSite(key);
  const dir = workspaceDir(key);
  const config = await readSiteConfig(key);
  const pages = (await sitePages(dir, config).catch(() => [])).filter((p) => !p.draft && typeof p.url === "string").slice(0, MAX_PAGES);
  let ownHosts = [];
  try {
    ownHosts = [new URL(config.url).host];
  } catch {
    // No address yet.
  }
  const reviewed = [];
  for (const page of pages) reviewed.push(await reviewPage(root, page, ownHosts));

  const header = await fs.readFile(path.join(dir, "templates/partials/header.html"), "utf8").catch(() => "");
  const contact = config.contact ?? {};
  const social = Object.entries(config.social ?? {}).filter(([, v]) => typeof v === "string" && v.trim()).map(([k]) => k);
  const site = {
    name: config.name ?? null,
    description: config.description ?? null,
    pages: reviewed.length,
    headerAndFooter: /data-designed\s*=\s*["']copied/.test(header) ? "copied from a website" : /data-designed/.test(header) ? "designed by the AI" : "the standard ones",
    contact: { email: Boolean(contact.email), phone: Boolean(contact.phone), address: Boolean(contact.address), hours: Boolean(contact.hours), bookingLink: Boolean(contact.booking ?? contact.bookingUrl) },
    socialLinks: social,
    logo: Boolean(config.brand?.logo),
    favicon: Boolean(config.brand?.favicon || config.brand?.logoMark),
    analytics: Boolean(config.analytics?.key),
    siteAgent: Boolean(config.agent?.key),
    totals: {
      words: reviewed.reduce((n, p) => n + (p.words ?? 0), 0),
      imagesMissingAlt: reviewed.reduce((n, p) => n + (p.images?.missingAlt ?? 0), 0),
      oversizedImages: reviewed.reduce((n, p) => n + (p.images?.oversized?.length ?? 0), 0),
      formsThatSendNowhereUseful: reviewed.reduce((n, p) => n + (p.forms ?? []).filter((f) => !f.sendsTo.startsWith("/")).length, 0),
      pagesWithoutDescription: reviewed.filter((p) => !p.description).length,
      pagesWithoutOneH1: reviewed.filter((p) => !p.missing && p.h1 !== 1).length,
    },
  };
  const notes = [
    "Measured from the built site. Look at the important pages with view_page (computer and phone) before suggesting design changes.",
    site.totals.formsThatSendNowhereUseful ? "Copied forms still send to the old website or nowhere: a static site needs a form service or a contact link instead." : null,
  ].filter(Boolean);
  return { site, pages: reviewed, notes };
}
