"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  api,
  workspacePath,
  type BrandInfo,
  type FooterTheme,
  type HeaderTheme,
  type MenuLayout,
  type Navigation,
  type NavigationInfo,
  type NavItem,
  type NavLink,
  type WorkspaceStatus,
} from "@/lib/site-api";
import { HeaderFooterPreview } from "./HeaderFooterPreview";
import { JobLog } from "./JobLog";
import { kindOf, linkStatus, move, pageIndex, withKind, type ItemKind, type PageIndex } from "./header-footer";
import { useSite } from "./site-context";
import { Badge, Button, ErrorText, Field, Notice, Section, inputClass } from "./ui";

// Must match the limits in the server's navigation.js.
const MAX_ITEMS = 15;
const MAX_CHILDREN = 20;
const MAX_COLUMNS = 8;
const MAX_LINKS = 20;
const MAX_LEGAL = 10;

const PAGES_LIST = "header-footer-pages";

/**
 * The Header & footer tab: a live preview, and an editor for everything in
 * content/data/navigation.json (menu, dropdowns, button, footer columns, legal
 * links) plus how the header and footer look. Saving writes the file; building
 * shows the real result.
 */
export function HeaderFooterPanel() {
  const { owner, repo, busy, version, setStatus, run, job, showTab } = useSite();
  const [info, setInfo] = useState<NavigationInfo | null>(null);
  const [draft, setDraft] = useState<Navigation | null>(null);
  const [brand, setBrand] = useState<BrandInfo | null>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [stale, setStale] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const dirtyRef = useRef(false);

  const dirty = info !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(info.navigation);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const fetchAll = useCallback(
    () =>
      Promise.all([
        api<NavigationInfo>(workspacePath(owner, repo, "/navigation")),
        api<BrandInfo>(workspacePath(owner, repo, "/brand")).catch(() => null),
      ]),
    [owner, repo],
  );

  const apply = useCallback(([loaded, loadedBrand]: [NavigationInfo, BrandInfo | null], force: boolean) => {
    setBrand(loadedBrand);
    if (dirtyRef.current && !force) {
      // Keep the user's edits; only what's around them (pages, template support) is refreshed.
      setInfo((current) => (current ? { ...loaded, navigation: current.navigation, version: current.version } : loaded));
      return;
    }
    setInfo(loaded);
    setDraft(loaded.navigation);
    setStale(false);
  }, []);

  const load = useCallback(async (force = false) => apply(await fetchAll(), force), [apply, fetchAll]);

  // Reloaded after every command (a Claude run or a new section may change navigation.json) unless there are unsaved edits.
  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then((result) => !cancelled && apply(result, false))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [fetchAll, apply, version]);

  // Closing or reloading the browser tab would lose the edits.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const index = useMemo(() => (info ? pageIndex(info) : { live: new Set<string>(), draft: new Set<string>() }), [info]);

  /** Changes the draft through a copy, so React sees a new value. */
  const edit = useCallback((change: (next: Navigation) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      change(next);
      return next;
    });
    setSaved(false);
  }, []);

  /** Opens an entry in the editor and scrolls to it (from a click in the preview, say). */
  const select = useCallback((target: string) => {
    setSelected(target);
    if (/^[hf]\d+$/.test(target)) setOpen(target);
    requestAnimationFrame(() => document.getElementById(`hf-${target}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, []);

  async function save() {
    if (!draft || !info) return;
    setSaving(true);
    setError(null);
    try {
      // Copies whose templates ignore the appearance settings don't get them written.
      const navigation = info.supportsAppearance ? draft : { ...draft, appearance: undefined };
      const result = await api<NavigationInfo & { status: WorkspaceStatus }>(workspacePath(owner, repo, "/navigation"), {
        method: "PUT",
        body: { navigation, version: info.version },
      });
      setInfo(result);
      setDraft(result.navigation);
      setStatus(result.status);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && /changed by something else/.test(err.message)) setStale(true);
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (!info) return;
    if (!confirm("Discard your changes to the header and footer?")) return;
    setDraft(info.navigation);
    setError(null);
    setStale(false);
  }

  async function reloadLatest() {
    setError(null);
    try {
      await load(true);
    } catch (err) {
      setError(err);
    }
  }

  async function installTemplates() {
    if (!confirm("This replaces templates/partials/header.html, templates/partials/footer.html and scripts/lib/content.js with the template's versions. Changes you made to those files by hand are lost (review them on the Changes tab before committing). Continue?")) return;
    setInstalling(true);
    setError(null);
    try {
      const result = await api<{ written: string[]; status: WorkspaceStatus }>(workspacePath(owner, repo, "/install/header-footer"), {
        method: "POST",
        body: {},
      });
      setInstalled(result.written);
      setStatus(result.status);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setInstalling(false);
    }
  }

  if (!info || !draft) {
    return error ? <ErrorText error={error} /> : <p className="text-sm text-zinc-500">Loading the header and footer…</p>;
  }

  const look = draft.appearance;
  const styled = info.supportsAppearance;
  const disabled = saving || installing;
  const defaultCollection = info.collections[0]?.name ?? "";
  const toggle = (key: string) => setOpen((current) => (current === key ? null : key));

  return (
    <div className="space-y-6">
      <datalist id={PAGES_LIST}>
        {info.pages.map((page) => (
          <option key={page.url} value={page.url}>
            {page.title}
            {page.draft ? " (draft)" : ""}
          </option>
        ))}
      </datalist>

      <div className="sticky top-0 z-30 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-background/95 px-4 py-2.5 backdrop-blur dark:border-zinc-800">
        <p className="mr-auto text-sm">
          {dirty ? (
            <span className="font-medium">You have unsaved changes.</span>
          ) : saved ? (
            <span className="text-green-700 dark:text-green-400">Saved to content/data/navigation.json.</span>
          ) : (
            <span className="text-zinc-500">Edit below or click any part of the preview. Changes show in the preview straight away.</span>
          )}
        </p>
        {saved && !dirty && (
          <Button
            disabled={busy}
            onClick={() => {
              void run("preview");
              showTab("build");
            }}
          >
            Build and preview the site
          </Button>
        )}
        <Button disabled={!dirty || disabled} onClick={discard}>
          Discard
        </Button>
        <Button variant="primary" disabled={!dirty || disabled || busy} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {error ? (
        <div className="space-y-2">
          <ErrorText error={error} />
          {stale && (
            <Button variant="danger" onClick={reloadLatest}>
              Load the latest version (discards your edits)
            </Button>
          )}
        </div>
      ) : null}

      <Section
        title="Preview"
        description="An approximation in the template's colours. Links to pages the site doesn't have yet are struck through: the build leaves them out until those pages exist."
      >
        <div className="mb-3 flex gap-1" role="group" aria-label="Preview size">
          <Segmented
            value={device}
            onChange={setDevice}
            options={[
              { value: "desktop", label: "Desktop" },
              { value: "mobile", label: "Mobile" },
            ]}
          />
        </div>
        <HeaderFooterPreview
          navigation={draft}
          info={info}
          brand={brand}
          pageIndex={index}
          device={device}
          styled={styled}
          selected={selected}
          onSelect={select}
        />
      </Section>

      {!styled && (
        <Notice tone="warning">
          This site&apos;s header and footer templates are older than the colour and layout settings, so those settings are
          switched off. You can still edit every menu and link.{" "}
          <Button variant="ghost" className="ml-1 underline" disabled={disabled || busy} onClick={installTemplates}>
            {installing ? "Updating…" : "Update the header and footer templates"}
          </Button>
        </Notice>
      )}
      {installed && (
        <Notice tone="success">
          {installed.length
            ? `Updated ${installed.join(", ")}. Review them on the Changes tab.`
            : "The header and footer templates were already up to date."}
        </Notice>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        {/* ------------------------------------------------------------ header */}
        <Section title="Header" description="The bar at the top of every page.">
          <div id="hf-header-look" className={`space-y-4 rounded-md p-1 ${flash(selected, "header-look")}`}>
            <Field label="Colour">
              <Segmented<HeaderTheme>
                value={look.header.theme}
                disabled={!styled || disabled}
                onChange={(theme) => edit((n) => void (n.appearance.header.theme = theme))}
                options={[
                  { value: "light", label: "Light", swatch: "#ffffff" },
                  { value: "dark", label: "Dark", swatch: "#0b1a2e" },
                  { value: "brand", label: "Brand colour", swatch: "#1462c4" },
                ]}
              />
            </Field>
            <Field label="Menu position" hint="Where the menu sits between the logo and the button, on wide screens.">
              <Segmented<MenuLayout>
                value={look.header.layout}
                disabled={!styled || disabled}
                onChange={(layout) => edit((n) => void (n.appearance.header.layout = layout))}
                options={[
                  { value: "left", label: "Next to the logo" },
                  { value: "center", label: "Centred" },
                  { value: "right", label: "Right" },
                ]}
              />
            </Field>
            <Check
              checked={look.header.sticky}
              disabled={!styled || disabled}
              onChange={(sticky) => edit((n) => void (n.appearance.header.sticky = sticky))}
              label="Keep the header at the top of the screen while scrolling"
            />
            <p className="text-xs text-zinc-500">
              The logo and site name come from{" "}
              <button type="button" className="underline" onClick={() => showTab("info")}>
                Site info
              </button>
              . On a dark or brand-colour header, the logo for dark backgrounds is used when there is one.
            </p>
          </div>

          <h4 className="mb-2 mt-6 text-sm font-semibold">Menu</h4>
          {draft.header.items.length === 0 && <p className="mb-2 text-sm text-zinc-500">The menu is empty.</p>}
          <ol className="space-y-2">
            {draft.header.items.map((item, i) => (
              <Card
                key={i}
                id={`h${i}`}
                number={i + 1}
                open={open === `h${i}`}
                highlighted={selected === `h${i}`}
                onToggle={() => toggle(`h${i}`)}
                title={item.label || "Untitled"}
                summary={<ItemSummary item={item} info={info} index={index} />}
                disabled={disabled}
                onUp={i > 0 ? () => edit((n) => move(n.header.items, i, -1)) : undefined}
                onDown={i < draft.header.items.length - 1 ? () => edit((n) => move(n.header.items, i, 1)) : undefined}
                onRemove={() => {
                  if (confirm(`Remove "${item.label || "this item"}" from the menu? Its pages stay; only the menu entry goes.`)) {
                    edit((n) => void n.header.items.splice(i, 1));
                    setOpen(null);
                  }
                }}
              >
                <HeaderItemEditor
                  item={item}
                  info={info}
                  index={index}
                  disabled={disabled}
                  defaultCollection={defaultCollection}
                  onChange={(next) => edit((n) => void (n.header.items[i] = next))}
                />
              </Card>
            ))}
          </ol>
          <Button
            className="mt-3"
            disabled={disabled || draft.header.items.length >= MAX_ITEMS}
            onClick={() => {
              edit((n) => void n.header.items.push({ label: "", url: "" }));
              setOpen(`h${draft.header.items.length}`);
            }}
          >
            + Add menu item
          </Button>

          <div id="hf-cta" className={`mt-6 space-y-3 rounded-md p-1 ${flash(selected, "cta")}`}>
            <h4 className="text-sm font-semibold">Button</h4>
            <Check
              checked={draft.header.cta !== null}
              disabled={disabled}
              onChange={(on) => edit((n) => void (n.header.cta = on ? { label: "Contact us", url: "" } : null))}
              label="Show a button at the end of the menu"
            />
            {draft.header.cta && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Button text">
                  <input
                    value={draft.header.cta.label}
                    maxLength={40}
                    disabled={disabled}
                    onChange={(e) => edit((n) => void (n.header.cta!.label = e.target.value))}
                    className={inputClass}
                  />
                </Field>
                <LinkField
                  label="Goes to"
                  value={draft.header.cta.url}
                  index={index}
                  disabled={disabled}
                  onChange={(url) => edit((n) => void (n.header.cta!.url = url))}
                />
              </div>
            )}
          </div>
        </Section>

        {/* ------------------------------------------------------------ footer */}
        <Section title="Footer" description="The block at the bottom of every page.">
          <div id="hf-footer-look" className={`space-y-4 rounded-md p-1 ${flash(selected, "footer-look")}`}>
            <Field label="Colour">
              <Segmented<FooterTheme>
                value={look.footer.theme}
                disabled={!styled || disabled}
                onChange={(theme) => edit((n) => void (n.appearance.footer.theme = theme))}
                options={[
                  { value: "dark", label: "Dark", swatch: "#071426" },
                  { value: "light", label: "Light", swatch: "#f1f5fa" },
                  { value: "brand", label: "Brand colour", swatch: "#1462c4" },
                ]}
              />
            </Field>
            <div className="space-y-1.5">
              <Check
                checked={look.footer.showTagline}
                disabled={!styled || disabled}
                onChange={(on) => edit((n) => void (n.appearance.footer.showTagline = on))}
                label="Show the footer tagline under the logo"
              />
              <Check
                checked={look.footer.showContact}
                disabled={!styled || disabled}
                onChange={(on) => edit((n) => void (n.appearance.footer.showContact = on))}
                label="Show the email address and phone number"
              />
              <p className="text-xs text-zinc-500">
                The tagline and contact details are edited on{" "}
                <button type="button" className="underline" onClick={() => showTab("info")}>
                  Site info
                </button>
                .
              </p>
            </div>
            <Field label="Copyright line" hint={`Shown after "© ${new Date().getFullYear()}". Leave it empty for "${info.site.name}. All rights reserved."`}>
              <input
                value={look.footer.copyright}
                maxLength={120}
                disabled={!styled || disabled}
                placeholder={`${info.site.name}. All rights reserved.`}
                onChange={(e) => edit((n) => void (n.appearance.footer.copyright = e.target.value))}
                className={inputClass}
              />
            </Field>
          </div>

          <h4 className="mb-2 mt-6 text-sm font-semibold">Link columns</h4>
          {draft.footer.length === 0 && <p className="mb-2 text-sm text-zinc-500">The footer has no link columns.</p>}
          <ol className="space-y-2">
            {draft.footer.map((column, i) => (
              <Card
                key={i}
                id={`f${i}`}
                number={i + 1}
                open={open === `f${i}`}
                highlighted={selected === `f${i}`}
                onToggle={() => toggle(`f${i}`)}
                title={column.title || "Untitled column"}
                summary={`${column.links.length} ${column.links.length === 1 ? "entry" : "entries"}`}
                disabled={disabled}
                onUp={i > 0 ? () => edit((n) => move(n.footer, i, -1)) : undefined}
                onDown={i < draft.footer.length - 1 ? () => edit((n) => move(n.footer, i, 1)) : undefined}
                onRemove={() => {
                  if (confirm(`Remove the "${column.title || "untitled"}" column from the footer?`)) {
                    edit((n) => void n.footer.splice(i, 1));
                    setOpen(null);
                  }
                }}
              >
                <Field label="Heading">
                  <input
                    value={column.title}
                    maxLength={60}
                    disabled={disabled}
                    onChange={(e) => edit((n) => void (n.footer[i].title = e.target.value))}
                    className={inputClass}
                  />
                </Field>
                <FooterLinks
                  links={column.links}
                  info={info}
                  index={index}
                  disabled={disabled}
                  defaultCollection={defaultCollection}
                  onChange={(change) => edit((n) => change(n.footer[i].links))}
                />
              </Card>
            ))}
          </ol>
          <Button
            className="mt-3"
            disabled={disabled || draft.footer.length >= MAX_COLUMNS}
            onClick={() => {
              edit((n) => void n.footer.push({ title: "", links: [{ label: "", url: "" }] }));
              setOpen(`f${draft.footer.length}`);
            }}
          >
            + Add column
          </Button>

          <div id="hf-legal" className={`mt-6 rounded-md p-1 ${flash(selected, "legal")}`}>
            <h4 className="mb-1 text-sm font-semibold">Legal links</h4>
            <p className="mb-3 text-xs text-zinc-500">The small links beside the copyright line, such as Privacy and Terms.</p>
            <LinkRows
              links={draft.legal}
              index={index}
              disabled={disabled}
              max={MAX_LEGAL}
              addLabel="+ Add legal link"
              onChange={(change) => edit((n) => change(n.legal))}
            />
          </div>
        </Section>
      </div>

      <NewSection dirty={dirty} />
      {job?.command === "nav-add" && <JobLog />}
    </div>
  );
}

const flash = (selected: string | null, target: string) => (selected === target ? "ring-2 ring-amber-400" : "");

/* ------------------------------------------------------------------ pieces */

function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string; swatch?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap gap-1 rounded-md border border-zinc-300 p-0.5 dark:border-zinc-700">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${
            value === option.value ? "bg-foreground text-background" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
          }`}
        >
          {option.swatch && <span aria-hidden className="size-3 rounded-full border border-zinc-400" style={{ background: option.swatch }} />}
          {option.label}
        </button>
      ))}
    </span>
  );
}

function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** A link input that suggests the site's pages and says when the link would be left out. */
function LinkField({
  label,
  value,
  onChange,
  index,
  disabled,
  optional,
  hint,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string) => void;
  index: PageIndex;
  disabled?: boolean;
  optional?: boolean;
  hint?: string;
}) {
  const status = linkStatus(value, index);
  const note =
    status === "missing"
      ? "No page at this address yet: the built site leaves this link out until the page exists."
      : status === "draft"
        ? "That page is a draft: the link appears once it's published."
        : status === "empty" && !optional
          ? "Pick a page, or type a link (/page.html, https://…, mailto:…)."
          : hint;
  return (
    <Field
      label={label}
      hint={note && <span className={status === "missing" || status === "draft" ? "text-amber-700 dark:text-amber-400" : ""}>{note}</span>}
    >
      <input
        value={value ?? ""}
        list={PAGES_LIST}
        maxLength={300}
        disabled={disabled}
        placeholder={optional ? "Optional" : "/page.html"}
        onChange={(e) => onChange(e.target.value.trim())}
        className={inputClass}
      />
    </Field>
  );
}

function Card({
  id,
  number,
  title,
  summary,
  open,
  highlighted,
  onToggle,
  onUp,
  onDown,
  onRemove,
  disabled,
  children,
}: {
  id: string;
  number: number;
  title: string;
  summary: ReactNode;
  open: boolean;
  highlighted: boolean;
  onToggle: () => void;
  onUp?: () => void;
  onDown?: () => void;
  onRemove: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <li
      id={`hf-${id}`}
      className={`rounded-md border ${highlighted ? "border-amber-400 ring-2 ring-amber-400" : "border-zinc-200 dark:border-zinc-800"}`}
    >
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span aria-hidden className={`text-xs text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}>
            ▶
          </span>
          <span className="w-5 shrink-0 text-xs text-zinc-400">{number}</span>
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="truncate text-xs text-zinc-500">{summary}</span>
        </button>
        <IconButton label="Move up" disabled={disabled || !onUp} onClick={onUp}>
          ↑
        </IconButton>
        <IconButton label="Move down" disabled={disabled || !onDown} onClick={onDown}>
          ↓
        </IconButton>
        <IconButton label="Remove" disabled={disabled} onClick={onRemove}>
          ✕
        </IconButton>
      </div>
      {open && <div className="space-y-3 border-t border-zinc-200 p-3 dark:border-zinc-800">{children}</div>}
    </li>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick?: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Button variant="ghost" aria-label={label} title={label} className="px-2 py-0.5 text-xs" disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

function ItemSummary({ item, info, index }: { item: NavItem; info: NavigationInfo; index: PageIndex }) {
  const kind = kindOf(item);
  if (kind === "collection") {
    const label = info.collections.find((c) => c.name === item.collection)?.label ?? item.collection;
    return <>Lists {label} pages (up to {item.limit ?? 8})</>;
  }
  if (kind === "dropdown") return <>Dropdown · {item.children?.length ?? 0} links</>;
  const status = linkStatus(item.url, index);
  return (
    <>
      {item.url || "No link yet"}
      {status === "missing" && <span className="ml-1 text-amber-700 dark:text-amber-400">· no page yet</span>}
      {status === "draft" && <span className="ml-1 text-amber-700 dark:text-amber-400">· draft</span>}
    </>
  );
}

const KINDS: { value: ItemKind; label: string; hint: string }[] = [
  { value: "link", label: "Link", hint: "Goes straight to one page." },
  { value: "dropdown", label: "Dropdown", hint: "Opens a list of links you choose." },
  { value: "collection", label: "Automatic dropdown", hint: "Lists a collection's pages, and keeps up as pages are added." },
];

function HeaderItemEditor({
  item,
  info,
  index,
  disabled,
  defaultCollection,
  onChange,
}: {
  item: NavItem;
  info: NavigationInfo;
  index: PageIndex;
  disabled: boolean;
  defaultCollection: string;
  onChange: (item: NavItem) => void;
}) {
  const kind = kindOf(item);
  const kinds = info.collections.length ? KINDS : KINDS.filter((k) => k.value !== "collection");
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label">
          <input
            autoFocus={!item.label}
            value={item.label}
            maxLength={60}
            disabled={disabled}
            onChange={(e) => onChange({ ...item, label: e.target.value })}
            className={inputClass}
          />
        </Field>
        <LinkField
          label={kind === "link" ? "Goes to" : "Its own page"}
          value={item.url}
          optional={kind !== "link"}
          hint={kind !== "link" ? "Optional. Without one, the label just opens the dropdown." : undefined}
          index={index}
          disabled={disabled}
          onChange={(url) => onChange(url || kind === "link" ? { ...item, url } : withoutUrl(item))}
        />
      </div>
      <fieldset>
        <legend className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Kind</legend>
        <div className="mt-1 grid gap-1.5 sm:grid-cols-3">
          {kinds.map((k) => (
            <label
              key={k.value}
              className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${
                kind === k.value ? "border-foreground" : "border-zinc-200 dark:border-zinc-800"
              }`}
            >
              <input
                type="radio"
                className="mt-1"
                checked={kind === k.value}
                disabled={disabled}
                onChange={() => onChange(withKind(item, k.value, defaultCollection))}
              />
              <span>
                <span className="block font-medium">{k.label}</span>
                <span className="block text-xs text-zinc-500">{k.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {kind === "dropdown" && (
        <div>
          <p className="mb-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">Links in the dropdown</p>
          <LinkRows
            links={item.children ?? []}
            index={index}
            disabled={disabled}
            max={MAX_CHILDREN}
            withDescription
            addLabel="+ Add link to the dropdown"
            onChange={(change) => {
              const children = structuredClone(item.children ?? []);
              change(children);
              onChange({ ...item, children });
            }}
          />
        </div>
      )}
      {kind === "collection" && (
        <CollectionFields item={item} info={info} disabled={disabled} onChange={onChange} />
      )}
    </>
  );
}

function withoutUrl(item: NavItem): NavItem {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { url, ...rest } = item;
  return rest;
}

function CollectionFields({ item, info, disabled, onChange }: { item: NavItem; info: NavigationInfo; disabled: boolean; onChange: (item: NavItem) => void }) {
  const count = info.pages.filter((page) => page.collection === item.collection && !page.draft).length;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Collection" hint={`${count} published ${count === 1 ? "page" : "pages"} now.`}>
        <select
          value={item.collection ?? ""}
          disabled={disabled}
          onChange={(e) => onChange({ ...item, collection: e.target.value })}
          className={inputClass}
        >
          {info.collections.map((c) => (
            <option key={c.name} value={c.name}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Show at most">
        <input
          type="number"
          min={1}
          max={100}
          value={item.limit ?? 8}
          disabled={disabled}
          onChange={(e) => onChange({ ...item, limit: Math.min(100, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
          className={inputClass}
        />
      </Field>
    </div>
  );
}

/** Rows of label + link, with reordering, for dropdowns and legal links. */
function LinkRows({
  links,
  index,
  disabled,
  max,
  withDescription,
  addLabel,
  onChange,
}: {
  links: NavLink[];
  index: PageIndex;
  disabled: boolean;
  max: number;
  withDescription?: boolean;
  addLabel: string;
  onChange: (change: (links: NavLink[]) => void) => void;
}) {
  return (
    <div className="space-y-2">
      {links.map((link, i) => (
        <div key={i} className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
          <div className="flex items-start gap-2">
            <div className="grid flex-1 gap-2 sm:grid-cols-2">
              <Field label="Label">
                <input
                  value={link.label}
                  maxLength={60}
                  disabled={disabled}
                  onChange={(e) => onChange((l) => void (l[i].label = e.target.value))}
                  className={inputClass}
                />
              </Field>
              <LinkField label="Goes to" value={link.url} index={index} disabled={disabled} onChange={(url) => onChange((l) => void (l[i].url = url))} />
              {withDescription && (
                <div className="sm:col-span-2">
                  <Field label="Description" hint="Optional. A short line under the label, on wide screens.">
                    <input
                      value={link.description ?? ""}
                      maxLength={160}
                      disabled={disabled}
                      onChange={(e) =>
                        onChange((l) => {
                          if (e.target.value) l[i].description = e.target.value;
                          else delete l[i].description;
                        })
                      }
                      className={inputClass}
                    />
                  </Field>
                </div>
              )}
            </div>
            <div className="flex flex-col pt-4">
              <IconButton label="Move up" disabled={disabled || i === 0} onClick={() => onChange((l) => move(l, i, -1))}>
                ↑
              </IconButton>
              <IconButton label="Move down" disabled={disabled || i === links.length - 1} onClick={() => onChange((l) => move(l, i, 1))}>
                ↓
              </IconButton>
              <IconButton label="Remove" disabled={disabled} onClick={() => onChange((l) => void l.splice(i, 1))}>
                ✕
              </IconButton>
            </div>
          </div>
        </div>
      ))}
      <Button disabled={disabled || links.length >= max} onClick={() => onChange((l) => void l.push({ label: "", url: "" }))}>
        {addLabel}
      </Button>
    </div>
  );
}

/** A footer column's entries: links, and lists of a collection's pages. */
function FooterLinks({
  links,
  info,
  index,
  disabled,
  defaultCollection,
  onChange,
}: {
  links: NavItem[];
  info: NavigationInfo;
  index: PageIndex;
  disabled: boolean;
  defaultCollection: string;
  onChange: (change: (links: NavItem[]) => void) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Entries</p>
      {links.map((link, i) => {
        const auto = link.type === "collection";
        return (
          <div key={i} className="flex items-start gap-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
            <div className="flex-1">
              {auto ? (
                <>
                  <p className="mb-2 text-xs text-zinc-500">
                    <Badge>Automatic</Badge> Lists the collection&apos;s pages, newest additions included.
                  </p>
                  <CollectionFields item={link} info={info} disabled={disabled} onChange={(next) => onChange((l) => void (l[i] = next))} />
                </>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Label">
                    <input
                      value={link.label}
                      maxLength={60}
                      disabled={disabled}
                      onChange={(e) => onChange((l) => void (l[i].label = e.target.value))}
                      className={inputClass}
                    />
                  </Field>
                  <LinkField label="Goes to" value={link.url} index={index} disabled={disabled} onChange={(url) => onChange((l) => void (l[i].url = url))} />
                </div>
              )}
            </div>
            <div className="flex flex-col pt-4">
              <IconButton label="Move up" disabled={disabled || i === 0} onClick={() => onChange((l) => move(l, i, -1))}>
                ↑
              </IconButton>
              <IconButton label="Move down" disabled={disabled || i === links.length - 1} onClick={() => onChange((l) => move(l, i, 1))}>
                ↓
              </IconButton>
              <IconButton label="Remove" disabled={disabled} onClick={() => onChange((l) => void l.splice(i, 1))}>
                ✕
              </IconButton>
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || links.length >= MAX_LINKS} onClick={() => onChange((l) => void l.push({ label: "", url: "" }))}>
          + Add link
        </Button>
        {info.collections.length > 0 && (
          <Button
            disabled={disabled || links.length >= MAX_LINKS}
            onClick={() => onChange((l) => void l.push({ label: "", type: "collection", collection: defaultCollection, limit: 6 }))}
          >
            + Add a collection&apos;s pages
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Adds a menu item for a whole new section: the site's nav.js script creates the collection,
 * its layouts, listing page and a sample entry when the address is new.
 */
function NewSection({ dirty }: { dirty: boolean }) {
  const { busy, run } = useSite();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (await run("nav-add", { label, url })) {
      setLabel("");
      setUrl("");
    }
  }

  return (
    <Section
      title="Add a new section with its own pages"
      description="Adds a menu item and, for a new address like /events.html, sets up an Events collection: its layouts, a listing page and a sample entry. Use the menu editor above for links to pages that already exist."
    >
      {dirty && <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">Save or discard your header and footer changes first.</p>}
      <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Label">
          <input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={60} className={inputClass} disabled={busy || dirty} />
        </Field>
        <Field label="Address">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            maxLength={300}
            placeholder="/events.html"
            className={inputClass}
            disabled={busy || dirty}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={busy || dirty || !label.trim() || !url.trim()}>
          Add section
        </Button>
      </form>
    </Section>
  );
}
