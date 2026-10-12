import path from "node:path";
import { getBrand } from "./brand.js";
import { readMissingPages } from "./missing-pages.js";
import { getNavigation } from "./navigation.js";
import { readSeo } from "./seo.js";
import { getOverview, readText } from "./site-files.js";
import { getStatus, workspaceDir } from "./workspace.js";

// "Next steps" in the Ask Claude panel: what the owner's site still needs, worked out from files the
// app already reads (no Claude, no credits), each with the words to send Claude or a screen to open.
// The owner isn't technical, so every step says what to do in plain words and why it matters.
//
// A step is { id, title, why, done, counts, action }. `action` is null once there's nothing to do, or one of:
//   { type: "send", prompt }  — sent to Claude as it is (Claude still shows each change first)
//   { type: "fill", prompt }  — put in the message box for the owner to finish (facts only they know)
//   { type: "open", section } — a screen of the editor (things Claude can't do, like uploading a logo)
// `progress` counts the steps that describe the site itself, and every page (written or not) as one
// each; publishing isn't counted.

// A page body that's still the starter skeleton: copies scripts/lib/design-rules.js (STARTER_TEXT,
// isDesigned) in the template, so keep the two in step.
const STARTER_TEXT = /One sentence on (what|how)|Replace this with|Opening paragraph: the specific situation/;
const isDesigned = (body) => /<section\b[^>]*class=/.test(body) && !STARTER_TEXT.test(body);
// Pages read for starter text, at most: a big blog is still quick to check.
const MAX_PAGES_READ = 300;
// Steps of one kind listed one by one, at most (the rest are one step).
const MAX_EACH = 3;

const bodyOf = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
const isHome = (page) => page.url === "/" || page.file === "content/pages/home.md";
const quoted = (title) => `"${String(title).replace(/"/g, "'")}"`;

async function readJson(dir, file) {
  try {
    return JSON.parse((await readText(path.join(dir, file))) ?? "null");
  } catch {
    return null;
  }
}

/** Pages whose body is still empty or the starter skeleton. */
async function unwrittenPages(dir, overview) {
  const pages = overview.collections.flatMap((c) => c.pages.map((p) => ({ ...p, collection: c.name }))).filter((p) => !p.draft);
  const unwritten = [];
  for (const page of pages.slice(0, MAX_PAGES_READ)) {
    const text = (await readText(path.join(dir, page.file))) ?? "";
    const body = bodyOf(text);
    // A converted page (imported HTML and CSS) is written, whatever its markup looks like.
    const converted = /^stylesheet:\s*\/assets\/css\/imported\//m.test(text);
    if (!converted && (!body || STARTER_TEXT.test(body) || (isHome(page) && !isDesigned(body)))) unwritten.push(page);
  }
  return { pages, unwritten };
}

export async function getNextSteps(key) {
  const dir = workspaceDir(key);
  const [overview, status, missing, seo, brand, nav, site, testimonials, faq] = await Promise.all([
    getOverview(key),
    getStatus(key),
    readMissingPages(key).catch(() => ({ report: null })),
    readSeo(key).catch(() => null),
    getBrand(key).catch(() => null),
    getNavigation(key).catch(() => null),
    readJson(dir, "site.config.json"),
    readJson(dir, "content/data/testimonials.json"),
    readJson(dir, "content/data/faq.json"),
  ]);
  const name = site?.name || overview.site.name || "my business";
  const steps = [];
  const add = (step) => steps.push({ counts: true, ...step });

  // 1. The homepage: the first thing every visitor sees.
  const { pages, unwritten } = await unwrittenPages(dir, overview);
  const home = pages.find(isHome);
  if (home) {
    add({
      id: "home",
      title: "Design your homepage",
      why: "It's the first page visitors see, so it should say what you do and what they should do next.",
      done: !unwritten.includes(home),
      action: {
        type: "send",
        prompt: `Design my homepage so a first-time visitor understands straight away what ${name} does, why to choose us, and what to do next (contact us, book or buy). Ask me about anything you need to know about the business.`,
      },
    });
  }

  // 2. Pages still holding the starter text. Only the next few are listed, but `progress` counts
  // every page (below), so writing any one of them moves it.
  const others = unwritten.filter((p) => p !== home);
  for (const page of others.slice(0, MAX_EACH)) {
    add({
      counts: false,
      id: `write:${page.file}`,
      title: `Write the ${quoted(page.title)} ${page.collection === "pages" ? "page" : "post"}`,
      why: "It still has the placeholder text it was created with.",
      done: false,
      action: {
        type: "send",
        prompt: `Write the ${quoted(page.title)} ${page.collection === "pages" ? "page" : "post"} (${page.file}) with real content for ${name}, matching the look of my homepage. Ask me about anything you need to know.`,
      },
    });
  }
  if (others.length > MAX_EACH) {
    add({
      counts: false,
      id: "write:more",
      title: `Write ${others.length - MAX_EACH} more ${others.length - MAX_EACH === 1 ? "page" : "pages"}`,
      why: "They still have the placeholder text they were created with.",
      done: false,
      action: { type: "send", prompt: "Which of my pages still have placeholder text? Write the next one for me." },
    });
  }
  if (!others.length && pages.length > 1) {
    add({ counts: false, id: "write", title: "Write every page", why: "No page still has placeholder text.", done: true, action: null });
  }

  // 3. Links to pages that don't exist yet, and pages nothing links to (from the last build's scan).
  const report = missing?.report;
  if (report) {
    for (const link of (report.missing ?? []).slice(0, MAX_EACH)) {
      const label = link.label || link.href;
      add({
        id: `missing:${link.href}`,
        title: `Create the ${quoted(label)} page`,
        why: "Your site links to it, but it doesn't exist yet, so visitors get an error.",
        done: false,
        action: { type: "send", prompt: `My site links to ${link.href} (${quoted(label)}) but that page doesn't exist. Create it with real content for ${name}.` },
      });
    }
    for (const page of (report.unlinked ?? []).slice(0, MAX_EACH)) {
      add({
        id: `unlinked:${page.file}`,
        title: `Help visitors find ${quoted(page.title)}`,
        why: "No menu or page links to it, so visitors can't get there.",
        done: false,
        action: { type: "send", prompt: `Add ${quoted(page.title)} (${page.url}) to the menu so visitors can find it.` },
      });
    }
    if (!report.missing?.length && !report.unlinked?.length) {
      add({ id: "links", title: "Every page can be reached", why: "No broken links, and every page is linked.", done: true, action: null });
    }
  }

  // 4. The header and footer, on every page.
  if (overview.features.chromeDesign && nav) {
    const designed = (nav.designed?.header && nav.designed?.footer) || nav.copied?.header || nav.copied?.footer;
    add({
      id: "chrome",
      title: "Design a header and footer that match your site",
      why: "They're on every page, so they set the look of the whole site.",
      done: Boolean(designed),
      action: { type: "send", prompt: "Design a header and footer that match the look of my homepage." },
    });
  }

  // 5. The logo: an upload, which the Design screen does.
  if (brand?.supported) {
    add({
      id: "logo",
      title: "Add your logo",
      why: "It makes the site recognisably yours. Upload it on the Design screen.",
      done: Boolean(brand.brand.logo || brand.brand.logoMark),
      action: { type: "open", section: "design" },
    });
  }

  // 6. How to reach the business: facts only the owner knows, so they finish the message.
  if (site) {
    const contact = site.contact ?? {};
    add({
      id: "contact",
      title: "Add your email and phone number",
      why: "Visitors who are ready to buy need a way to reach you.",
      done: Boolean(contact.email || contact.phone || contact.whatsapp),
      action: { type: "fill", prompt: "Our email is \nOur phone number is " },
    });
    const social = Object.values(site.social ?? {}).some((v) => typeof v === "string" && v.trim());
    add({
      id: "social",
      title: "Link your social media pages",
      why: "People often check them before they get in touch.",
      done: social,
      action: { type: "fill", prompt: "Add our social media pages: Instagram , Facebook " },
    });
  }

  // 7. What makes visitors trust and stay: reviews and answers to their questions.
  if (testimonials && Array.isArray(testimonials.items)) {
    add({
      id: "testimonials",
      title: "Show reviews from your customers",
      why: "Real reviews are one of the strongest reasons people choose a business.",
      done: testimonials.items.length > 0,
      // Reviews must be real, so the owner gives them; Claude never makes them up.
      action: { type: "fill", prompt: 'Add these customer reviews to my site and show them on the homepage:\n1. "" — \n2. "" — ' },
    });
  }
  if (faq && Array.isArray(faq.items)) {
    add({
      id: "faq",
      title: "Answer common questions",
      why: "An FAQ answers what visitors would otherwise have to call and ask.",
      done: faq.items.length > 0,
      action: {
        type: "send",
        prompt: "Draft an FAQ for my site from what my pages already say, and show it on the homepage. Ask me about anything you're not sure of instead of guessing.",
      },
    });
  }

  // 8. Search results (from the last SEO check).
  if (seo?.report) {
    const missingSearchText = seo.report.pages.filter((p) => !p.draft && !p.fields.noindex && (!p.fields.metaTitle || !p.fields.metaDescription)).length;
    add({
      id: "seo",
      title: missingSearchText ? `Help ${missingSearchText} ${missingSearchText === 1 ? "page" : "pages"} show up better on Google` : "Every page has search text",
      why: "A clear title and description in search results brings more visitors.",
      done: !missingSearchText,
      action: { type: "send", prompt: "Write search titles and descriptions for every page that doesn't have them yet." },
    });
  }

  // Not part of the site itself: changes waiting to go live.
  if (status.changes?.length) {
    steps.unshift({
      id: "publish",
      title: "Publish your changes",
      why: "Your latest changes aren't live yet. Visitors see them once you publish.",
      done: false,
      counts: false,
      action: { type: "open", section: "publish" },
    });
  }

  const counted = steps.filter((s) => s.counts);
  const pagesToWrite = pages.filter((p) => p !== home).length;
  return {
    steps: steps.map(({ counts, ...step }) => ({ ...step, counts })),
    // Each page besides the homepage is one item, written or not, like each other step.
    progress: {
      done: counted.filter((s) => s.done).length + pagesToWrite - others.length,
      total: counted.length + pagesToWrite,
    },
    // The link check runs after each build; without it, links and pages nothing links to are unknown.
    linksChecked: Boolean(report),
  };
}
