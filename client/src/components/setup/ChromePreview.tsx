"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useFileUrl } from "./use-file-url";
import type { ChromeChoice } from "@/lib/setup";

// A live picture of the site's standard header and footer for the setup's "Your header and footer"
// step, before the site exists: drawn from the answers and the owner's choices, in the template's
// own colours (templates/partials/header.html and footer.html: Tailwind's zinc greys and the accent
// as --color-brand). It's laid out at a computer's or a phone's width and scaled to fit the window,
// can show the header scrolled (slimmer, solid) or at the top (see-through), opens the phone menu,
// and tells the step which part was clicked (`onPick`) so its control can be shown.
// Keep it in step with those partials and the editor's HeaderFooterPreview.tsx.

const INK = "#09090b";
const INK2 = "#52525b";
const LINE = "#e4e4e7";
const MIST = "#f4f4f5";
const WIDTHS = { desktop: 900, phone: 380 };

export type ChromePreviewData = {
  name: string;
  tagline: string;
  /** The pages being made (not legal ones): what the footer's auto column lists. */
  pages: string[];
  /** The header button's words, or null for none. */
  button: string | null;
  contact: { phone?: string; email?: string; address?: string; hours?: string };
  social: string[];
  legal: string[];
  /** The owner's logo, when they gave one. */
  logo: File | null;
};
export type PreviewPick = { kind: "logo" | "menu" | "button" | "column" | "brand" | "cta" | "copyright"; id?: string };

const SOCIAL_SHORT: Record<string, string> = { instagram: "ig", facebook: "f", linkedin: "in", x: "X", youtube: "yt" };


/** The square mark: the business's initial on the accent (the mark the build makes). */
function Mark({ initial, accent, size, onColour }: { initial: string; accent: string; size: number; onColour: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center font-bold text-white"
      style={{ width: size, height: size, borderRadius: size * 0.28, fontSize: size * 0.5, background: onColour ? "rgb(255 255 255 / 0.2)" : `linear-gradient(135deg, color-mix(in srgb, ${accent} 70%, white), ${accent})` }}
    >
      {initial}
    </span>
  );
}

const ICONS: Record<string, ReactNode> = {
  phone: <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />,
  email: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  address: (
    <>
      <path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z" />
      <circle cx="12" cy="9" r="2.5" />
    </>
  ),
  hours: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
};

/** The preview, with its own computer/phone and top/scrolled switches. */
export function ChromePreview({ data, choice, onPick }: { data: ChromePreviewData; choice: ChromeChoice; onPick?: (pick: PreviewPick) => void }) {
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 1, height: 0 });
  const logoUrl = useFileUrl(data.logo);
  const width = WIDTHS[device];

  // Scaled to the window's width; the frame takes the scaled height.
  useLayoutEffect(() => {
    const measure = () => {
      if (!frame.current || !inner.current) return;
      const scale = Math.min(1, frame.current.clientWidth / width);
      setFit({ scale, height: inner.current.offsetHeight * scale });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (frame.current) observer.observe(frame.current);
    if (inner.current) observer.observe(inner.current);
    return () => observer.disconnect();
  }, [width]);

  const { accent } = choice;
  const phone = device === "phone";
  const hit = (p: PreviewPick, extra: CSSProperties = {}) => ({
    onClick: () => onPick?.(p),
    style: extra,
    className: onPick ? "cursor-pointer rounded-md hover:outline-2 hover:outline-offset-2 hover:outline-dashed hover:outline-amber-500" : "",
  });

  // See-through over the top of the page until it's scrolled; slimmer once scrolled.
  const see = choice.transparent && !scrolled;
  const onDark = choice.headerTheme !== "light" || see;
  const headerBg = see ? "transparent" : { light: "rgb(255 255 255 / 0.92)", dark: INK, brand: accent }[choice.headerTheme];
  const headerRule = see ? "transparent" : choice.headerTheme !== "light" ? "rgb(255 255 255 / 0.12)" : LINE;
  const linkColor = onDark ? "rgb(255 255 255 / 0.82)" : INK2;
  const floating = choice.headerStyle === "floating";
  const height = choice.shrink && scrolled ? 46 : 58;
  const initial = (data.name.match(/[\p{L}\p{N}]/u)?.[0] ?? "Y").toUpperCase();
  const items = choice.menu.filter((m) => m.on);

  const brand = (color: string, size: number, onColour: boolean) => {
    if (choice.logo === "image" && logoUrl) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={logoUrl} alt={data.name} className="block w-auto max-w-44 object-contain" style={{ height: size + 4 }} />;
    }
    return (
      <span className="inline-flex min-w-0 items-center gap-2 font-bold tracking-tight" style={{ color, fontSize: size > 22 ? 15 : 13 }}>
        {choice.logo !== "name" && <Mark initial={initial} accent={accent} size={size} onColour={onColour} />}
        <span className="truncate">{data.name || "Your site"}</span>
      </span>
    );
  };
  const buttonStyle: CSSProperties = onDark ? { background: "#ffffff", color: INK } : { background: accent, color: "#ffffff", boxShadow: `0 6px 14px -8px ${accent}` };
  const lines = (open: boolean) => {
    const bar: CSSProperties = { background: onDark ? "#ffffff" : INK };
    return open ? (
      <span className="relative block size-4">
        <span className="absolute left-0 top-[7px] block h-0.5 w-4 rotate-45 rounded-full" style={bar} />
        <span className="absolute left-0 top-[7px] block h-0.5 w-4 -rotate-45 rounded-full" style={bar} />
      </span>
    ) : (
      <span className="grid gap-[5px]">
        <span className="block h-0.5 w-4 rounded-full" style={bar} />
        <span className="block h-0.5 w-4 rounded-full" style={bar} />
      </span>
    );
  };

  const header = (
    <div className={see ? "absolute inset-x-0 top-0 z-10" : ""} style={floating ? { padding: "10px 10px 0" } : { background: headerBg, borderBottom: `1px solid ${headerRule}` }}>
      <div
        className="flex items-center gap-2.5 px-4 transition-[height]"
        style={{ height, ...(floating ? { background: headerBg, border: `1px solid ${headerRule}`, borderRadius: 16, boxShadow: see ? undefined : "0 10px 24px -14px rgb(0 0 0 / 0.3)" } : {}) }}
      >
        <span {...hit({ kind: "logo" })}>{brand(onDark ? "#ffffff" : INK, height < 50 ? 22 : 26, choice.headerTheme === "brand" && !see)}</span>
        {phone ? (
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={menuOpen ? "Close the preview's menu" : "Open the preview's menu"}
            className="ml-auto grid size-9 place-items-center rounded-full border"
            style={{ borderColor: onDark ? "rgb(255 255 255 / 0.3)" : LINE }}
          >
            {lines(menuOpen)}
          </button>
        ) : (
          <>
            {choice.headerLayout !== "left" && <span className="flex-1" />}
            <span className="flex">
              {items.map((m) => (
                <span key={m.id} {...hit({ kind: "menu", id: m.id }, { color: linkColor })}>
                  <span className="block whitespace-nowrap rounded-full px-2.5 py-1.5 text-[13px] font-medium">{m.label}</span>
                </span>
              ))}
            </span>
            {choice.headerLayout !== "right" && <span className="flex-1" />}
            {data.button && (
              <span {...hit({ kind: "button" })}>
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full text-[13px] font-semibold" style={{ ...buttonStyle, padding: height < 50 ? "6px 12px" : "8px 14px" }}>
                  {data.button} <span aria-hidden="true">→</span>
                </span>
              </span>
            )}
          </>
        )}
      </div>
      {phone && menuOpen && (
        <div className="bg-white px-4.5 pb-4.5 pt-1.5 shadow-xl" style={{ margin: floating ? "8px 0 0" : 0, borderRadius: floating ? 16 : "0 0 18px 18px" }}>
          {items.map((m) => (
            <span key={m.id} {...hit({ kind: "menu", id: m.id })}>
              <span className="block border-b py-3 text-[15px]" style={{ borderColor: LINE, color: INK }}>
                {m.label}
              </span>
            </span>
          ))}
          {data.button && (
            <span className="mt-3.5 block rounded-full py-2.5 text-center text-sm font-semibold text-white" style={{ background: accent }}>
              {data.button} →
            </span>
          )}
        </div>
      )}
    </div>
  );

  const footerOnDark = choice.footerTheme !== "light";
  const footer = {
    dark: { bg: INK, text: "#a1a1aa", heading: "#ffffff", rule: "rgb(255 255 255 / 0.1)" },
    light: { bg: "#fafafa", text: "#71717a", heading: INK, rule: LINE },
    brand: { bg: accent, text: "rgb(255 255 255 / 0.82)", heading: "#ffffff", rule: "rgb(255 255 255 / 0.2)" },
  }[choice.footerTheme];
  const layout = choice.footerLayout;
  const centred = layout === "centered";
  const contactRows = choice.contact ? (["phone", "email", "address", "hours"] as const).filter((k) => data.contact[k]) : [];
  const social = choice.social ? data.social : [];
  const strip = choice.cta && data.button;

  const socialIcons = social.length > 0 && (
    <span className={`flex gap-1.5 ${centred ? "justify-center" : ""}`}>
      {social.map((name) => (
        <span key={name} className="grid size-7 place-items-center rounded-full text-[10px] font-bold" style={{ color: footer.text, boxShadow: `inset 0 0 0 1px ${footer.rule}` }}>
          {SOCIAL_SHORT[name] ?? name.slice(0, 2)}
        </span>
      ))}
    </span>
  );
  const brandBlock = (
    <span {...hit({ kind: "brand" })}>
      <span className={`grid content-start gap-2.5 ${centred ? "justify-items-center" : ""}`}>
        {brand(footer.heading, 26, choice.footerTheme === "brand")}
        {choice.tagline && data.tagline && <span className="max-w-[34ch] leading-relaxed">{data.tagline}</span>}
        {contactRows.length > 0 && (
          <span className="grid gap-1.5">
            {contactRows.map((k) => (
              <span key={k} className={`flex items-start gap-2 ${centred ? "justify-center" : ""}`} style={{ color: footerOnDark ? "#d4d4d8" : "#3f3f46" }}>
                <svg viewBox="0 0 24 24" className="mt-0.5 size-3.5 shrink-0 opacity-70" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {ICONS[k]}
                </svg>
                {data.contact[k]}
              </span>
            ))}
          </span>
        )}
        {socialIcons}
      </span>
    </span>
  );
  const columns = choice.columns.map((col) => {
    const links = [...(col.auto ? ["Home", ...data.pages] : []), ...col.links.map((l) => l.label).filter((l) => l.trim())];
    return (
      <span key={col.id} {...hit({ kind: "column", id: col.id })}>
        <span className={`grid content-start gap-1.5 ${centred ? "justify-items-center" : ""}`}>
          <span className="mb-0.5 text-[13px] font-semibold" style={{ color: footer.heading }}>
            {col.title || "Untitled"}
          </span>
          {links.length ? links.map((label, i) => <span key={i}>{label}</span>) : <span className="italic opacity-60">No links yet</span>}
        </span>
      </span>
    );
  });
  const gridStyle: CSSProperties = phone
    ? { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 22 }
    : { display: "grid", gridTemplateColumns: `1.5fr repeat(${Math.max(1, choice.columns.length)}, minmax(0, 1fr))`, gap: 22 };

  const footerBlock = (
    <div className="relative overflow-hidden px-5 pb-4.5 pt-8.5 text-[12px]" style={{ background: footer.bg, color: footer.text, borderTop: footerOnDark ? undefined : `1px solid ${LINE}` }}>
      {choice.footerTheme === "dark" && (
        <>
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />
          <span aria-hidden="true" className="pointer-events-none absolute -left-16 -top-24 size-56 rounded-full blur-3xl" style={{ background: accent, opacity: 0.25 }} />
        </>
      )}
      <div className="relative">
        {strip && (
          <span {...hit({ kind: "cta" })}>
            <span
              className={`mb-6.5 flex gap-3 rounded-2xl p-4 ${phone || centred ? "flex-col items-center text-center" : "items-center justify-between"}`}
              style={{ background: footerOnDark ? `linear-gradient(135deg, color-mix(in srgb, ${accent} 30%, transparent), rgb(255 255 255 / 0.05))` : "#ffffff", boxShadow: `inset 0 0 0 1px ${footer.rule}` }}
            >
              <span>
                <span className="block text-[15px] font-semibold" style={{ color: footer.heading }}>
                  {data.name || "Your site"}
                </span>
                {data.tagline && <span className="mt-0.5 block">{data.tagline}</span>}
              </span>
              <span className="shrink-0 rounded-full px-3.5 py-2 text-[12px] font-semibold" style={footerOnDark ? { background: "#ffffff", color: INK } : { background: accent, color: "#ffffff" }}>
                {data.button}
              </span>
            </span>
          </span>
        )}
        {layout !== "minimal" &&
          (centred ? (
            <div className="flex flex-col items-center gap-4.5 text-center">
              {brandBlock}
              <div className="flex flex-wrap justify-center gap-7.5">{columns}</div>
            </div>
          ) : (
            <div style={gridStyle}>
              {phone ? <span style={{ gridColumn: "1 / -1" }}>{brandBlock}</span> : brandBlock}
              {columns}
            </div>
          ))}
        <span {...hit({ kind: "copyright" })}>
          <span
            className={`flex flex-wrap items-center gap-2.5 text-[11px] ${layout === "minimal" ? "" : "mt-5.5 border-t pt-3"} ${centred ? "flex-col justify-center" : "justify-between"}`}
            style={{ borderColor: footer.rule }}
          >
            <span className="flex items-center gap-2">
              {layout === "minimal" && brand(footer.heading, 20, choice.footerTheme === "brand")}© {new Date().getFullYear()} {choice.copyright.trim() || `${data.name || "Your site"}. All rights reserved.`}
            </span>
            <span className="flex flex-wrap items-center gap-3">
              {data.legal.map((label) => (
                <span key={label}>{label}</span>
              ))}
              {layout === "minimal" && socialIcons}
            </span>
          </span>
        </span>
      </div>
    </div>
  );

  // The page between them: soft blocks with a button in the accent, on a photo when the header is see-through.
  const body = (
    <div className="grid gap-2.5 px-5 pb-7" style={{ paddingTop: see ? 96 : 28, background: see ? "linear-gradient(160deg, #3b1d0b, #8a3a12 60%, #e0832f)" : undefined }}>
      <span className="h-5 w-3/5 rounded-md" style={{ background: see ? "rgb(255 255 255 / 0.35)" : MIST }} />
      <span className="h-3 w-4/5 rounded" style={{ background: see ? "rgb(255 255 255 / 0.25)" : MIST }} />
      <span className="h-3 w-2/3 rounded" style={{ background: see ? "rgb(255 255 255 / 0.25)" : MIST }} />
      <span className="mt-1 h-8 w-32 rounded-full" style={{ background: accent }} />
    </div>
  );

  const segClass = (on: boolean) => `rounded-md px-2.5 py-1 ${on ? "bg-background font-semibold shadow-sm" : "text-zinc-500"}`;
  return (
    // min-w-0: inside a grid or flex parent, the full-width drawing mustn't widen the frame it's scaled to.
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-zinc-500">Preview{onPick ? ": click a part to edit it" : ""}</span>
        <div role="group" aria-label="Scroll position" className="ml-auto flex rounded-lg bg-zinc-100 p-0.5 text-xs dark:bg-zinc-900">
          {[false, true].map((s) => (
            <button key={String(s)} type="button" aria-pressed={scrolled === s} onClick={() => setScrolled(s)} className={segClass(scrolled === s)}>
              {s ? "Scrolled" : "Top"}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Preview size" className="flex rounded-lg bg-zinc-100 p-0.5 text-xs dark:bg-zinc-900">
          {(["desktop", "phone"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={device === d}
              onClick={() => {
                setDevice(d);
                setMenuOpen(false);
              }}
              className={segClass(device === d)}
            >
              {d === "desktop" ? "Computer" : "Phone"}
            </button>
          ))}
        </div>
      </div>
      <div ref={frame} className="w-full overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800" style={{ height: fit.height || undefined }}>
        <div ref={inner} className="relative origin-top-left text-left" style={{ width, transform: `scale(${fit.scale})`, margin: phone && fit.scale === 1 ? "0 auto" : undefined, color: INK }}>
          {header}
          {body}
          {footerBlock}
        </div>
      </div>
      {choice.mode === "design" && <p className="mt-2 text-xs text-zinc-500">The AI designs its own look after your homepage; this shows your choices as its starting point.</p>}
    </div>
  );
}
