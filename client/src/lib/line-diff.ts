// Line diff for the live "changes" view next to the markdown editors. Runs in
// the browser on every edit, so it trims the common start and end first and
// only runs the LCS table on what's left.

export type DiffLine = { kind: "same" | "add" | "del"; text: string; oldNo: number | null; newNo: number | null };
export type Hunk = { lines: DiffLine[] };

// Past this many cells (changed old lines × changed new lines) the middle is
// shown as removed-then-added instead of aligned line by line.
const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  const same = (i: number, j: number) => out.push({ kind: "same", text: a[i], oldNo: i + 1, newNo: j + 1 });
  const del = (i: number) => out.push({ kind: "del", text: a[i], oldNo: i + 1, newNo: null });
  const add = (j: number) => out.push({ kind: "add", text: b[j], oldNo: null, newNo: j + 1 });

  for (let i = 0; i < start; i++) same(i, i);

  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) {
    for (let i = start; i < endA; i++) del(i);
    for (let j = start; j < endB; j++) add(j);
  } else {
    // lcs[i][j]: longest common subsequence of a[start+i..endA) and b[start+j..endB).
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[start + i] === b[start + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        same(start + i++, start + j++);
      } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
        add(start + j++);
      } else {
        del(start + i++);
      }
    }
  }

  for (let i = endA, j = endB; i < a.length; i++, j++) same(i, j);
  return out;
}

/** The changed lines with `context` unchanged lines around each run; nearby runs share a hunk. */
export function toHunks(lines: DiffLine[], context = 3): Hunk[] {
  const hunks: Hunk[] = [];
  let current: DiffLine[] | null = null;
  let lastChange = -Infinity;

  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    if (current && index - lastChange <= context * 2 + 1) {
      current.push(...lines.slice(lastChange + 1, index + 1));
    } else {
      if (current) current.push(...lines.slice(lastChange + 1, Math.min(lines.length, lastChange + 1 + context)));
      current = [...lines.slice(Math.max(0, index - context), index + 1)];
      hunks.push({ lines: current });
    }
    lastChange = index;
  });
  if (current) (current as DiffLine[]).push(...lines.slice(lastChange + 1, Math.min(lines.length, lastChange + 1 + context)));
  return hunks;
}
