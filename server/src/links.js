// Links as people write them, made into ones the site can use. Shared by the header and footer
// (navigation.js), the site details (static-info.js) and the assistant's checks (assistant/tools.js).

/**
 * A web address without https:// ("instagram.com/x", "www.x.com", "wa.me/880…") gets it, an email
 * address becomes mailto:, a phone number tel: (its spaces and dashes taken out, as in an existing
 * tel: link). Anything else is returned as given (trimmed), for the caller to accept or refuse.
 */
export function normalizeLink(value) {
  const trimmed = String(value ?? "").trim();
  if (/^tel:/i.test(trimmed)) return `tel:${trimmed.slice(4).replace(/[^\d+]/g, "")}`;
  if (/^(\/|#|mailto:|https?:\/\/)/i.test(trimmed)) return trimmed;
  if (/^[^\s@/]+@[^\s@/]+\.[a-z]{2,}$/i.test(trimmed)) return `mailto:${trimmed}`;
  if (/^\+?[\d\s().-]{6,}$/.test(trimmed) && /\d{6,}/.test(trimmed.replace(/\D/g, ""))) return `tel:${trimmed.replace(/[^\d+]/g, "")}`;
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

/** A web address for a field that only takes one (a social profile, a booking page): https:// added. */
export function webLink(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return trimmed;
  const link = normalizeLink(trimmed);
  return /^https:\/\//.test(link) ? link : trimmed;
}

/** A WhatsApp chat link from a phone number (or a wa.me address as given). */
export function whatsappLink(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (/^\+?[\d\s().-]{6,}$/.test(trimmed) && digits.length >= 6) return `https://wa.me/${digits}`;
  return webLink(trimmed);
}

const hasExtension = (url) => /\.[a-z0-9]+$/i.test(url.split("/").pop() ?? "");
// A page's address as the file it builds: "/pricing" and "/pricing/" are both pricing/index.html.
const asBuilt = (url) => (url.endsWith("/") || hasExtension(url) ? url : `${url}/`);

/**
 * The page an internal link reaches, given every page's address, the way GitHub Pages serves them:
 * "/about" reaches the page at /about/ or, without one, /about.html; "/about/" and "/about.html"
 * only reach themselves; "/x/index.html" is the page at /x/. Null when no page is there.
 */
export function pageForLink(href, pages) {
  const bare = href.split(/[#?]/)[0].replace(/(^|\/)index\.html$/i, "$1") || "/";
  const candidates = bare.endsWith("/") || hasExtension(bare) ? [bare] : [`${bare}/`, `${bare}.html`];
  for (const candidate of candidates) {
    const page = pages.find((p) => asBuilt(p.url) === candidate);
    if (page) return page;
  }
  return null;
}
