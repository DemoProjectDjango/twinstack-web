import { Router } from "express";
import { CLAUDE_MODELS, isClaudeModel } from "../claude-models.js";
import { clearAnthropicKey, getAnthropicKeyHint, getClaudeModel, setAnthropicKey, setClaudeModel } from "../db.js";
import { OWN_KEYS } from "../credits.js";
import { requireAuth } from "../session.js";

// The user's own Anthropic API key, stored encrypted in MongoDB (see db.js)
// and handed to site scripts as ANTHROPIC_API_KEY only when a Claude command
// runs. The browser only ever sees a masked hint. Off while OWN_KEYS (credits.js)
// is false. Also the Claude model the account uses, for the assistant and the
// site's scripts alike.

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`${req.method} ${req.originalUrl} failed:`, err);
      res.status(500).json({ error: "Couldn't update your settings. Try again." });
    }
  };
}

settingsRouter.get(
  "/",
  handle(async (req, res) => {
    res.json({
      // While OWN_KEYS is off nobody sees or sets a key: everyone uses credits.
      ownKeys: OWN_KEYS,
      anthropicKey: OWN_KEYS ? await getAnthropicKeyHint(req.user.id) : null,
      model: await getClaudeModel(req.user.id),
      models: CLAUDE_MODELS,
    });
  }),
);

settingsRouter.put(
  "/model",
  handle(async (req, res) => {
    if (!req.is("application/json")) return res.status(415).json({ error: "Expected JSON" });
    const model = req.body?.model;
    if (!isClaudeModel(model)) return res.status(400).json({ error: "Choose one of the models listed." });
    await setClaudeModel(req.user.id, model);
    res.json({ model });
  }),
);

settingsRouter.put(
  "/anthropic-key",
  handle(async (req, res) => {
    if (!req.is("application/json")) return res.status(415).json({ error: "Expected JSON" });
    if (!OWN_KEYS) return res.status(403).json({ error: "Claude runs on your credits; your own Anthropic key can't be used." });
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

    await setAnthropicKey(req.user.id, key);
    res.json({ anthropicKey: await getAnthropicKeyHint(req.user.id) });
  }),
);

settingsRouter.delete(
  "/anthropic-key",
  handle(async (req, res) => {
    await clearAnthropicKey(req.user.id);
    res.json({ anthropicKey: null });
  }),
);
