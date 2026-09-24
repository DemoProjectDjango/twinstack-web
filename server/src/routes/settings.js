import { Router } from "express";
import { requireAuth, setSession } from "../session.js";

// The user's own Anthropic API key. It's stored only in their encrypted
// session cookie and handed to site scripts as ANTHROPIC_API_KEY when a
// Claude command runs; it is never returned to the browser in full.

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;

function hint(key) {
  return key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null;
}

settingsRouter.get("/", (req, res) => {
  res.json({ anthropicKey: hint(req.session.anthropicKey) });
});

settingsRouter.put("/anthropic-key", async (req, res) => {
  if (!req.is("application/json")) return res.status(415).json({ error: "Expected JSON" });
  const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
  if (!KEY_PATTERN.test(key)) {
    return res.status(400).json({ error: "That doesn't look like an Anthropic API key (sk-ant-…)." });
  }

  // Listing models costs nothing and proves the key works before it's saved.
  let check;
  try {
    check = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
  } catch {
    return res.status(502).json({ error: "Couldn't reach Anthropic to verify the key. Try again." });
  }
  if (check.status === 401 || check.status === 403) {
    return res.status(400).json({ error: "Anthropic rejected that key." });
  }
  if (!check.ok) return res.status(502).json({ error: `Couldn't verify the key (Anthropic returned ${check.status}).` });

  req.session = { ...req.session, anthropicKey: key };
  await setSession(res, req.session);
  res.json({ anthropicKey: hint(key) });
});

settingsRouter.delete("/anthropic-key", async (req, res) => {
  req.session = { ...req.session, anthropicKey: null };
  await setSession(res, req.session);
  res.json({ anthropicKey: null });
});
