// The rules of kit-fill.js with no imports, so they can be tested without the server's settings.
// `fill` is kit.json's map `{ "<data file>": ["<field>", …] }`; a file whose JSON is an object with
// an `items` list fills those fields of each item, any other object fills them on the object itself.

const BAD_TEXT = /[<>`]|\{\{|\}\}|\{|\}/;

/** The fields of `file`'s data that may change: a list of objects (its `items`), or one object. */
function targets(data) {
  if (Array.isArray(data?.items)) return { list: true, rows: data.items };
  return data && typeof data === "object" ? { list: false, rows: [data] } : null;
}

/** What goes to the model: `{ file: [ {field: text}, … ] }` for lists, `{ file: {field: text} }` for single objects. */
export function buildFillRequest(fill, files) {
  const request = {};
  for (const [file, fields] of Object.entries(fill)) {
    const t = targets(files[file]);
    if (!t) continue;
    const rows = t.rows.map((row) => Object.fromEntries(fields.filter((f) => typeof row?.[f] === "string" && row[f].trim()).map((f) => [f, row[f]])));
    if (!rows.some((r) => Object.keys(r).length)) continue;
    request[file] = t.list ? rows : rows[0];
  }
  return Object.keys(request).length ? request : null;
}

/** The longest a rewritten value may be: twice the sample's, at least 80 characters. */
const limit = (sample) => Math.max(80, sample.length * 2);

/**
 * The model's reply cut down to what's allowed. A reply that isn't the shape that was sent (a file
 * missing, a list of another length) is refused whole: `{ problem }`. Otherwise resolves to
 * `{ value: { file: reply part }, problems }`, where a field that's missing, empty, too long or has
 * markup or braces is `null` (the sample's wording stays) and is named in `problems`, so one bad
 * sentence never costs the rest.
 */
export function checkFill(fill, files, reply) {
  const sent = buildFillRequest(fill, files);
  if (!sent) return { problem: "nothing was sent" };
  const out = {};
  const problems = [];
  for (const [file, expected] of Object.entries(sent)) {
    const got = reply[file];
    const list = Array.isArray(expected);
    if (list ? !Array.isArray(got) || got.length !== expected.length : !got || typeof got !== "object" || Array.isArray(got)) {
      return { problem: `${file} isn't the shape that was sent` };
    }
    const rows = list ? got : [got];
    const sentRows = list ? expected : [expected];
    const clean = sentRows.map((sentRow, i) => {
      const row = {};
      for (const [field, sample] of Object.entries(sentRow)) {
        const where = `${file} ${list ? `item ${i + 1} ` : ""}${field}`;
        const value = rows[i]?.[field];
        const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
        const problem = typeof value !== "string" ? "is missing" : !text ? "is empty" : text.length > limit(sample) ? `is too long (${text.length} against ${limit(sample)})` : BAD_TEXT.test(text) ? "has markup or braces" : null;
        if (problem) problems.push(`${where} ${problem}`);
        row[field] = problem ? null : text;
      }
      return row;
    });
    out[file] = list ? clean : clean[0];
  }
  return { value: out, problems };
}

/**
 * `data` with the checked `value` written in. Resolves to the new data and how many strings changed.
 * Other fields (numbers, dates, names, images), the `sample` marks and any other keys are kept. The
 * template's photos don't change, so a new title empties the item's `imageAlt` (the photo becomes
 * decorative) rather than describing a picture that's now something else.
 */
export function mergeFill(data, value, fields) {
  const copy = structuredClone(data);
  const t = targets(copy);
  const parts = Array.isArray(value) ? value : [value];
  let changed = 0;
  t.rows.forEach((row, i) => {
    for (const field of fields) {
      const next = parts[i]?.[field];
      if (typeof next !== "string" || next === row[field]) continue;
      row[field] = next;
      changed++;
      if (field === "title" && "imageAlt" in row) row.imageAlt = "";
    }
  });
  return { data: copy, changed };
}
