import { Router } from "express";
import { config } from "../config.js";
import { listAccessRequests, publicUser, requestAccess, setAccessStatus } from "../db.js";
import { sendEmail } from "../email.js";
import { requireAuth } from "../session.js";
import { requireJson } from "./helpers.js";

// Who may create sites. An account asks once (POST /api/access/request), which emails the admins
// (ADMIN_EMAILS); an admin approves or denies it on /admin/access, which emails the account.
// Approving is a POST from that page, never a link in an email: mail scanners open links.

const MAX_MESSAGE = 500;

export const accessRouter = Router();
accessRouter.use(requireAuth, requireJson);

accessRouter.post("/request", async (req, res) => {
  const { status } = req.user.access;
  if (status !== "none") {
    return res.status(409).json({ error: status === "pending" ? "Your request has already been sent." : "Your account already has an answer." });
  }
  const raw = req.body?.message;
  const message = typeof raw === "string" ? raw.trim().slice(0, MAX_MESSAGE) : "";
  try {
    if (!(await requestAccess(req.user.id, message))) {
      return res.status(409).json({ error: "Your request has already been sent." });
    }
  } catch (err) {
    console.error("Failed to save an access request:", err);
    return res.status(500).json({ error: "Your request couldn't be sent. Please try again." });
  }

  const who = req.user.name ? `${req.user.name} (${req.user.email})` : req.user.email;
  void sendEmail({
    to: config.adminEmails,
    subject: `Twinstack: ${who} asks to create websites`,
    text: [
      `${who} asked for access to create websites on Twinstack.`,
      req.user.github ? `GitHub: @${req.user.github.login}` : "GitHub: not connected yet",
      message ? `\nTheir message:\n${message}` : "",
      `\nApprove or deny it here: ${config.clientUrl}/admin/access`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  res.json({ access: { status: "pending", requestedAt: new Date().toISOString() } });
});

export const adminRouter = Router();
adminRouter.use(requireAuth, requireJson, (req, res, next) => {
  if (!req.user.admin) return res.status(403).json({ error: "Only an admin can do that." });
  next();
});

adminRouter.get("/access", async (req, res) => {
  res.json({ requests: await listAccessRequests() });
});

adminRouter.post("/access/:id", async (req, res) => {
  const status = req.body?.status;
  if (status !== "approved" && status !== "denied") {
    return res.status(400).json({ error: 'Status must be "approved" or "denied".' });
  }
  const account = await setAccessStatus(req.params.id, status, req.user.email);
  if (!account) return res.status(404).json({ error: "There's no such account." });

  const user = publicUser(account);
  const greeting = user.name ? `Hi ${user.name.trim().split(/\s+/)[0]},` : "Hi,";
  const emailed = await sendEmail(
    status === "approved"
      ? {
          to: user.email,
          subject: "You can now create your website on Twinstack",
          text: [
            greeting,
            "",
            "Good news: your Twinstack account has been approved. You can now create your website.",
            "",
            user.github
              ? `Open ${config.clientUrl}/dashboard and click "Create my site".`
              : `Open ${config.clientUrl}/dashboard, connect GitHub (it's free, and the page explains each step), then click "Create my site".`,
          ].join("\n"),
        }
      : {
          to: user.email,
          subject: "About your Twinstack request",
          text: [greeting, "", "Sorry, we can't give your account access to create websites at the moment."].join("\n"),
        },
  );
  res.json({ requests: await listAccessRequests(), emailed });
});
