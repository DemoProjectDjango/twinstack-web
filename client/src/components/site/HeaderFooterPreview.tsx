"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import type { BrandInfo, NavAppearance, Navigation, NavigationInfo, NavItem } from "@/lib/site-api";
import { linkStatus, type PageIndex } from "./header-footer";

// The site template's header and footer colours (templates/partials/header.html and footer.html:
// Tailwind's zinc greys and the accent in styles/main.css → @theme --color-brand). A copy that
// changed them looks different once built; the Build & preview tab shows the real thing.
const C = {
  ink: "#09090b",
  ink2: "#52525b",
  brand: "#0f766e",
  onDark: "rgb(255 255 255 / 0.75)",
  mist: "#f4f4f5",
  footerLight: "#fafafa",
  line: "#e4e4e7",
  lineStrong: "#d4d4d8",
  muted: "#71717a",
  footerLink: "#a1a1aa",
  rule: "rgb(255 255 255 / 0.1)",
};

const HEADER_BG = { light: "#ffffff", dark: C.ink, brand: C.brand };
const FOOTER_STYLE = {
  dark: { background: C.ink, text: C.footerLink, link: C.footerLink, heading: "rgb(255 255 255 / 0.9)", rule: C.rule },
  light: { background: C.footerLight, text: C.muted, link: C.ink2, heading: C.ink, rule: C.line },
  brand: { background: C.brand, text: C.onDark, link: "rgb(255 255 255 / 0.8)", heading: "#ffffff", rule: "rgb(255 255 255 / 0.2)" },
};

type Props = {
  navigation: Navigation;
  info: NavigationInfo;
  brand: BrandInfo | null;
  pageIndex: PageIndex;
  device: "desktop" | "mobile";
  /** Whether the copy's templates show the appearance settings; if not, the template's own look is shown. */
  styled: boolean;
  selected: string | null;
  onSelect: (target: string) => void;
};

/** What a menu entry shows once built: collection menus list their pages, links to missing pages are left out. */
function shown(item: NavItem, info: NavigationInfo, index: PageIndex) {
  const children =
    item.type === "collection"
      ? info.pages
          .filter((page) => page.collection === item.collection && !page.draft)
          .slice(0, item.limit ?? 8)
          .map((page) => ({ label: page.title, url: page.url, missing: false }))
      : (item.children ?? []).map((child) => ({ label: child.label, url: child.url, missing: linkStatus(child.url, index) !== "ok" }));
  const visibleChildren = children.filter((child) => !child.missing);
  const ownMissing = Boolean(item.url) && linkStatus(item.url, index) !== "ok";
  return { children: visibleChildren, leftOut: (ownMissing || (!item.url && item.type !== "collection")) && visibleChildren.length === 0 };
}

// The footer's social icons, as letters in the preview (the site draws the brands' icons).
const SOCIAL_SHORT: Record<string, string> = { linkedin: "in", x: "X", facebook: "f", instagram: "ig", youtube: "yt", github: "gh" };

// What a copy whose templates predate the appearance settings shows.
const TEMPLATE_LOOK: NavAppearance = {
  header: { theme: "light", layout: "right", sticky: true },
  footer: { theme: "dark", showTagline: true, showContact: true, copyright: "" },
};

const ring = (on: boolean): CSSProperties => (on ? { outline: "2px dashed #f59e0b", outlineOffset: 3, borderRadius: 4 } : {});

function Hit({ target, selected, onSelect, title, className = "", style, children }: {
  target: string;
  selected: string | null;
  onSelect: (target: string) => void;
  title?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title ?? "Click to edit"}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(target);
      }}
      className={`cursor-pointer text-left ${className}`}
      style={{ ...style, ...ring(selected === target) }}
    >
      {children}
    </button>
  );
}

function Logo({ brand, onDark, color }: { brand: BrandInfo | null; onDark: boolean; color: string }) {
  const logo = onDark ? (brand?.brand.logoDark && brand.previews.logoDark) || (brand?.brand.logo && brand.previews.logo) : brand?.brand.logo && brand.previews.logo;
  const name = brand?.brand.logoText || "Your site";
  if (logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo} alt={name} className="block h-8 w-auto max-w-44 object-contain" />;
  }
  return (
    <span className="inline-flex items-center gap-2 text-lg font-bold tracking-tight" style={{ color }}>
      {brand?.previews.logoMark ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brand.previews.logoMark} alt="" className="size-6" />
      ) : (
        <span className="size-6 rounded-lg" style={{ background: onDark ? "#ffffff" : C.brand }} />
      )}
      {name}
    </span>
  );
}

function SocialIcons({ names, color, rule }: { names: string[]; color: string; rule: string }) {
  return (
    <span className="flex gap-1.5">
      {names.map((name) => (
        <span key={name} className="grid size-6 place-items-center rounded-full border text-[0.55rem] font-bold" style={{ color, borderColor: rule }}>
          {SOCIAL_SHORT[name] ?? name.slice(0, 2)}
        </span>
      ))}
    </span>
  );
}

export function HeaderFooterPreview({ navigation, info, brand, pageIndex, device, styled, selected, onSelect }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const look: NavAppearance = styled ? navigation.appearance : TEMPLATE_LOOK;
  // The newer styles (templates/partials/header.html and footer.html): only copies that have them.
  const newer = styled && info.supportsStyles === true;
  const floating = newer && look.header.style === "floating";
  const footerLayout = newer ? (look.footer.layout ?? "columns") : "columns";
  const social = newer && look.footer.showSocial !== false ? (info.site.social ?? []) : [];
  const footerCta = newer && look.footer.cta?.label ? look.footer.cta : null;
  const headerNotes = [
    look.header.sticky && "Stays at the top when scrolling",
    newer && look.header.transparent && "See-through over the top of the page",
    newer && look.header.shrink && "Gets lower when scrolled",
  ].filter(Boolean);
  const mobile = device === "mobile";
  const headerDark = look.header.theme !== "light";
  const itemColor = headerDark ? C.onDark : C.ink2;
  const cta = navigation.header.cta;
  const footer = FOOTER_STYLE[look.footer.theme];
  const footerDark = look.footer.theme !== "light";
  const items = navigation.header.items.map((item, i) => ({ item, i, ...shown(item, info, pageIndex) }));

  const ctaButton = cta && (
    <Hit
      target="cta"
      selected={selected}
      onSelect={onSelect}
      title={linkStatus(cta.url, pageIndex) !== "ok" ? "Left out of the built site: no page at this address yet. Click to edit." : undefined}
      className={`rounded-full px-4 py-2 text-sm font-semibold ${mobile ? "mt-4 w-full text-center" : ""} ${linkStatus(cta.url, pageIndex) !== "ok" ? "line-through opacity-40" : ""}`}
      style={headerDark ? { background: "#ffffff", color: C.ink } : { background: C.ink, color: "#ffffff" }}
    >
      {cta.label || "Button"}
    </Hit>
  );

  const menu = items.map(({ item, i, children, leftOut }) => (
    <li key={i} className={mobile ? "" : "group relative"}>
      <Hit
        target={`h${i}`}
        selected={selected}
        onSelect={onSelect}
        title={leftOut ? "Left out of the built site: no page at this address yet. Click to edit." : undefined}
        className={`inline-flex items-center gap-1 text-sm font-medium ${mobile ? "w-full border-b py-2.5" : "rounded-full px-3 py-2"} ${leftOut ? "line-through opacity-40" : ""}`}
        style={{ color: itemColor, borderColor: headerDark ? "rgb(255 255 255 / 0.15)" : C.line }}
      >
        {item.label || "Untitled"}
        {children.length > 0 && !mobile && <span aria-hidden className="text-[0.6rem] opacity-60">▼</span>}
      </Hit>
      {children.length > 0 &&
        (mobile ? (
          <ul className="pb-1 pl-4">
            {children.map((child, c) => (
              <li key={c} className="py-1 text-sm" style={{ color: headerDark ? C.onDark : C.ink }}>
                {child.label}
              </li>
            ))}
          </ul>
        ) : (
          <ul
            className="absolute left-0 top-full z-20 hidden min-w-52 rounded-2xl border bg-white p-1.5 shadow-xl group-hover:block"
            style={{ borderColor: C.line }}
          >
            {children.map((child, c) => (
              <li key={c} className="rounded-xl px-2.5 py-1.5 text-sm font-medium" style={{ color: C.ink }}>
                {child.label}
              </li>
            ))}
          </ul>
        ))}
    </li>
  ));

  const year = new Date().getFullYear();
  const footerLinks = (links: NavItem[]) =>
    links.flatMap((link, l) =>
      link.type === "collection" && !link.label
        ? info.pages
            .filter((page) => page.collection === link.collection && !page.draft)
            .slice(0, link.limit ?? 8)
            .map((page) => ({ key: `${l}-${page.url}`, label: page.title, leftOut: false }))
        : [{ key: String(l), label: link.label || "Untitled", leftOut: linkStatus(link.url, pageIndex) !== "ok" }],
    );

  return (
    <div className={`overflow-hidden rounded-lg border border-zinc-300 bg-white dark:border-zinc-700 ${mobile ? "mx-auto max-w-sm" : ""}`}>
      {/* Header */}
      <div
        className={`relative ${floating ? "p-2" : "border-b"}`}
        style={floating ? undefined : { background: HEADER_BG[look.header.theme], borderColor: look.header.theme === "light" ? C.line : C.rule }}
      >
        <div
          className={`flex h-14 items-center gap-4 px-4 ${floating ? "rounded-xl border shadow-md" : ""}`}
          style={floating ? { background: HEADER_BG[look.header.theme], borderColor: look.header.theme === "light" ? C.line : C.rule } : undefined}
        >
          <Hit target="header-look" selected={selected} onSelect={onSelect} title="Logo and name: change them on Site info. Click to edit the header's look.">
            <Logo brand={brand} onDark={headerDark} color={headerDark ? "#ffffff" : C.ink} />
          </Hit>
          {mobile ? (
            <button
              type="button"
              aria-label={menuOpen ? "Close the preview menu" : "Open the preview menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="ml-auto rounded-full border px-2 py-1.5"
              style={{ borderColor: headerDark ? "rgb(255 255 255 / 0.35)" : C.lineStrong }}
            >
              {[0, 1, 2].map((bar) => (
                <span key={bar} className={`block h-0.5 w-4 ${bar ? "mt-1" : ""}`} style={{ background: headerDark ? "#ffffff" : C.ink }} />
              ))}
            </button>
          ) : (
            <>
              {look.header.layout !== "left" && <span className="flex-1" />}
              <ul className="flex items-center gap-0.5">{menu}</ul>
              {look.header.layout !== "right" && <span className="flex-1" />}
              {ctaButton}
            </>
          )}
        </div>
        {mobile && menuOpen && (
          <ul className="border-t px-4 pb-5" style={{ borderColor: headerDark ? "rgb(255 255 255 / 0.15)" : C.line }}>
            {menu}
            {ctaButton && <li>{ctaButton}</li>}
          </ul>
        )}
        {headerNotes.length > 0 && (
          <span className="pointer-events-none absolute -bottom-5 right-2 text-[0.65rem] text-zinc-400">{headerNotes.join(" · ")}</span>
        )}
      </div>

      {/* Page body stand-in */}
      <div className="space-y-2 px-4 py-8">
        <div className="h-5 w-1/2 rounded" style={{ background: C.mist }} />
        <div className="h-3 w-5/6 rounded" style={{ background: C.mist }} />
        <div className="h-3 w-2/3 rounded" style={{ background: C.mist }} />
      </div>

      {/* Footer */}
      <div className="px-4 pb-4 pt-8 text-sm" style={{ background: footer.background, color: footer.text, borderTop: footerDark ? undefined : `1px solid ${C.line}` }}>
        {footerCta && (
          <Hit
            target="footer-look"
            selected={selected}
            onSelect={onSelect}
            title="Click to edit the call-to-action strip"
            className={`mb-6 flex w-full gap-3 rounded-xl p-4 ${mobile || footerLayout === "centered" ? "flex-col items-center text-center" : "items-center justify-between"}`}
            style={{ background: footerDark ? "rgb(255 255 255 / 0.06)" : "#ffffff", border: `1px solid ${footer.rule}` }}
          >
            <span>
              {footerCta.title && <span className="block text-base font-semibold" style={{ color: footer.heading }}>{footerCta.title}</span>}
              {footerCta.text && <span className="block text-xs">{footerCta.text}</span>}
            </span>
            <span
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${linkStatus(footerCta.url, pageIndex) !== "ok" ? "line-through opacity-50" : ""}`}
              style={footerDark ? { background: "#ffffff", color: C.ink } : { background: C.ink, color: "#ffffff" }}
            >
              {footerCta.label}
            </span>
          </Hit>
        )}
        <div
          className={footerLayout === "minimal" ? "hidden" : footerLayout === "centered" ? "flex flex-col items-center gap-6 text-center" : "grid gap-6"}
          style={footerLayout === "columns" ? { gridTemplateColumns: mobile ? "1fr" : `1.3fr repeat(${Math.max(navigation.footer.length, 1)}, minmax(0, 1fr))` } : undefined}
        >
          <Hit
            target="footer-look"
            selected={selected}
            onSelect={onSelect}
            className={`flex flex-col gap-2 self-start ${footerLayout === "centered" ? "items-center self-center" : ""}`}
            title="Click to edit the footer's look"
          >
            <Logo brand={brand} onDark={footerDark} color={footer.heading} />
            {look.footer.showTagline && (
              <span className="max-w-[34ch] text-xs leading-relaxed">
                {info.site.footerTagline}
                {info.site.foundedYear ? ` Since ${info.site.foundedYear}.` : ""}
              </span>
            )}
            {look.footer.showContact && (
              <span className="text-xs leading-relaxed" style={{ color: footer.link }}>
                {info.site.email}
                <br />
                {info.site.phone}
              </span>
            )}
            {social.length > 0 && <SocialIcons names={social} color={footer.link} rule={footer.rule} />}
          </Hit>
          {/* Centred, the columns sit side by side under the logo. */}
          <div className={footerLayout === "centered" ? "flex flex-wrap justify-center gap-8" : "contents"}>
          {navigation.footer.map((column, i) => {
            const links = footerLinks(column.links);
            const empty = links.every((link) => link.leftOut);
            return (
              <Hit
                key={i}
                target={`f${i}`}
                selected={selected}
                onSelect={onSelect}
                className={`self-start ${empty ? "opacity-40" : ""}`}
                title={empty ? "Left out of the built site: none of its links lead to a page yet. Click to edit." : undefined}
              >
                <span className="mb-2 block text-[0.65rem] font-semibold uppercase tracking-widest" style={{ color: footer.heading }}>
                  {column.title || "Untitled column"}
                </span>
                <span className="grid gap-1">
                  {links.map((link) => (
                    <span key={link.key} className={`text-xs ${link.leftOut ? "line-through opacity-50" : ""}`} style={{ color: footer.link }}>
                      {link.label}
                    </span>
                  ))}
                  {links.length === 0 && <span className="text-xs italic opacity-70">No links</span>}
                </span>
              </Hit>
            );
          })}
          </div>
        </div>
        <div
          className={`flex flex-wrap items-center gap-3 text-xs ${footerLayout === "minimal" ? "" : "mt-6 border-t pt-3"} ${footerLayout === "centered" ? "flex-col justify-center" : "justify-between"}`}
          style={{ borderColor: footer.rule }}
        >
          <Hit target="footer-look" selected={selected} onSelect={onSelect} title="Click to edit the copyright line" className="flex items-center gap-3">
            {footerLayout === "minimal" && <Logo brand={brand} onDark={footerDark} color={footer.heading} />}
            <span>© {year} {look.footer.copyright || `${info.site.name}. All rights reserved.`}</span>
          </Hit>
          {footerLayout === "minimal" && social.length > 0 && <SocialIcons names={social} color={footer.link} rule={footer.rule} />}
          <Hit target="legal" selected={selected} onSelect={onSelect} className="flex flex-wrap gap-3" title="Click to edit the legal links">
            {navigation.legal.length ? (
              navigation.legal.map((link, i) => (
                <span key={i} className={linkStatus(link.url, pageIndex) !== "ok" ? "line-through opacity-50" : ""} style={{ color: footer.link }}>
                  {link.label || "Untitled"}
                </span>
              ))
            ) : (
              <span className="italic opacity-70">No legal links</span>
            )}
          </Hit>
        </div>
      </div>
    </div>
  );
}
