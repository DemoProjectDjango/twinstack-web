// DNS records for pointing a custom domain at a GitHub Pages site. Pure, so it
// runs anywhere; DomainSettings.tsx shows the result.

// GitHub Pages' addresses for a bare (apex) domain. Check
// https://docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site
// if GitHub ever changes them.
const PAGES_IPV4 = ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"];
const PAGES_IPV6 = ["2606:50c0:8000::153", "2606:50c0:8001::153", "2606:50c0:8002::153", "2606:50c0:8003::153"];
// Suffixes where the registrable domain has three labels (example.co.uk).
const TWO_PART_SUFFIXES = /\.(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/;

export type DnsRecord = { type: string; name: string; value: string };

/** A bare domain ("example.com") rather than a subdomain ("www.example.com"). */
export function looksApex(domain: string) {
  const labels = domain.split(".").length;
  return labels === 2 || (labels === 3 && TWO_PART_SUFFIXES.test(domain));
}

/** The records to add at the domain's DNS provider. */
export function dnsRecords(domain: string, pagesHost: string, apex: boolean): DnsRecord[] {
  if (apex) {
    return [
      ...PAGES_IPV4.map((ip) => ({ type: "A", name: "@", value: ip })),
      ...PAGES_IPV6.map((ip) => ({ type: "AAAA", name: "@", value: ip })),
      { type: "CNAME", name: "www", value: pagesHost },
    ];
  }
  // The name is the part in front of the registrable domain: "www" for www.example.com.
  const keep = TWO_PART_SUFFIXES.test(domain) ? 3 : 2;
  return [{ type: "CNAME", name: domain.split(".").slice(0, -keep).join("."), value: pagesHost }];
}
