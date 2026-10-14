import { config } from "./config.js";

// Plain-text emails through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email).
// Without RESEND_API_KEY the email is written to the server log, so development works without it.
// Plain text only: names and messages people typed go in as text, never as HTML.

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 15_000;

/** Sends one email. Never throws: returns false (and logs why) when it couldn't be sent. */
export async function sendEmail({ to, subject, text }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return false;
  // A typed name can't add lines to the subject.
  const cleanSubject = subject.replace(/[\r\n]+/g, " ").slice(0, 200);

  if (!config.email.resendKey) {
    console.log(`[email not sent: RESEND_API_KEY isn't set]\nTo: ${recipients.join(", ")}\nSubject: ${cleanSubject}\n\n${text}\n`);
    return false;
  }
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.email.resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.email.from, to: recipients, subject: cleanSubject, text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Email "${cleanSubject}" wasn't sent: Resend returned ${res.status} ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Email "${cleanSubject}" wasn't sent: ${err.message}`);
    return false;
  }
}
