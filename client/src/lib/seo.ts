// How search results measure a title and description, for the SEO tab's live preview while the
// user types. A copy of the site template's scripts/lib/seo.js (its width table, LIMITS,
// truncateToWidth and hasKeyword): keep the two in step. The saved audit, from the copy's own
// script, stays the authority.

import type { SeoFields, SeoPage } from "./site-api";

// Arial advance widths for the printable ASCII range (space to ~), in 1/1000 em.
const ASCII_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const OTHER_WIDTHS: Record<string, number> = {
  "–": 556, "—": 1000, "‘": 222, "’": 222, "“": 333, "”": 333, "…": 1000, "·": 278, "•": 350, "©": 737, "®": 737, "™": 1000, "£": 556, "€": 556,
};

function charWidth(char: string) {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 32 && code <= 126) return ASCII_WIDTHS[code - 32];
  if (OTHER_WIDTHS[char]) return OTHER_WIDTHS[char];
  return code >= 0x2e80 ? 1000 : 556;
}

/** The text's width in pixels at this font size. */
export function textWidth(text: string, sizePx: number) {
  let units = 0;
  for (const char of text || "") units += charWidth(char);
  return Math.round((units * sizePx) / 1000);
}

export const LIMITS = {
  titleSize: 20,
  titlePx: 600,
  titleMinChars: 30,
  descriptionSize: 13,
  descriptionPx: 920,
  descriptionMinChars: 70,
};

/** The text as a search result shows it: cut at a word to fit maxPx, with "..." after. */
export function truncateToWidth(text: string, sizePx: number, maxPx: number) {
  const value = (text || "").replace(/\s+/g, " ").trim();
  if (textWidth(value, sizePx) <= maxPx) return { text: value, cut: false };
  const room = maxPx - textWidth(" ...", sizePx);
  let out = "";
  for (const char of value) {
    if (textWidth(out + char, sizePx) > room) break;
    out += char;
  }
  const atWord = out.replace(/\s+\S*$/, "");
  return { text: `${(atWord.length > out.length * 0.6 ? atWord : out).replace(/[\s,;:.–—-]+$/, "")} ...`, cut: true };
}

const normalise = (text: string) => ` ${(text || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** Whether the text has the phrase, or failing that every one of its words. */
export function hasKeyword(text: string, keyword: string) {
  const phrase = normalise(keyword).trim();
  if (!phrase) return false;
  const haystack = normalise(text);
  if (haystack.includes(` ${phrase} `)) return true;
  const words = phrase.split(" ").filter((w) => w.length > 2);
  return words.length > 0 && words.every((w) => haystack.includes(` ${w} `));
}

/** What search engines would get with these fields: the page's own values over its defaults. */
export function effectiveSeo(page: SeoPage, fields: SeoFields) {
  return {
    title: fields.metaTitle.trim() || page.seo.defaultTitle,
    description: fields.metaDescription.trim() || page.seo.defaultDescription,
    socialTitle: fields.metaTitle.trim() || page.title,
  };
}

export type Meter = { px: number; max: number; chars: number; tone: "good" | "short" | "long" | "empty" };

export function titleMeter(text: string): Meter {
  const px = textWidth(text, LIMITS.titleSize);
  const tone = !text ? "empty" : px > LIMITS.titlePx ? "long" : text.length < LIMITS.titleMinChars ? "short" : "good";
  return { px, max: LIMITS.titlePx, chars: text.length, tone };
}

export function descriptionMeter(text: string): Meter {
  const px = textWidth(text, LIMITS.descriptionSize);
  const tone = !text ? "empty" : px > LIMITS.descriptionPx ? "long" : text.length < LIMITS.descriptionMinChars ? "short" : "good";
  return { px, max: LIMITS.descriptionPx, chars: text.length, tone };
}

/** Checks on the values being edited, before they're saved and the copy's script audits them. */
export function liveChecks(page: SeoPage, fields: SeoFields, others: SeoPage[]) {
  const seo = effectiveSeo(page, fields);
  const out: { ok: boolean; message: string }[] = [];
  const title = titleMeter(seo.title);
  const description = descriptionMeter(seo.description);
  out.push({ ok: title.tone === "good", message: title.tone === "long" ? "The title will be cut off." : title.tone === "short" ? "The title is short: 30 to 60 characters works best." : "The title fits." });
  out.push({
    ok: description.tone === "good",
    message:
      description.tone === "empty"
        ? "No description."
        : description.tone === "long"
          ? "The description will be cut off."
          : description.tone === "short"
            ? "The description is short: aim for 120 to 155 characters."
            : "The description fits.",
  });
  const keyword = fields.focusKeyword.trim();
  if (!keyword) out.push({ ok: false, message: "No focus keyphrase." });
  else {
    out.push({ ok: hasKeyword(seo.title, keyword), message: `The keyphrase is ${hasKeyword(seo.title, keyword) ? "" : "not "}in the title.` });
    out.push({ ok: hasKeyword(seo.description, keyword), message: `The keyphrase is ${hasKeyword(seo.description, keyword) ? "" : "not "}in the description.` });
  }
  const lower = (s: string) => s.trim().toLowerCase();
  const sameTitle = others.find((o) => o.file !== page.file && !o.fields.noindex && lower(o.seo.title) === lower(seo.title));
  if (sameTitle) out.push({ ok: false, message: `Same title as ${sameTitle.url}.` });
  const sameDescription = others.find((o) => o.file !== page.file && !o.fields.noindex && seo.description && lower(o.seo.description) === lower(seo.description));
  if (sameDescription) out.push({ ok: false, message: `Same description as ${sameDescription.url}.` });
  return out;
}
