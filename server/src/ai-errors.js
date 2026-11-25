// What people are told when an AI request fails. They never see a provider's error, a status code,
// raw JSON or a provider or model name: the app's own providers being out of balance, refusing its
// key or overloaded all read as a short maintenance (ai-failover.js has already tried every other
// provider by then), and their credits weren't used for it. Running out of the account's OWN credits
// is a different message (credits.js: OUT_OF_CREDITS, with its "buy more" flow), and so is an own
// API key that's refused. No imports: jobs.js and the tests use it on its own.

/** The app's providers are all out or unavailable, but the account still has credits. */
export const AI_BUSY = "The AI is busy right now (short maintenance). Please try again in about 10 minutes. Your credits weren't used.";

/** The account's own API key (Settings) was refused: theirs to fix. */
export const OWN_KEY_REFUSED = "Your own API key in Settings was refused. Check it, or remove it to use your credits.";

/** A request the AI couldn't handle (not a provider outage), in plain words. */
export const AI_FAILED = "The AI couldn't handle this request. Please try again, or ask in a different way.";

/** Thrown when no provider could take a request (ai-failover.js). Its message is AI_BUSY. */
export class AiUnavailableError extends Error {
  constructor(cause = null) {
    super(AI_BUSY);
    this.name = "AiUnavailableError";
    this.cause = cause;
  }
}

/* ------------------------------------------------------------ job logs */

// The site's scripts print a failed request's error as it came back ("Anthropic API 400: {...}"),
// and the Anthropic SDK's errors read "400 {...}". Either way the line reaches the job's log, which
// owners read ("See what it's doing") and whose last line is shown as the job's error. A line
// carrying one is rewritten here: the error part becomes plain words, what came before it stays.
const ERROR_START =
  /(?:\b\d{3}\s+(?=\{))?(?:\b(?:Anthropic|OpenAI|DeepSeek|Claude) API\b|\{\s*"type"\s*:\s*"error"|\{\s*"error"\s*:|\bcredit balance is too low\b|\binsufficient_quota\b|\bInsufficient Balance\b|\binvalid x-api-key\b|\b(?:overloaded_error|api_error|authentication_error|permission_error|rate_limit_error|invalid_request_error|not_found_error|request_too_large)\b)/i;
// Signs the failure was the provider's (balance, key, load), not the request's.
const OUTAGE = /credit balance|insufficient|quota|billing|x-api-key|authentication|permission|overloaded|api_error|rate.?limit|\b(?:401|403|408|429|5\d\d)\b|ECONNRE|ETIMEDOUT|fetch failed/i;
// The app's own errors (claude-proxy.js, and the account's limits in credits.js) are shown as their
// message; a provider's never is.
const APP_MESSAGE = /^(?:The AI is busy right now|You're running a lot of AI work|You've reached today's limit|This AI run has ended|This request is too big to send to the AI|The request isn't (?:valid JSON|an AI message)|This model isn't available on this server|Only web search and the script's own tools|max_tokens must be a whole number|[\w, ]+ can't be used on this server)/;
// Lines that ended a run: the full message; others (a fallback the script carries on from) a short one.
const FINAL_LINE = /^\s*(?:[\w ]+ (?:failed|stopped)|Can't [\w ]+|Error):/i;

/** The `"message"` inside the error JSON on the line, or null. */
function messageIn(text) {
  const found = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!found) return null;
  try {
    return JSON.parse(`"${found[1]}"`);
  } catch {
    return null;
  }
}

/**
 * One line of a job's log with any provider error in it put in plain words. The app's own errors
 * (the proxy's maintenance message, the account's limits) are shown as their message. A line about
 * the account's own credits running out (billing_error) is kept as it is: the browser looks for it
 * to offer more credits.
 */
export function neutralLine(line) {
  if (/billing_error/.test(line)) return line;
  const start = line.search(ERROR_START);
  if (start < 0) return line;
  const before = line.slice(0, start);
  const error = line.slice(start);
  const own = messageIn(error);
  let words;
  if (own && APP_MESSAGE.test(own)) words = own;
  else if (OUTAGE.test(error)) words = FINAL_LINE.test(line) || !before.trim() ? AI_BUSY : "the AI service is busy right now.";
  else words = FINAL_LINE.test(line) || !before.trim() ? AI_FAILED : "the AI couldn't handle the request.";
  // "(…)" around the error stays balanced: the rest of the line after it is dropped with it.
  const open = (before.match(/\(/g) ?? []).length - (before.match(/\)/g) ?? []).length;
  const text = `${before}${words}`;
  return open > 0 ? `${text.replace(/\.$/, "")}${")".repeat(open)}${/\.\s*$/.test(error) ? "." : ""}` : text;
}

/** `text` (one or more lines) with neutralLine applied to each. */
export function neutralText(text) {
  if (!ERROR_START.test(text)) return text;
  return text
    .split("\n")
    .map((line) => neutralLine(line))
    .join("\n");
}
