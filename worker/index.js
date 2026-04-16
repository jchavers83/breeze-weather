// Cirrus Weather — Cloudflare Worker
// Handles Stripe checkout, webhooks, subscription checks, beta code redemption,
// and automated push notifications (severe weather alerts + daily briefings).
//
// Environment variables (set in Cloudflare dashboard → Worker → Settings → Variables):
//   STRIPE_SECRET_KEY        sk_live_... (or sk_test_... for testing)
//   STRIPE_WEBHOOK_SECRET    whsec_...   (from Stripe → Webhooks → signing secret)
//   STRIPE_MONTHLY_PRICE_ID  price_...   (from Stripe → Products → Cirrus Monthly)
//   STRIPE_ANNUAL_PRICE_ID   price_...   (from Stripe → Products → Cirrus Annual)
//   BETA_CODES               comma-separated list of valid beta codes
//   ONESIGNAL_APP_ID         OneSignal App ID
//   ONESIGNAL_REST_API_KEY   OneSignal REST API Key (from Settings → Keys & IDs)
//   WEATHER_API_KEY          WeatherAPI.com key (same as frontend)
//   RESEND_API_KEY           Resend API key (from resend.com → API Keys)
//   RESEND_AUDIENCE_ID       Resend Audience ID (from resend.com → Audiences)
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
    if (request.method === 'GET' && url.pathname === '/check-token') {
      return handleCheckToken(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/claim-token') {
      return handleClaimToken(request, env);
    }

    return err('Not found', 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};

// ── Scheduled Handler ──────────────────────────────────────────────────────
async function handleScheduled(event, env) {
  try {
    if (event.cron === '*/5 * * * *') {
      await checkSevereWeather(env);
    }
    if (event.cron === '0 * * * *') {
      await dispatchBriefings(env);
    }
  } catch (e) {
    console.error('Scheduled handler error:', e.message, e.stack);
  }
}

// ── Severe Weather Alerts ──────────────────────────────────────────────────
// Only push high-impact alerts that require immediate attention.
// Advisories, statements, and non-imminent watches are intentionally excluded.
const PUSH_ALERT_EVENTS = new Set([
  'Tornado Warning', 'Tornado Watch',
  'Hurricane Warning', 'Hurricane Watch',
  'Extreme Wind Warning',
  'Flash Flood Emergency', 'Flash Flood Warning',
  'Severe Thunderstorm Warning',
  'Tropical Storm Warning', 'Tropical Storm Watch',
  'Blizzard Warning', 'Ice Storm Warning',
  'Winter Storm Warning',
]);

const ALERT_ICONS = {
  'Tornado Warning': '🌪️', 'Tornado Watch': '🌪️',
  'Hurricane Warning': '🌀', 'Hurricane Watch': '🌀',
  'Extreme Wind Warning': '🌬️',
  'Flash Flood Emergency': '🚨', 'Flash Flood Warning': '🌊',
  'Severe Thunderstorm Warning': '⛈️',
  'Tropical Storm Warning': '🌀', 'Tropical Storm Watch': '🌀',
  'Blizzard Warning': '❄️', 'Ice Storm Warning': '🧣',
  'Winter Storm Warning': '❄️',
};

async function checkSevereWeather(env) {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) return;

  const resp = await fetch(
    'https://api.weather.gov/alerts/active?status=actual&message_type=alert',
    { headers: { 'User-Agent': 'CirrusWeather/1.0 (notifications@cirrusweather.app)' } }
  );
  if (!resp.ok) { console.error('NWS API error:', resp.status); return; }

  const data = await resp.json();
  // Strict whitelist — only push alerts that explicitly require immediate action.
  // No severity fallback (a "Severe" advisory is still just an advisory).
  const features = (data.features || []).filter(f => {
    const p = f.properties;
    if (!p) return false;
    return PUSH_ALERT_EVENTS.has(p.event);
  });

  let sent = 0;
  for (const f of features) {
    if (sent >= 15) break; // Cap subrequests per cron run

    const p = f.properties;
    const alertId = p.id || p['@id'] || '';
    if (!alertId) continue;

    // Dedup — skip if already sent
    const dedupKey = `alert_sent:${alertId}`;
    const already = await env.CIRRUS_SUBSCRIPTIONS.get(dedupKey);
    if (already) continue;

    // Get centroid from geometry
    const center = getAlertCenter(f);
    if (!center) continue; // No usable geometry — skip

    // Build OneSignal tag filters for ~50mi radius + severe pref
    const latDelta = 0.7;
    const lonDelta = 0.7 / Math.cos(center.lat * Math.PI / 180);
    const filters = [
      { field: 'tag', key: 'notif_severe', relation: '=', value: '1' },
      { operator: 'AND' },
      { field: 'tag', key: 'lat', relation: '>=', value: String((center.lat - latDelta).toFixed(4)) },
      { operator: 'AND' },
      { field: 'tag', key: 'lat', relation: '<=', value: String((center.lat + latDelta).toFixed(4)) },
      { operator: 'AND' },
      { field: 'tag', key: 'lon', relation: '>=', value: String((center.lon - lonDelta).toFixed(4)) },
      { operator: 'AND' },
      { field: 'tag', key: 'lon', relation: '<=', value: String((center.lon + lonDelta).toFixed(4)) },
    ];

    const icon = ALERT_ICONS[p.event] || '⚠️';
    const headline = (p.headline || p.event || 'Severe Weather Alert').slice(0, 200);

    await sendOneSignalNotification(env, {
      app_id: env.ONESIGNAL_APP_ID,
      filters,
      headings: { en: `${icon} ${p.event}` },
      contents: { en: headline },
      url: 'https://cirrusweather.app',
      priority: 10,
      ttl: 7200,
    });

    // Mark as sent with 24hr TTL
    await env.CIRRUS_SUBSCRIPTIONS.put(dedupKey, '1', { expirationTtl: 86400 });
    sent++;
  }
}

function getAlertCenter(feature) {
  const geom = feature.geometry;
  if (geom && geom.type === 'Polygon' && geom.coordinates && geom.coordinates[0]) {
    const ring = geom.coordinates[0];
    let latSum = 0, lonSum = 0;
    for (const [lon, lat] of ring) { latSum += lat; lonSum += lon; }
    return { lat: latSum / ring.length, lon: lonSum / ring.length };
  }
  if (geom && geom.type === 'MultiPolygon' && geom.coordinates && geom.coordinates[0]) {
    const ring = geom.coordinates[0][0];
    let latSum = 0, lonSum = 0;
    for (const [lon, lat] of ring) { latSum += lat; lonSum += lon; }
    return { lat: latSum / ring.length, lon: lonSum / ring.length };
  }
  return null; // No geometry — can't target
}

// ── Morning & Evening Briefings ────────────────────────────────────────────
async function dispatchBriefings(env) {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY || !env.WEATHER_API_KEY) return;

  const now = new Date();
  const utcHour = now.getUTCHours();

  // Common US timezone offsets (covers most Cirrus users initially)
  // Format: [offsetHours, IANA timezone name]
  const TZ_MAP = [
    [-5, 'America/New_York'],    // ET
    [-6, 'America/Chicago'],     // CT
    [-7, 'America/Denver'],      // MT
    [-8, 'America/Los_Angeles'], // PT
    [-9, 'America/Anchorage'],   // AK
    [-10, 'Pacific/Honolulu'],   // HI
    // Add more as user base grows
  ];

  // Check DST: use a more robust approach — compute actual local hour per timezone
  for (const [_, tzName] of TZ_MAP) {
    const localHour = getLocalHour(now, tzName);
    const dateStr = getLocalDateStr(now, tzName);

    // Morning briefing: check hours 5-8
    if (localHour >= 5 && localHour <= 8) {
      const dedupKey = `briefing:morning:${tzName}:${dateStr}`;
      const already = await env.CIRRUS_SUBSCRIPTIONS.get(dedupKey);
      if (!already) {
        await sendBriefing(env, 'morning', tzName, localHour, dateStr);
        await env.CIRRUS_SUBSCRIPTIONS.put(dedupKey, '1', { expirationTtl: 86400 });
      }
    }

    // Evening briefing: check hours 18-22
    if (localHour >= 18 && localHour <= 22) {
      const dedupKey = `briefing:evening:${tzName}:${dateStr}`;
      const already = await env.CIRRUS_SUBSCRIPTIONS.get(dedupKey);
      if (!already) {
        await sendBriefing(env, 'evening', tzName, localHour, dateStr);
        await env.CIRRUS_SUBSCRIPTIONS.put(dedupKey, '1', { expirationTtl: 86400 });
      }
    }
  }
}

function getLocalHour(date, tz) {
  return parseInt(date.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }), 10);
}

function getLocalDateStr(date, tz) {
  return date.toLocaleString('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
}

async function sendBriefing(env, type, tzName, localHour, dateStr) {
  const prefTag = type === 'morning' ? 'notif_morning' : 'notif_evening';
  const hourTag = type === 'morning' ? 'morning_hour' : 'evening_hour';

  // Get subscribers matching this timezone + preference + hour
  // OneSignal CSV export or View Devices is heavy — instead, we send with tag filters
  // and let OneSignal match. For weather data, we fetch for representative city centers.
  // This is a trade-off: not per-user personalized, but per-timezone-region.

  // Fetch weather for the timezone's representative city
  const cityCoords = TZ_REPRESENTATIVE_COORDS[tzName];
  if (!cityCoords) return;

  const weatherUrl = `https://api.weatherapi.com/v1/forecast.json?key=${env.WEATHER_API_KEY}&q=${cityCoords.lat},${cityCoords.lon}&days=2&aqi=no&alerts=no`;
  const wResp = await fetch(weatherUrl);
  if (!wResp.ok) { console.error('Weather API error for briefing:', wResp.status); return; }
  const wData = await wResp.json();

  let heading, body;

  if (type === 'morning') {
    const today = wData.forecast?.forecastday?.[0]?.day;
    const current = wData.current;
    if (!today || !current) return;

    const hi = Math.round(today.maxtemp_f);
    const lo = Math.round(today.mintemp_f);
    const cond = today.condition?.text || 'Mixed conditions';
    const rainChance = today.daily_chance_of_rain || 0;

    heading = `Good morning — ${cond}`;
    body = `${hi}°/${lo}° today.`;
    if (rainChance >= 40) body += ` ${rainChance}% chance of rain.`;
    else if (rainChance >= 20) body += ` Slight chance of rain (${rainChance}%).`;
    body += ' Tap for your full forecast.';
  } else {
    // Evening — tomorrow's forecast
    const tomorrow = wData.forecast?.forecastday?.[1]?.day;
    if (!tomorrow) return;

    const hi = Math.round(tomorrow.maxtemp_f);
    const lo = Math.round(tomorrow.mintemp_f);
    const cond = tomorrow.condition?.text || 'Mixed conditions';
    const rainChance = tomorrow.daily_chance_of_rain || 0;

    heading = `Tomorrow — ${cond}`;
    body = `${hi}°/${lo}°.`;
    if (rainChance >= 40) body += ` ${rainChance}% chance of rain.`;
    body += ' Tap to see the full forecast.';
  }

  const filters = [
    { field: 'tag', key: prefTag, relation: '=', value: '1' },
    { operator: 'AND' },
    { field: 'tag', key: hourTag, relation: '=', value: String(localHour) },
    { operator: 'AND' },
    { field: 'tag', key: 'timezone', relation: '=', value: tzName },
  ];

  await sendOneSignalNotification(env, {
    app_id: env.ONESIGNAL_APP_ID,
    filters,
    headings: { en: heading },
    contents: { en: body },
    url: 'https://cirrusweather.app',
    ttl: 3600,
  });
}

// Representative coordinates per timezone (largest city center)
const TZ_REPRESENTATIVE_COORDS = {
  'America/New_York':    { lat: 40.71, lon: -74.01 },   // NYC
  'America/Chicago':     { lat: 41.88, lon: -87.63 },   // Chicago
  'America/Denver':      { lat: 39.74, lon: -104.99 },  // Denver
  'America/Los_Angeles': { lat: 34.05, lon: -118.24 },  // LA
  'America/Anchorage':   { lat: 61.22, lon: -149.90 },  // Anchorage
  'Pacific/Honolulu':    { lat: 21.31, lon: -157.86 },  // Honolulu
};

// ── OneSignal REST API ─────────────────────────────────────────────────────
async function sendOneSignalNotification(env, payload) {
  try {
    const resp = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${env.ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('OneSignal API error:', JSON.stringify(data));
    }
    return data;
  } catch (e) {
    console.error('OneSignal send failed:', e.message);
    return null;
  }
}

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
        const plan = sub.amount_total === 0 ? 'trial' : 'paid';
        const token = generateToken();
        await saveSubscription(env, email, {
          status: 'active',
          subscriptionId: sub.subscription,
          customerId: sub.customer,
          plan,
          token,
          createdAt: Date.now(),
        });
        await saveToken(env, token, email);
        // Welcome email + add to contacts list
        await sendWelcomeEmail(env, email, plan);
        await addContact(env, email);
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

  const token = generateToken();
  await saveSubscription(env, email.toLowerCase(), {
    status: 'beta',
    plan: 'beta',
    code: code.trim().toUpperCase(),
    token,
    grantedAt: Date.now(),
  });
  await saveToken(env, token, email.toLowerCase());

  // Welcome email + add to contacts list
  await sendWelcomeEmail(env, email.toLowerCase(), 'beta');
  await addContact(env, email.toLowerCase());

  return json({ active: true, plan: 'beta', token });
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

// ── Auth Token Helpers ──────────────────────────────────────────────────────
function generateToken() { return crypto.randomUUID(); }
function tokenKey(token) { return `token:${token}`; }

async function saveToken(env, token, email) {
  await env.CIRRUS_SUBSCRIPTIONS.put(tokenKey(token), email.toLowerCase().trim());
}

async function getEmailForToken(env, token) {
  return env.CIRRUS_SUBSCRIPTIONS.get(tokenKey(token));
}

// ── Check Token ─────────────────────────────────────────────────────────────
async function handleCheckToken(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token')?.trim();
  if (!token) return err('Token required');

  const email = await getEmailForToken(env, token);
  if (!email) return json({ active: false });

  const sub = await getSubscription(env, email);
  if (!sub) return json({ active: false });

  const active = sub.status === 'active' || sub.status === 'beta';
  return json({ active, plan: sub.plan || null, email, status: sub.status });
}

// ── Claim Token (post-checkout restore + restore access) ────────────────────
async function handleClaimToken(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const email = body.email?.toLowerCase().trim();
  if (!email || !email.includes('@')) return err('Valid email required');

  const sub = await getSubscription(env, email);
  if (!sub) return json({ active: false });

  const active = sub.status === 'active' || sub.status === 'beta';
  if (!active) return json({ active: false });

  // Reuse existing token or generate new one
  let token = sub.token;
  if (!token) {
    token = generateToken();
    await saveSubscription(env, email, { token });
  }
  await saveToken(env, token, email); // Ensure reverse mapping exists

  return json({ active: true, token, plan: sub.plan || null, email });
}

// ── Email via Resend ─────────────────────────────────────────────────────────

function buildWelcomeEmail(type) {
  const intro = `I got tired of opening a weather app and having to scroll past ads, sponsored articles about mattresses I never searched for, and a breaking news alert &mdash; just to find out if I needed a jacket or flip flops. That&rsquo;s it.<br><br>
So I built Cirrus. Clean. Fast. Beautiful. And a little opinionated about the weather. &#9925;`;

  const installTip = `One thing worth doing: install Cirrus to your home screen. In Safari, tap Share &rarr; &ldquo;Add to Home Screen.&rdquo; Opens instantly, feels like a real app, no App Store required.`;

  const feedback = `If you spot a bug or have a feature idea, hit reply. I read every one and fix things fast &mdash; like, same-day fast.`;

  const content = {
    trial: {
      subject: "Welcome to Cirrus.",
      body: `Hey &mdash; Josh here.<br><br>
${intro}<br><br>
You&rsquo;ve got 7 days of full access, starting now. <strong>No ads. No articles. No agenda. Just the weather.</strong><br><br>
${installTip}<br><br>
${feedback}<br><br>
What made you give it a shot? I&rsquo;d love to know. &#9925;<br><br>
&mdash; Josh<br>
<span style="color:#8a9aaa">Founder, Cirrus</span>`,
    },
    paid: {
      subject: "Thank you for subscribing.",
      body: `Hey &mdash; Josh here.<br><br>
You tried it. You stuck around. That genuinely means a lot. &#9925;<br><br>
Thank you for subscribing. <strong>No ads. No articles. No agenda. Just the weather.</strong> That&rsquo;s the promise &mdash; and I intend to keep it.<br><br>
If you ever want something added or spot something off, just reply. I build fast.<br><br>
&mdash; Josh<br>
<span style="color:#8a9aaa">Founder, Cirrus</span>`,
    },
    beta: {
      subject: "Welcome to Cirrus.",
      body: `Hey &mdash; Josh here.<br><br>
${intro}<br><br>
Your code worked. You&rsquo;re in. <strong>No ads. No articles. No agenda. Just the weather.</strong><br><br>
${installTip}<br><br>
${feedback}<br><br>
What brought you to Cirrus? I&rsquo;d love to know. &#9925;<br><br>
&mdash; Josh<br>
<span style="color:#8a9aaa">Founder, Cirrus</span>`,
    },
  };

  const c = content[type] || content.trial;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef6fb;padding:40px 20px">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">

        <!-- Header -->
        <tr><td style="background:linear-gradient(160deg,#bde8f8 0%,#5ec7f0 45%,#28b87a 100%);padding:36px 32px 28px;text-align:center;border-radius:20px 20px 0 0">
          <img src="https://cirrusweather.app/cirrus-icon-256.png" width="72" height="72" alt="Cirrus" style="display:block;margin:0 auto 16px;border-radius:16px;border:2px solid rgba(255,255,255,0.35)">
          <div style="font-size:28px;font-weight:800;letter-spacing:6px;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif">CIRRUS</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.7);margin-top:7px;letter-spacing:2px;text-transform:uppercase">No ads. No articles. No agenda.</div>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#ffffff;padding:36px 32px">
          <p style="margin:0 0 28px;font-size:15px;color:#3a4a5a;line-height:1.8">${c.body}</p>
          <table cellpadding="0" cellspacing="0" width="100%"><tr><td align="center">
            <a href="https://cirrusweather.app" style="display:inline-block;background:linear-gradient(135deg,#1a90e4,#28b87a);color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;padding:15px 40px;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif">Open Cirrus &#8594;</a>
          </td></tr></table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:linear-gradient(160deg,#bde8f8 0%,#5ec7f0 45%,#28b87a 100%);padding:20px 32px;text-align:center;border-radius:0 0 20px 20px">
          <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.9);line-height:1.7">No ads. No articles. No agenda. Just the weather.<br>
          <a href="https://cirrusweather.app" style="color:#ffffff;font-weight:600;text-decoration:none">cirrusweather.app</a></p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject: c.subject, html };
}

async function sendWelcomeEmail(env, email, type) {
  if (!env.RESEND_API_KEY) return; // no-op if not configured
  const { subject, html } = buildWelcomeEmail(type);
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Josh @ Cirrus <josh@cirrusweather.app>',
        // "Cirrus" only — single word brand
        reply_to: 'josh@cirrusweather.app',
        to: [email],
        subject,
        html,
      }),
    });
    if (!resp.ok) console.error('Resend send failed:', await resp.text());
  } catch (e) {
    console.error('Resend send error:', e); // non-fatal
  }
}

async function addContact(env, email) {
  if (!env.RESEND_API_KEY || !env.RESEND_AUDIENCE_ID) return; // no-op if not configured
  try {
    const resp = await fetch(`https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, unsubscribed: false }),
    });
    if (!resp.ok) console.error('Resend contact failed:', await resp.text());
  } catch (e) {
    console.error('Resend contact error:', e); // non-fatal
  }
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
