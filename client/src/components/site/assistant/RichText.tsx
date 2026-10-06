import type { ReactNode } from "react";

// Claude's replies are short Markdown: paragraphs, bullet and numbered lists, **bold**, `code`
// and links. Rendered as React elements (never as HTML), so nothing in a reply can run.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const token = match[0];
    if (token.startsWith("**")) out.push(<strong key={index}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) out.push(<code key={index} className="rounded bg-zinc-100 px-1 font-mono text-[0.85em] dark:bg-zinc-800">{token.slice(1, -1)}</code>);
    else {
      const label = token.slice(1, token.indexOf("]("));
      out.push(
        <a key={index} href={match[2]} target="_blank" rel="noreferrer" className="underline">
          {label}
        </a>,
      );
    }
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block = { kind: "p" | "ul" | "ol" | "h"; lines: string[] };

function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const last = out.at(-1);
    if (!line.trim()) {
      out.push({ kind: "p", lines: [] });
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (bullet) {
      if (last?.kind === "ul") last.lines.push(bullet[1]);
      else out.push({ kind: "ul", lines: [bullet[1]] });
    } else if (numbered) {
      if (last?.kind === "ol") last.lines.push(numbered[1]);
      else out.push({ kind: "ol", lines: [numbered[1]] });
    } else if (heading) {
      out.push({ kind: "h", lines: [heading[1]] });
    } else if (last?.kind === "p" && last.lines.length) {
      last.lines.push(line);
    } else {
      out.push({ kind: "p", lines: [line] });
    }
  }
  return out.filter((b) => b.lines.length);
}

export function RichText({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks(text).map((block, i) => {
        if (block.kind === "ul" || block.kind === "ol") {
          const List = block.kind;
          return (
            <List key={i} className={`space-y-1 pl-5 ${block.kind === "ul" ? "list-disc" : "list-decimal"}`}>
              {block.lines.map((line, j) => (
                <li key={j}>{inline(line)}</li>
              ))}
            </List>
          );
        }
        if (block.kind === "h") {
          return (
            <p key={i} className="font-semibold">
              {inline(block.lines[0])}
            </p>
          );
        }
        return (
          <p key={i}>
            {block.lines.map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {inline(line)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
