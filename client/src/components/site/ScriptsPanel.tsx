"use client";

import { useEffect, useRef, useState } from "react";
import { confirmModal } from "@/lib/confirm";
import { api, workspacePath, type SiteScript, type SiteScripts, type WorkspaceStatus } from "@/lib/site-api";
import { useSite } from "./site-context";
import { Badge, Button, ErrorText, Field, Notice, Section, inputClass } from "./ui";

// Code from other services on the published site, on every page or chosen ones
// (content/data/scripts.json; the template's build.js leaves it out of previews). Google Analytics
// only asks for its ID and writes an ordinary entry, so there's one kind of script to look after.

const GA_ID = /^G-[A-Z0-9]{4,20}$/;

const gaCode = (id: string) => `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${id}');
</script>`;

type Form = {
  kind: "ga" | "code";
  gaId: string;
  name: string;
  code: string;
  place: SiteScript["place"];
  everyPage: boolean;
  pages: string[];
  on: boolean;
};
/** `index`: the script being changed, null for a new one. */
type Editing = { index: number | null; form: Form; start: string };

const blank = (kind: Form["kind"]): Form => ({ kind, gaId: "", name: kind === "ga" ? "Google Analytics" : "", code: "", place: "head", everyPage: true, pages: [], on: true });

function formOf(script: SiteScript): Form {
  const id = /gtag\/js\?id=(G-[A-Z0-9]+)/.exec(script.code)?.[1] ?? "";
  return {
    kind: id && script.code === gaCode(id) ? "ga" : "code",
    gaId: id,
    name: script.name,
    code: script.code,
    place: script.place,
    everyPage: script.pages === "all",
    pages: script.pages === "all" ? [] : script.pages,
    on: script.on,
  };
}

const editing = (index: number | null, form: Form): Editing => ({ index, form, start: JSON.stringify(form) });

export function ScriptsPanel() {
  const { owner, repo, busy, version, overview, setStatus, setUnsavedDraft } = useSite();
  const [scripts, setScripts] = useState<SiteScripts | null>(null);
  const [edit, setEdit] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const supported = overview?.features.customScripts !== false;

  const dirty = edit !== null && JSON.stringify(edit.form) !== edit.start;
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
    setUnsavedDraft(dirty);
  }, [dirty, setUnsavedDraft]);
  useEffect(() => () => setUnsavedDraft(false), [setUnsavedDraft]);

  useEffect(() => {
    if (dirtyRef.current) return;
    let cancelled = false;
    api<SiteScripts>(workspacePath(owner, repo, "/scripts"))
      .then((loaded) => !cancelled && !dirtyRef.current && setScripts(loaded))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [owner, repo, version]);

  /** Saves the whole list. Resolves to whether it worked. */
  async function save(items: SiteScript[]) {
    if (!scripts) return false;
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ scripts: SiteScripts; status: WorkspaceStatus }>(workspacePath(owner, repo, "/scripts"), {
        method: "PUT",
        body: { items, version: scripts.version },
      });
      setScripts(result.scripts);
      setStatus(result.status);
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveForm() {
    if (!edit || !scripts) return;
    const { form, index } = edit;
    const script: SiteScript = {
      name: form.name.trim(),
      code: form.kind === "ga" ? gaCode(form.gaId.trim().toUpperCase()) : form.code,
      place: form.kind === "ga" ? "head" : form.place,
      pages: form.everyPage ? "all" : form.pages,
      on: form.on,
    };
    const items = index === null ? [...scripts.items, script] : scripts.items.map((item, i) => (i === index ? script : item));
    if (await save(items)) setEdit(null);
  }

  async function remove(index: number) {
    if (!scripts) return;
    const ok = await confirmModal(`It comes off your site the next time you publish.`, { title: `Remove "${scripts.items[index].name}"?`, confirmLabel: "Remove", danger: true });
    if (ok && (await save(scripts.items.filter((_, i) => i !== index)))) setEdit(null);
  }

  const off = busy || saving;
  return (
    <Section
      title="Scripts on your site"
      description="Add code from other services, such as Google Analytics or a chat widget, to every page or only some. Scripts run on your published site, not in the editor's preview, so your own editing isn't counted."
    >
      {!supported ? (
        <Notice tone="warning">This site needs the latest site update before it can use scripts. Install it from Technical log, then come back here.</Notice>
      ) : scripts === null ? (
        error ? <ErrorText error={error} /> : <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <div className="space-y-4">
          {scripts.items.length > 0 && (
            <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {scripts.items.map((script, index) => (
                <li key={index} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="truncate text-sm font-medium">{script.name}</p>
                    <p className="text-xs text-zinc-500">
                      {script.pages === "all" ? "Every page" : `${script.pages.length} page${script.pages.length === 1 ? "" : "s"}`} · {script.place === "head" ? "Head of the page" : "End of the page"}
                    </p>
                  </div>
                  {!script.on && <Badge>Off</Badge>}
                  <Button disabled={off} onClick={() => save(scripts.items.map((item, i) => (i === index ? { ...item, on: !item.on } : item)))}>
                    {script.on ? "Turn off" : "Turn on"}
                  </Button>
                  <Button disabled={off} onClick={() => setEdit(editing(index, formOf(script)))}>
                    Edit
                  </Button>
                  <Button variant="ghost" disabled={off} onClick={() => remove(index)} className="text-zinc-500">
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {edit ? (
            <ScriptForm
              key={edit.index ?? "new"}
              form={edit.form}
              isNew={edit.index === null}
              disabled={off}
              error={error}
              onChange={(patch) => {
                setError(null);
                setEdit({ ...edit, form: { ...edit.form, ...patch } });
              }}
              onSave={saveForm}
              onCancel={() => {
                setError(null);
                setEdit(null);
              }}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={off} onClick={() => setEdit(editing(null, blank("ga")))}>
                Add Google Analytics
              </Button>
              <Button disabled={off} onClick={() => setEdit(editing(null, blank("code")))}>
                Paste a script
              </Button>
            </div>
          )}
          {!edit && <ErrorText error={error} />}
          {scripts.items.length > 0 && !edit && <p className="text-xs text-zinc-500">Changes here go live when you publish.</p>}
        </div>
      )}
    </Section>
  );
}

function ScriptForm({
  form,
  isNew,
  disabled,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  form: Form;
  isNew: boolean;
  disabled: boolean;
  error: unknown;
  onChange: (patch: Partial<Form>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { overview } = useSite();
  const sitePages = (overview?.collections ?? []).flatMap((c) => c.pages).filter((p) => p.address);
  // A page the script was set to run on that the site no longer has, so it can be unticked.
  const gone = form.pages.filter((address) => !sitePages.some((p) => p.address === address));
  const ga = form.kind === "ga";
  const idOk = GA_ID.test(form.gaId.trim().toUpperCase());
  const ready = Boolean(form.name.trim()) && (ga ? idOk : Boolean(form.code.trim())) && (form.everyPage || form.pages.length > 0);
  const toggle = (address: string) => onChange({ pages: form.pages.includes(address) ? form.pages.filter((a) => a !== address) : [...form.pages, address] });
  const choice = "flex cursor-pointer items-start gap-2 text-sm w-fit";

  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h4 className="text-sm font-semibold">{isNew ? (ga ? "Add Google Analytics" : "Paste a script") : `Edit ${form.name}`}</h4>

      {ga ? (
        <>
          <Field label="Measurement ID" hint="In Google Analytics: Admin, then Data streams, then your website. It starts with G-.">
            <input value={form.gaId} onChange={(e) => onChange({ gaId: e.target.value })} placeholder="G-XXXXXXXXXX" spellCheck={false} className={`${inputClass} font-mono`} disabled={disabled} />
          </Field>
          <Notice>Google Analytics sets cookies. If you have visitors in the UK or EU, you generally need their consent first, and Twinstack doesn&apos;t add a consent banner.</Notice>
        </>
      ) : (
        <>
          <Field label="Name" hint="So you can tell your scripts apart. Visitors don't see it.">
            <input value={form.name} onChange={(e) => onChange({ name: e.target.value })} maxLength={80} placeholder="Chat widget" className={inputClass} disabled={disabled} />
          </Field>
          <Field label="Code" hint="Paste it exactly as the service gives it, with its <script> tags. It runs for every visitor to these pages, so only use code from services you trust.">
            <textarea value={form.code} onChange={(e) => onChange({ code: e.target.value })} rows={8} spellCheck={false} className={`${inputClass} font-mono text-xs leading-relaxed`} disabled={disabled} />
          </Field>
          <fieldset>
            <legend className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Where on the page</legend>
            <div className="mt-1.5 space-y-1.5">
              <label className={choice}>
                <input type="radio" name="script-place" checked={form.place === "head"} onChange={() => onChange({ place: "head" })} className="mt-0.5" disabled={disabled} />
                <span>Head of the page <span className="text-zinc-500">(most services ask for this)</span></span>
              </label>
              <label className={choice}>
                <input type="radio" name="script-place" checked={form.place === "body"} onChange={() => onChange({ place: "body" })} className="mt-0.5" disabled={disabled} />
                <span>End of the page</span>
              </label>
            </div>
          </fieldset>
        </>
      )}

      <fieldset>
        <legend className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Which pages</legend>
        <div className="mt-1.5 space-y-1.5">
          <label className={choice}>
            <input type="radio" name="script-pages" checked={form.everyPage} onChange={() => onChange({ everyPage: true })} className="mt-0.5" disabled={disabled} />
            <span>Every page, including ones you add later</span>
          </label>
          <label className={choice}>
            <input type="radio" name="script-pages" checked={!form.everyPage} onChange={() => onChange({ everyPage: false })} className="mt-0.5" disabled={disabled} />
            <span>Only the pages I choose</span>
          </label>
        </div>
        {!form.everyPage && (
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
            {sitePages.map((page) => (
              <li key={page.file}>
                <label className={choice}>
                  <input type="checkbox" checked={form.pages.includes(page.address!)} onChange={() => toggle(page.address!)} className="mt-0.5" disabled={disabled} />
                  <span className="min-w-0">
                    {page.title} <span className="text-xs text-zinc-500">{page.address}{page.draft ? " (hidden)" : ""}</span>
                  </span>
                </label>
              </li>
            ))}
            {gone.map((address) => (
              <li key={address}>
                <label className={choice}>
                  <input type="checkbox" checked onChange={() => toggle(address)} className="mt-0.5" disabled={disabled} />
                  <span className="text-amber-700 dark:text-amber-300">{address} (no longer a page)</span>
                </label>
              </li>
            ))}
            {!sitePages.length && !gone.length && <li className="text-sm text-zinc-500">This site has no pages yet.</li>}
          </ul>
        )}
      </fieldset>

      {/* Above the buttons: below them, the AI bar pinned to the window can cover it. */}
      <ErrorText error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!ready || disabled} onClick={onSave}>
          {disabled ? "Saving…" : isNew ? "Add it" : "Save"}
        </Button>
        <Button variant="ghost" disabled={disabled} onClick={onCancel} className="text-zinc-500">
          Cancel
        </Button>
        <span className="text-xs text-zinc-500">It goes live when you publish.</span>
      </div>
    </div>
  );
}
