// Cirrus Weather — Cloudflare Worker
// Handles Stripe checkout, webhooks, subscription checks, and beta code redemption.
//
// Environment variables (set in Cloudflare dashboard → Worker → Settings → Variables):
//   STRIPE_SECRET_KEY        sk_live_... (or sk_test_... for testing)
//   STRIPE_WEBHOOK_SECRET    whsec_...   (from Stripe → Webhooks → signing secret)
//   STRIPE_MONTHLY_PRICE_ID  price_...   (from Stripe → Products → Cirrus Monthly)
//   STRIPE_ANNUAL_PRICE_ID   price_...   (from Stripe → Products → Cirrus Annual)
//   BETA_CODES               comma-separated list of valid beta codes
//
// KV namespace binding (set in Cloudflare dashboard → Worker → Settings → Bindings):
//   CIRRUS_SUBSCRIPTIONS     KV namespace

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ── Routing ────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/create-checkout-session') {
      return handleCreateCheckout(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/webhook') {
      return handleWebhook(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/check-subscription') {
      return handleCheckSubscription(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/redeem-beta') {
      return handleRedeemBeta(request, env);
    }

    return err('Not found', 404);
  },
};

// ── Create Stripe Checkout Session ─────────────────────────────────────────
async function handleCreateCheckout(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { email, plan } = body; // plan: 'monthly' | 'annual'
  if (!email || !email.includes('@')) return err('Valid email required');
  if (!['monthly', 'annual'].includes(plan)) return err('Invalid plan');

  const priceId = plan === 'annual'
    ? env.STRIPE_ANNUAL_PRICE_ID
    : env.STRIPE_MONTHLY_PRICE_ID;

  const origin = request.headers.get('Origin') || 'https://cirrusweather.app';

  const params = new URLSearchParams({
    'mode': 'subscription',
    'customer_email': email,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'subscription_data[trial_period_days]': '7',
    'allow_promotion_codes': 'true',
    'success_url': `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
    'cancel_url': `${origin}/?cancelled=1`,
  });

  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const session = await resp.json();
  if (!resp.ok) return err(session.error?.message || 'Stripe error', 502);

  return json({ url: session.url });
}

// ── Stripe Webhook Handler ──────────────────────────────────────────────────
async function handleWebhook(request, env) {
  const sig = request.headers.get('stripe-signature');
  const rawBody = await request.text();

  // Verify webhook signature
  let event;
  try {
    event = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return err('Invalid signature', 400);
  }

  const sub = event.data?.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      // Session completed — subscription is now active (trial or paid)
      const email = sub.customer_email || sub.customer_details?.email;
      if (email && sub.subscription) {
        await saveSubscription(env, email, {
          status: 'active',
          subscriptionId: sub.subscription,
          customerId: sub.customer,
          plan: sub.amount_total === 0 ? 'trial' : 'paid',
          createdAt: Date.now(),
        });
      }
      break;
    }
    case 'customer.subscription.updated': {
      const email = await getEmailForCustomer(env, sub.customer);
      if (email) {
        await saveSubscription(env, email, {
          status: sub.status === 'active' ? 'active' : sub.status,
          subscriptionId: sub.id,
          customerId: sub.customer,
          plan: 'paid',
          updatedAt: Date.now(),
        });
      }
      break;
    }
    case 'customer.subscription.deleted': {
      // Subscription cancelled — revoke access at period end
      const email = await getEmailForCustomer(env, sub.customer);
      if (email) {
        const existing = await getSubscription(env, email);
        await saveSubscription(env, email, {
          ...existing,
          status: 'cancelled',
          cancelledAt: Date.now(),
        });
      }
      break;
    }
  }

  return json({ received: true });
}

// ── Check Subscription ──────────────────────────────────────────────────────
async function handleCheckSubscription(request, env) {
  const url = new URL(request.url);
  const email = url.searchParams.get('email')?.toLowerCase().trim();
  if (!email) return err('Email required');

  const sub = await getSubscription(env, email);
  if (!sub) return json({ active: false });

  const active = sub.status === 'active' || sub.status === 'beta';
  return json({ active, plan: sub.plan || null, status: sub.status });
}

// ── Beta Code Redemption ────────────────────────────────────────────────────
async function handleRedeemBeta(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { email, code } = body;
  if (!email || !email.includes('@')) return err('Valid email required');
  if (!code) return err('Code required');

  const validCodes = (env.BETA_CODES || '').split(',').map(c => c.trim().toUpperCase());
  if (!validCodes.includes(code.trim().toUpperCase())) {
    return err('Invalid or expired code', 403);
  }

  // Check if code already used (prevent sharing)
  const usedKey = `beta_code:${code.trim().toUpperCase()}`;
  const usedBy = await env.CIRRUS_SUBSCRIPTIONS.get(usedKey);
  if (usedBy && usedBy !== email.toLowerCase()) {
    return err('Code already redeemed', 403);
  }

  await saveSubscription(env, email.toLowerCase(), {
    status: 'beta',
    plan: 'beta',
    code: code.trim().toUpperCase(),
    grantedAt: Date.now(),
  });
  await env.CIRRUS_SUBSCRIPTIONS.put(usedKey, email.toLowerCase());

  return json({ active: true, plan: 'beta' });
}

// ── KV Helpers ──────────────────────────────────────────────────────────────
function subKey(email) { return `sub:${email.toLowerCase().trim()}`; }
function custKey(customerId) { return `cust:${customerId}`; }

async function getSubscription(env, email) {
  const val = await env.CIRRUS_SUBSCRIPTIONS.get(subKey(email));
  return val ? JSON.parse(val) : null;
}

async function saveSubscription(env, email, data) {
  const key = subKey(email);
  const existing = await getSubscription(env, email) || {};
  const merged = { ...existing, ...data };
  await env.CIRRUS_SUBSCRIPTIONS.put(key, JSON.stringify(merged));
  // Also index by Stripe customer ID so webhook updates can find the email
  if (data.customerId) {
    await env.CIRRUS_SUBSCRIPTIONS.put(custKey(data.customerId), email.toLowerCase());
  }
}

async function getEmailForCustomer(env, customerId) {
  return env.CIRRUS_SUBSCRIPTIONS.get(custKey(customerId));
}

// ── Stripe Webhook Signature Verification ───────────────────────────────────
// Implements Stripe's HMAC-SHA256 signature scheme using the Web Crypto API.
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) throw new Error('Missing signature or secret');

  const pairs = sigHeader.split(',');
  const tEntry = pairs.find(p => p.startsWith('t='));
  const v1Entry = pairs.find(p => p.startsWith('v1='));
  if (!tEntry || !v1Entry) throw new Error('Malformed signature header');

  const timestamp = tEntry.slice(2);
  const signature = v1Entry.slice(3);
  const signed = `${timestamp}.${payload}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  const expected = Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  if (expected !== signature) throw new Error('Signature mismatch');

  // Reject webhooks older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
    throw new Error('Timestamp too old');
  }

  return JSON.parse(payload);
}
