"use client";

import { useEffect, useSyncExternalStore } from "react";

// Light, dark or the computer's own setting ("system", the default), for the whole app (never the
// customer's site shown in the preview). The choice is kept per browser; THEME_SCRIPT in the root
// layout applies it before the first paint, so a page never flashes the wrong colours. Tailwind's
// `dark:` styles and the colour variables in globals.css follow the `dark` class on <html>.

export type Theme = "system" | "light" | "dark";
export const THEME_KEY = "twinstack:theme";
const ORDER: Theme[] = ["system", "light", "dark"];
const LABEL: Record<Theme, string> = { system: "Same as my computer", light: "Light", dark: "Dark" };

/** Runs in <head> before anything paints (kept tiny and dependency-free). */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");var d=t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

function readTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

// The saved choice as a store, so every toggle on the page (the navbar's and the editor's) agrees.
const CHANGED = "twinstack:theme-changed";
function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function ThemeToggle() {
  // The server can't read the browser's choice, so it renders "system" and the browser corrects it.
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as Theme);

  useEffect(() => {
    apply(theme);
  }, [theme]);

  // "Same as my computer" follows the computer when it switches (sunset, a settings change).
  useEffect(() => {
    if (theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => apply("system");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [theme]);

  function choose(next: Theme) {
    try {
      if (next === "system") window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // It applies to this page only.
    }
    apply(next);
    window.dispatchEvent(new Event(CHANGED));
  }

  const shown = theme;
  const next = ORDER[(ORDER.indexOf(shown) + 1) % ORDER.length];
  return (
    <button
      type="button"
      onClick={() => choose(next)}
      title={`Colours: ${LABEL[shown]}. Click for ${LABEL[next].toLowerCase()}.`}
      aria-label={`Colours: ${LABEL[shown]}. Switch to ${LABEL[next].toLowerCase()}.`}
      data-theme-toggle={shown}
      className="grid size-8 shrink-0 place-items-center rounded-md border border-zinc-300 text-zinc-600 hover:bg-zinc-100 hover:text-foreground dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {shown === "light" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : shown === "dark" ? (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        ) : (
          <>
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M8 20h8M12 16v4" />
          </>
        )}
      </svg>
    </button>
  );
}
