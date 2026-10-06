"use client";

import { confirmModal } from "@/lib/confirm";
import { useState } from "react";
import { api, workspacePath, type DomainCheck, type DomainHealth, type Publishing } from "@/lib/site-api";
import { dnsRecords, looksApex, type DnsRecord } from "@/lib/custom-domain";
import { useSite } from "./site-context";
import { Button, ErrorText, inputClass } from "./ui";

function certificateText(state: string | null, enforced: boolean) {
  if (enforced) return "HTTPS is on.";
  if (state === "approved" || state === "issued") return "Certificate ready. Turn on HTTPS.";
  if (state === "errored" || state === "bad_authz") return "GitHub couldn't get a certificate. Check the DNS records, then remove and add the domain again.";
  if (state) return "GitHub is getting a certificate. This takes from a few minutes up to 24 hours after DNS is right.";
  return "GitHub gets a certificate once DNS points at it.";
}

/** Connect a custom domain to the copy's GitHub Pages site, with the DNS records to add. */
export function DomainSettings({ publishing, onChange }: { publishing: Publishing; onChange: (p: Publishing) => void }) {
  const { owner, repo, busy } = useSite();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [working, setWorking] = useState<"save" | "remove" | "https" | "check" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [check, setCheck] = useState<DomainCheck | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const domain = publishing.domain;
  const typed = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const shown = domain ?? (typed.includes(".") ? typed : null);
  const apex = check?.domain?.host === shown && check.domain ? check.domain.isApex : shown ? looksApex(shown) : false;
  const locked = busy || working !== null;

  async function call<T>(kind: NonNullable<typeof working>, path: string, method: string, body?: unknown) {
    setWorking(kind);
    setError(null);
    try {
      return await api<T>(workspacePath(owner, repo, path), { method, body });
    } catch (err) {
      setError(err);
      return null;
    } finally {
      setWorking(null);
    }
  }

  async function saveDomain(next: string | null) {
    if (next === null && !(await confirmModal(`Remove ${domain}? The site goes back to its github.io address.`, { confirmLabel: "Remove domain", danger: true }))) {
      return;
    }
    const result = await call<Publishing & { redeployed: boolean }>(next ? "save" : "remove", "/publishing/domain", "PUT", {
      domain: next,
    });
    if (!result) return;
    onChange(result);
    setCheck(null);
    setInput("");
    setNotice(
      result.redeployed
        ? `Saved. The site is being rebuilt for ${next ?? "its github.io address"}.`
        : "Saved. Update the publishing files and push them so the site is rebuilt for the new address.",
    );
  }

  async function runCheck() {
    const result = await call<DomainCheck>("check", "/publishing/domain-check", "GET");
    if (result) setCheck(result);
  }

  async function setHttps(enforced: boolean) {
    const result = await call<Publishing>("https", "/publishing/https", "PUT", { enforced });
    if (result) onChange(result);
  }

  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-sm font-medium" aria-expanded={open}>
        <span
          aria-hidden="true"
          className={`inline-block text-2xl leading-none transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        >
          ▸
        </span>
        <span>Use my own domain name</span>
        <span className="font-normal text-zinc-500">
          {domain ? `${domain}${publishing.httpsEnforced ? " · secure (HTTPS)" : ""}` : "not set up"}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-4 text-xs">
          {!domain ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveDomain(typed);
              }}
              className="flex flex-wrap items-end gap-2"
            >
              <label className="min-w-56 flex-1">
                <span className="block font-medium text-zinc-600 dark:text-zinc-400">Domain</span>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="www.example.com or example.com"
                  className={`${inputClass} mt-1 font-mono`}
                  disabled={locked}
                  spellCheck={false}
                  autoCapitalize="off"
                />
              </label>
              <Button type="submit" variant="primary" className="text-xs" disabled={locked || !typed.includes(".")}>
                {working === "save" ? "Connecting…" : "Connect domain"}
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <a href={`${publishing.httpsEnforced ? "https" : "http"}://${domain}/`} target="_blank" rel="noreferrer" className="font-mono underline">
                {domain}
              </a>
              <Button className="text-xs" disabled={locked} onClick={() => void runCheck()}>
                {working === "check" ? "Checking…" : "Check DNS"}
              </Button>
              <Button variant="danger" className="text-xs" disabled={locked} onClick={() => void saveDomain(null)}>
                {working === "remove" ? "Removing…" : "Remove domain"}
              </Button>
            </div>
          )}

          {notice && <p className="text-green-700 dark:text-green-400">{notice}</p>}
          <ErrorText error={error} />

          {shown && (
            <DnsInstructions domain={shown} records={dnsRecords(shown, publishing.pagesHost, apex)} apex={apex} saved={Boolean(domain)} />
          )}

          {domain && check && <CheckResult check={check} />}

          {domain && (
            <div>
              <p className="font-medium">HTTPS</p>
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">{certificateText(publishing.certificate, publishing.httpsEnforced)}</p>
              <label className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={publishing.httpsEnforced}
                  disabled={locked}
                  onChange={(e) => void setHttps(e.target.checked)}
                />
                Enforce HTTPS (visitors on http:// are sent to https://)
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DnsInstructions({ domain, records, apex, saved }: { domain: string; records: DnsRecord[]; apex: boolean; saved: boolean }) {
  return (
    <div>
      <p className="font-medium">{saved ? "At your domain's DNS provider" : `DNS records for ${domain}`}</p>
      <ol className="mt-1 list-decimal space-y-1 pl-5 text-zinc-600 dark:text-zinc-400">
        <li>
          Sign in where the domain&apos;s DNS is managed: the registrar (GoDaddy, Namecheap…) or a DNS host such as Cloudflare.
        </li>
        <li>
          Delete any existing <code className="font-mono">A</code>, <code className="font-mono">AAAA</code> or{" "}
          <code className="font-mono">CNAME</code> record for {apex ? "the bare domain (@)" : "that name"}, such as a parking
          page. Leave <code className="font-mono">MX</code> and <code className="font-mono">TXT</code> records (email) alone.
        </li>
        <li>Add these records. TTL can stay at the default.</li>
      </ol>
      <table className="mt-2 w-full border-collapse font-mono">
        <thead>
          <tr className="text-left text-zinc-500">
            <th className="border-b border-zinc-200 py-1 pr-3 font-normal dark:border-zinc-800">Type</th>
            <th className="border-b border-zinc-200 py-1 pr-3 font-normal dark:border-zinc-800">Name / Host</th>
            <th className="border-b border-zinc-200 py-1 font-normal dark:border-zinc-800">Value / Points to</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={`${r.type}${r.name}${r.value}`}>
              <td className="py-0.5 pr-3">{r.type}</td>
              <td className="py-0.5 pr-3">{r.name}</td>
              <td className="break-all py-0.5 select-all">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-600 dark:text-zinc-400">
        {apex ? (
          <li>
            <code className="font-mono">@</code> means the bare domain; some providers want it left blank or written out as{" "}
            <code className="font-mono">{domain}</code>. The <code className="font-mono">AAAA</code> records are optional (IPv6).
            The <code className="font-mono">www</code> record makes www.{domain} redirect to {domain}.
          </li>
        ) : (
          <li>
            Some providers want the full name (<code className="font-mono">{domain}</code>) instead of just the first part.
          </li>
        )}
        <li>
          On Cloudflare, set these records to <strong>DNS only</strong> (grey cloud), not Proxied, at least until GitHub has
          issued the HTTPS certificate.
        </li>
        <li>If the domain has CAA records, add one allowing <code className="font-mono">letsencrypt.org</code>.</li>
        <li>
          Changes usually show up within an hour but can take up to 48 hours. Use <strong>Check DNS</strong> to see what GitHub
          sees.
        </li>
        <li>
          Recommended: verify the domain under your GitHub account&apos;s Settings → Pages → Verified domains, so nobody else
          can attach it to their own site.
        </li>
      </ul>
    </div>
  );
}

function CheckResult({ check }: { check: DomainCheck }) {
  if (check.pending) return <p className="text-zinc-600 dark:text-zinc-400">GitHub is still checking. Try again in a few seconds.</p>;
  const rows = [check.domain, check.altDomain].filter((d): d is DomainHealth => Boolean(d));
  return (
    <div className="space-y-1">
      <p className="font-medium">What GitHub sees</p>
      {rows.map((d) => {
        const problem = !d.resolves
          ? "No DNS records found yet."
          : d.proxied
            ? "Proxied (e.g. Cloudflare orange cloud). Switch it to DNS only."
            : !d.pointsToGithub
              ? "Points somewhere else. Check the records above and remove old ones."
              : d.caaError
                ? `CAA records block the certificate: ${d.caaError}`
                : null;
        return (
          <p key={d.host} className={problem ? "text-amber-700 dark:text-amber-400" : "text-green-700 dark:text-green-400"}>
            <span className="font-mono">{d.host}</span>: {problem ?? `points at GitHub Pages${d.httpsEligible ? ", ready for HTTPS" : ""}.`}
          </p>
        );
      })}
    </div>
  );
}
