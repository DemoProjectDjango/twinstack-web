import Stripe from "stripe";
import { config } from "./config.js";
import { creditsForDollars } from "./credits.js";
import {
  createPurchase,
  endPurchase,
  setPurchaseFee,
  findPurchaseBySession,
  getStripeCustomerId,
  payPurchase,
  setPurchaseCheckout,
  setStripeCustomerId,
  takeBackPurchase,
} from "./db.js";

// Paying for credits with Stripe Checkout (config.purchases === "stripe"). Buying creates a pending
// purchase and a Checkout Session for it, and the browser goes to Stripe's payment page. The
// credits are added once Stripe says the payment went through: by its webhook
// (POST /api/stripe/webhook, index.js), or by settleCheckout when the browser comes back and asks,
// whichever is first (payPurchase credits a purchase only once). Refunds and disputes arrive only
// by webhook and take the credits back, stopping at a balance of zero.

const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;
// Test and live keys see separate customers, so each account keeps one of each.
const MODE = /^[sr]k_live_/.test(config.stripe.secretKey ?? "") ? "live" : "test";
// The shortest Stripe allows. An abandoned payment page ends (and its purchase with it) soon after.
const CHECKOUT_MINUTES = 30;

if (stripe && !config.stripe.webhookSecret) {
  console.warn("STRIPE_WEBHOOK_SECRET isn't set: credits are added when the buyer returns from Stripe, and refunds aren't seen.");
}

export class CheckoutError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The address on this app (CLIENT_URL) Stripe sends the buyer back to, with `checkout=<value>`. */
function returnUrl(returnTo, value) {
  const base = new URL(config.clientUrl);
  const url = new URL(typeof returnTo === "string" && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/credits", base);
  if (url.origin !== base.origin) return returnUrl("/credits", value);
  url.searchParams.delete("checkout");
  url.hash = "";
  // Added by hand: Stripe fills in {CHECKOUT_SESSION_ID} only when its braces aren't encoded.
  return `${url.href}${url.search ? "&" : "?"}checkout=${value}`;
}

async function customerFor(user) {
  const known = await getStripeCustomerId(user.id, MODE);
  if (known) return known;
  const customer = await stripe.customers.create(
    { email: user.email, name: user.name || undefined, metadata: { userId: user.id } },
    { idempotencyKey: `customer-${MODE}-${user.id}` },
  );
  await setStripeCustomerId(user.id, MODE, customer.id);
  return customer.id;
}

/**
 * Starts paying `dollars` for credits: a pending purchase and its Checkout Session. Returns the
 * payment page's address. `returnTo` is the path on this app to come back to.
 */
export async function startCheckout({ user, dollars, returnTo }) {
  const credits = creditsForDollars(dollars);
  if (!credits) throw new CheckoutError("Choose an amount the page offers.");
  const purchase = await createPurchase({
    userId: user.id,
    buyer: user,
    credits,
    priceCents: dollars * 100,
    currency: "usd",
    provider: "stripe",
    livemode: MODE === "live",
  });
  const metadata = { purchaseId: purchase.id, userId: user.id };
  try {
    const customer = await customerFor(user);
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer,
        client_reference_id: purchase.id,
        metadata,
        payment_intent_data: { metadata },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: dollars * 100,
              product_data: { name: `${credits.toLocaleString("en-US")} Claude credits`, description: "Credits for Claude in Twinstack" },
            },
          },
        ],
        success_url: returnUrl(returnTo, "{CHECKOUT_SESSION_ID}"),
        cancel_url: returnUrl(returnTo, "cancelled"),
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60,
      },
      { idempotencyKey: `checkout-${purchase.id}` },
    );
    await setPurchaseCheckout(purchase.id, session.id);
    return session.url;
  } catch (err) {
    await endPurchase(purchase.id, "failed");
    if (err instanceof Stripe.errors.StripeError) {
      console.error(`Stripe couldn't start a checkout: ${err.message}`);
      throw new CheckoutError("The payment page couldn't be opened. Please try again.", 502);
    }
    throw err;
  }
}

/** What a paid session's purchase keeps for the admin's list (payPurchase). */
function paymentDetails(session) {
  const intent = typeof session.payment_intent === "object" ? session.payment_intent : null;
  const charge = typeof intent?.latest_charge === "object" ? intent.latest_charge : null;
  const fee = typeof charge?.balance_transaction === "object" ? charge.balance_transaction?.fee : null;
  const card = charge?.payment_method_details?.card;
  return {
    paymentIntentId: intent?.id ?? (typeof session.payment_intent === "string" ? session.payment_intent : null),
    customerId: typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null),
    amountPaidCents: session.amount_total,
    feeCents: typeof fee === "number" ? fee : null,
    receiptUrl: charge?.receipt_url ?? null,
    // Not a card (a wallet or bank payment): the method's type instead.
    card: card ? { brand: card.brand, last4: card.last4, country: card.country } : null,
    method: charge?.payment_method_details?.type ?? null,
  };
}

/** Brings a purchase in line with its Checkout Session: paid (credits added) or expired. */
export async function settleCheckout(sessionId) {
  const purchase = await findPurchaseBySession(sessionId);
  if (!purchase || purchase.status !== "pending") return;
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent.latest_charge.balance_transaction"] });
  if (session.metadata?.purchaseId !== purchase.id) return;
  if (session.payment_status === "paid") {
    if (session.amount_total !== purchase.priceCents || session.currency !== purchase.currency) {
      console.error(`Checkout ${sessionId} was paid ${session.amount_total} ${session.currency}, not ${purchase.priceCents} ${purchase.currency}.`);
      return;
    }
    await payPurchase(purchase.id, paymentDetails(session));
  } else if (session.status === "expired") {
    await endPurchase(purchase.id, "expired");
  }
}

/** The purchase made with that Checkout Session, brought up to date first, or null if it isn't theirs. */
export async function checkoutStatus(userId, sessionId) {
  const purchase = await findPurchaseBySession(sessionId, userId);
  if (!purchase) return null;
  if (purchase.status !== "pending") return purchase;
  await settleCheckout(sessionId);
  return findPurchaseBySession(sessionId, userId);
}

const paymentIntentOf = (object) => (typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id);

/** POST /api/stripe/webhook, with the raw body Stripe signed. A 500 makes Stripe send it again. */
export async function stripeWebhook(req, res) {
  if (!stripe || !config.stripe.webhookSecret) return res.status(404).json({ error: "Not found" });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get("stripe-signature") ?? "", config.stripe.webhookSecret);
  } catch {
    return res.status(400).json({ error: "Invalid signature" });
  }
  const object = event.data.object;
  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.expired":
        await settleCheckout(object.id);
        break;
      case "checkout.session.async_payment_failed": {
        const purchase = await findPurchaseBySession(object.id);
        if (purchase) await endPurchase(purchase.id, "failed");
        break;
      }
      case "charge.refunded":
        if (object.amount > 0) {
          const share = object.amount_refunded / object.amount;
          await takeBackPurchase(paymentIntentOf(object), {
            share,
            status: share >= 1 ? "refunded" : "part-refunded",
            amounts: { refundedCents: object.amount_refunded },
          });
        }
        break;
      // Stripe often fills in a charge's fee after the payment completes: record it then.
      case "charge.updated":
        if (object.status === "succeeded" && object.balance_transaction) {
          const tx = typeof object.balance_transaction === "string" ? await stripe.balanceTransactions.retrieve(object.balance_transaction) : object.balance_transaction;
          if (typeof tx?.fee === "number") await setPurchaseFee(paymentIntentOf(object), tx.fee);
        }
        break;
      case "charge.dispute.created":
        await takeBackPurchase(paymentIntentOf(object), { share: 1, status: "disputed", amounts: { disputedCents: object.amount } });
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error(`Stripe event ${event.id} (${event.type}) failed:`, err);
    res.status(500).json({ error: "Not handled" });
  }
}
