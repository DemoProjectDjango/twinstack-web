"use client";

import { useId } from "react";
import type { Json } from "@/lib/site-api";
import { Button, inputClass } from "./ui";

// A form for a JSON value whose structure comes from the file's current
// contents (`shape`): the same fields, the same types, lists that can grow
// and shrink. Fields that only some list items have are optional and are
// dropped when left empty, so saving never adds empty keys.

type JsonObject = { [key: string]: Json };

const LONG_TEXT_KEYS = new Set(["text", "body", "answer", "quote", "description", "footerTagline", "content"]);

const isObject = (value: Json | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** "footerTagline" → "Footer tagline", "linkUrl" → "Link URL". */
export function humanise(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\burl\b/g, "URL");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The shape of one list item: the union of the items' fields, plus which are in every item. */
function itemShape(list: Json[]): { template: Json | undefined; required: Set<string> } {
  if (!list.length) return { template: undefined, required: new Set() };
  if (!list.every(isObject)) return { template: list[0], required: new Set() };
  const template: JsonObject = {};
  for (const item of list as JsonObject[]) for (const [k, v] of Object.entries(item)) if (!(k in template)) template[k] = v;
  const required = new Set(Object.keys(template).filter((k) => (list as JsonObject[]).every((item) => k in item)));
  return { template, required };
}

/** An empty value of the same shape, for a new list item. */
function blank(shape: Json | undefined, required?: Set<string>): Json {
  if (Array.isArray(shape)) return [];
  if (isObject(shape)) {
    return Object.fromEntries(
      Object.entries(shape)
        .filter(([k]) => !required || required.has(k))
        .map(([k, v]) => [k, blank(v)]),
    );
  }
  if (typeof shape === "number") return 0;
  if (typeof shape === "boolean") return false;
  return "";
}

/** A short title for a list item card, from its first text field. */
function itemTitle(item: Json, index: number) {
  if (isObject(item)) {
    const text = Object.entries(item).find(([k, v]) => !k.startsWith("_") && typeof v === "string" && v.trim());
    if (text) return String(text[1]).slice(0, 70);
  }
  return `Item ${index + 1}`;
}

export function JsonForm({
  value,
  shape,
  onChange,
  disabled,
}: {
  value: Json;
  shape: Json;
  onChange: (next: Json) => void;
  disabled?: boolean;
}) {
  return (
    <Node
      value={value}
      shape={shape}
      onChange={(next) => onChange(next === undefined ? blank(shape) : next)}
      disabled={disabled}
      label={null}
      fieldKey=""
    />
  );
}

function Node({
  value,
  shape,
  onChange,
  disabled,
  label,
  fieldKey,
}: {
  value: Json | undefined;
  shape: Json | undefined;
  onChange: (next: Json | undefined) => void;
  disabled?: boolean;
  label: string | null;
  fieldKey: string;
}) {
  const id = useId();
  if (Array.isArray(shape)) {
    return <ListNode value={Array.isArray(value) ? value : []} shape={shape} onChange={onChange} disabled={disabled} label={label} />;
  }

  if (isObject(shape)) {
    const current = isObject(value) ? value : {};
    return (
      <fieldset className={label ? "space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800" : "space-y-3"}>
        {label && <legend className="px-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</legend>}
        {Object.keys(shape).map((key) =>
          key.startsWith("_") ? (
            // Comments in the file explain it; show them, never edit them.
            <p key={key} className="text-xs text-zinc-500">
              {String(current[key] ?? shape[key])}
            </p>
          ) : (
            <Node
              key={key}
              value={current[key]}
              shape={shape[key]}
              fieldKey={key}
              label={humanise(key)}
              disabled={disabled}
              onChange={(next) => {
                const copy = { ...current };
                if (next === undefined) delete copy[key];
                else copy[key] = next;
                onChange(copy);
              }}
            />
          ),
        )}
      </fieldset>
    );
  }

  if (typeof shape === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
        {label}
      </label>
    );
  }

  const input =
    typeof shape === "number" ? (
      <input
        id={id}
        type="number"
        value={typeof value === "number" ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        className={inputClass}
        disabled={disabled}
      />
    ) : // Decided by the file's existing value, so the field doesn't swap element (and lose focus) while typing.
      LONG_TEXT_KEYS.has(fieldKey) || (typeof shape === "string" && shape.length > 80) ? (
      <textarea
        id={id}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className={inputClass}
        disabled={disabled}
      />
    ) : (
      <input
        id={id}
        value={typeof value === "string" ? value : value === null || value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
        disabled={disabled}
      />
    );

  if (!label) return input;
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
        {label}
      </label>
      <div className="mt-1">{input}</div>
    </div>
  );
}

function ListNode({
  value,
  shape,
  onChange,
  disabled,
  label,
}: {
  value: Json[];
  shape: Json[];
  onChange: (next: Json) => void;
  disabled?: boolean;
  label: string | null;
}) {
  const { template, required } = itemShape(shape);
  const objects = isObject(template);

  function update(index: number, next: Json | undefined) {
    const copy = [...value];
    if (next === undefined) copy.splice(index, 1);
    else copy[index] = objects ? dropEmptyOptional(next, required) : next;
    onChange(copy);
  }

  function move(index: number, by: number) {
    const target = index + by;
    if (target < 0 || target >= value.length) return;
    const copy = [...value];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    onChange(copy);
  }

  return (
    <div className="space-y-2">
      {label && <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</p>}
      {value.length === 0 && <p className="text-sm text-zinc-500">None yet.</p>}
      <ol className="space-y-2">
        {value.map((item, index) => (
          <li key={index} className={objects ? "rounded-md border border-zinc-200 p-3 dark:border-zinc-800" : "flex items-center gap-2"}>
            {objects ? (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{itemTitle(item, index)}</span>
                  <ItemActions index={index} count={value.length} disabled={disabled} onMove={move} onRemove={() => update(index, undefined)} />
                </div>
                <Node value={item} shape={template} onChange={(next) => update(index, next)} disabled={disabled} label={null} fieldKey="" />
              </>
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <Node value={item} shape={template ?? ""} onChange={(next) => update(index, next)} disabled={disabled} label={null} fieldKey="" />
                </div>
                <ItemActions index={index} count={value.length} disabled={disabled} onMove={move} onRemove={() => update(index, undefined)} />
              </>
            )}
          </li>
        ))}
      </ol>
      <Button className="text-xs" disabled={disabled} onClick={() => onChange([...value, blank(template, required)])}>
        + Add {objects ? "item" : "entry"}
      </Button>
    </div>
  );
}

/** Optional fields (not in every item) left empty are removed rather than saved as "". */
function dropEmptyOptional(item: Json, required: Set<string>): Json {
  if (!isObject(item)) return item;
  return Object.fromEntries(
    Object.entries(item).filter(([k, v]) => required.has(k) || k.startsWith("_") || (v !== "" && v !== false)),
  );
}

function ItemActions({
  index,
  count,
  disabled,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  disabled?: boolean;
  onMove: (index: number, by: number) => void;
  onRemove: () => void;
}) {
  const small = "px-2 py-0.5 text-xs";
  return (
    <span className="flex shrink-0 gap-1">
      <Button variant="ghost" className={small} disabled={disabled || index === 0} onClick={() => onMove(index, -1)} aria-label="Move up">
        ↑
      </Button>
      <Button variant="ghost" className={small} disabled={disabled || index === count - 1} onClick={() => onMove(index, 1)} aria-label="Move down">
        ↓
      </Button>
      <Button variant="ghost" className={small} disabled={disabled} onClick={onRemove} aria-label="Remove">
        Remove
      </Button>
    </span>
  );
}
