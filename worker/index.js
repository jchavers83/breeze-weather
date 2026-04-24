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
//   ANTHROPIC_API_KEY        sk-ant-... (from console.anthropic.com → API Keys)
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
    if (request.method === 'POST' && url.pathname === '/create-portal-session') {
      return handleCreatePortalSession(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/referral-info') {
      return handleReferralInfo(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/check-token') {
      return handleCheckToken(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/claim-token') {
      return handleClaimToken(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/set-tags') {
      return handleSetTags(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/ask') {
      return handleAsk(request, env);
    }

    return err('Not found', 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};

// ── Set OneSignal Tags (server-side, bypasses iOS SDK sync issues) ─────────
async function handleSetTags(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const { onesignalId, tags } = body || {};
  if (!onesignalId || typeof tags !== 'object') return err('Missing onesignalId or tags');
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) return err('OneSignal not configured', 500);
  try {
    const resp = await fetch(
      `https://api.onesignal.com/apps/${env.ONESIGNAL_APP_ID}/users/by/onesignal_id/${encodeURIComponent(onesignalId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${env.ONESIGNAL_REST_API_KEY}` },
        body: JSON.stringify({ properties: { tags } }),
      }
    );
    if (!resp.ok) { const t = await resp.text(); return err(`OneSignal error: ${t}`, 502); }
    // Store user prefs in KV for per-user personalized briefings
    const userPrefs = {
      lat: tags.lat || '',
      lon: tags.lon || '',
      timezone: tags.timezone || 'America/New_York',
      morning_hour: tags.morning_hour || '6',
      evening_hour: tags.evening_hour || '21',
      notif_morning: tags.notif_morning || '0',
      notif_evening: tags.notif_evening || '0',
      notif_severe: tags.notif_severe || '0',
      updated: Date.now(),
    };
    if (userPrefs.lat && env.CIRRUS_SUBSCRIPTIONS) {
      // Store lat/lon/notif_severe in metadata so list() can filter without extra GET calls
      await env.CIRRUS_SUBSCRIPTIONS.put(
        `user_prefs:${onesignalId}`,
        JSON.stringify(userPrefs),
        {
          expirationTtl: 7776000, // 90 days
          metadata: {
            lat: userPrefs.lat,
            lon: userPrefs.lon,
            notif_severe: userPrefs.notif_severe,
            notif_morning: userPrefs.notif_morning,
            notif_evening: userPrefs.notif_evening,
          },
        }
      );
    }
    return json({ ok: true });
  } catch (e) {
    return err('Network error: ' + e.message, 502);
  }
}

// ── Ask Cirrus — LLM Weather Advisor ──────────────────────────────────────
async function handleAsk(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const { messages, context } = body || {};
  if (!messages || !messages.length) return err('Messages required');
  if (!env.ANTHROPIC_API_KEY) return err('AI not configured — add ANTHROPIC_API_KEY to Worker env', 500);

  const systemPrompt = buildWeatherSystemPrompt(context);

  // Convert to Anthropic message format (must alternate user/assistant)
  const anthropicMessages = messages.map(m => ({
    role: m.role === 'cirrus' ? 'assistant' : 'user',
    content: m.text,
  }));

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 400,
        system: systemPrompt,
        messages: anthropicMessages,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      const errMsg = errBody?.error?.message || `HTTP ${resp.status}`;
      console.error('Anthropic error:', resp.status, errBody);
      // Surface the real error so it's visible in the chat during debugging
      return json({ answer: `Ask Cirrus ran into a problem (${resp.status}: ${errMsg}). Try again in a moment.` });
    }

    const data = await resp.json();
    const answer = data.content?.[0]?.text || "I couldn't get an answer right now. Try again?";
    return json({ answer });
  } catch (e) {
    console.error('Ask error:', e.message);
    return err('AI request failed', 502);
  }
}

function buildWeatherSystemPrompt(ctx) {
  const base = `You are Cirrus, a smart, friendly weather advisor built into the Cirrus Weather app. Give practical, specific advice based on real weather data. Be conversational and a little clever — not robotic or overly cautious. Keep answers to 1-4 sentences. Be specific: name actual clothing items, give exact time windows, cite real temperatures. Use the data — don't give generic advice when you have real numbers.`;

  if (!ctx) return base;

  const location = ctx.region ? `${ctx.city}, ${ctx.region}` : ctx.city;
  const lines = [
    base, '',
    `Current conditions — ${location} (${ctx.localDate || ''}, ${ctx.localTime || ''}):`,
    `• ${ctx.temp}°F (feels like ${ctx.feels}°F)`,
    `• ${ctx.conditions}, ${ctx.humidity}% humidity`,
    `• Wind: ${ctx.wind} mph ${ctx.windDir}`,
    `• UV index: ${ctx.uv}`,
    `• Today: High ${ctx.high}°F / Low ${ctx.low}°F, ${ctx.rainChance}% chance of rain`,
  ];
  if (ctx.airQuality) lines.push(`• Air quality: ${ctx.airQuality}`);
  if (ctx.alerts?.length) lines.push(`• ⚠️ Active weather alerts: ${ctx.alerts.join(', ')}`);
  lines.push('', `7-day outlook: ${ctx.forecast}`);
  return lines.join('\n');
}

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

    // Find users near this alert entirely from KV — do NOT rely on OneSignal
    // tag filters, which are unreliable (exists checks can silently broadcast
    // to all subscribers when tags haven't synced correctly).
    const matchingIds = await findUsersNearAlert(env, center);

    const icon = ALERT_ICONS[p.event] || '⚠️';

    // Format area: take first entry from areaDesc (e.g. "Delaware, IA; Dubuque, IA" → "Delaware, IA")
    const areaDesc = (p.areaDesc || '').split(';')[0].trim();
    const location = areaDesc ? ` \u00b7 ${areaDesc}` : '';

    // Parse expiration time from NWS expires field
    let expiresStr = '';
    if (p.expires) {
      try {
        const exp = new Date(p.expires);
        expiresStr = exp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
      } catch(e) {}
    }

    // Urgency line based on event type
    const urgencyMap = {
      'Tornado Warning': 'Take shelter immediately.',
      'Tornado Watch': 'Conditions favorable for tornadoes. Stay alert.',
      'Hurricane Warning': 'Dangerous hurricane conditions expected. Evacuate if ordered.',
      'Hurricane Watch': 'Hurricane conditions possible. Prepare now.',
      'Flash Flood Emergency': 'Life-threatening flooding. Move to higher ground now.',
      'Flash Flood Warning': 'Flash flooding occurring or imminent. Avoid flood areas.',
      'Severe Thunderstorm Warning': 'Large hail and damaging winds expected.',
      'Extreme Wind Warning': 'Dangerous wind gusts expected. Stay indoors.',
      'Blizzard Warning': 'Blizzard conditions expected. Avoid travel.',
      'Ice Storm Warning': 'Significant ice accumulation expected. Avoid travel.',
      'Winter Storm Warning': 'Heavy snow and dangerous conditions expected.',
    };
    const urgency = urgencyMap[p.event] || 'Take precautions immediately.';
    const body = `${urgency}${expiresStr ? ` Active until ${expiresStr}.` : ''}`;

    // Always mark as sent to prevent refire every 5 min regardless of user count
    await env.CIRRUS_SUBSCRIPTIONS.put(dedupKey, '1', { expirationTtl: 86400 });

    if (matchingIds.length === 0) {
      console.log(`Alert ${alertId}: no users in area, skipping push`);
      continue;
    }

    await sendOneSignalNotification(env, {
      app_id: env.ONESIGNAL_APP_ID,
      include_aliases: { onesignal_id: matchingIds },
      target_channel: 'push',
      headings: { en: `${icon} ${p.event}${location}` },
      contents: { en: body },
      url: 'https://cirrusweather.app',
      priority: 10,
      ttl: 7200,
    });
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

// ── KV-based geo-user lookup ───────────────────────────────────────────────
// ~50 mile radius = 0.7° lat delta. We read lat/lon from KV metadata so we
// never need extra GET calls — just one list() pass over all user_prefs keys.
async function findUsersNearAlert(env, center) {
  const latDelta = 0.7;
  const lonDelta = latDelta / Math.cos(center.lat * Math.PI / 180);
  const latMin = center.lat - latDelta, latMax = center.lat + latDelta;
  const lonMin = center.lon - lonDelta, lonMax = center.lon + lonDelta;
  const matchingIds = [];

  try {
    let cursor;
    do {
      const page = await env.CIRRUS_SUBSCRIPTIONS.list({
        prefix: 'user_prefs:',
        limit: 1000,
        cursor,
      });
      for (const key of page.keys) {
        const meta = key.metadata;
        if (!meta) continue; // old entry without metadata — skip
        if (meta.notif_severe !== '1') continue;
        const userLat = parseFloat(meta.lat);
        const userLon = parseFloat(meta.lon);
        if (!userLat || !userLon || isNaN(userLat) || isNaN(userLon)) continue;
        if (userLat >= latMin && userLat <= latMax && userLon >= lonMin && userLon <= lonMax) {
          matchingIds.push(key.name.replace('user_prefs:', ''));
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch (e) {
    console.error('findUsersNearAlert error:', e.message);
  }
  return matchingIds;
}

// ── Timezone Helpers ───────────────────────────────────────────────────────
function getLocalHour(date, timezone) {
  try {
    const str = date.toLocaleString('en-US', { timeZone: timezone, hour: 'numeric', hour12: false });
    return parseInt(str, 10) % 24;
  } catch (e) { return date.getUTCHours(); }
}

function getLocalDateStr(date, timezone) {
  try {
    return date.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD
  } catch (e) { return date.toISOString().slice(0, 10); }
}

// ── Morning & Evening Briefings ────────────────────────────────────────────
async function dispatchBriefings(env) {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY || !env.WEATHER_API_KEY) return;

  const now = new Date();

  // List all users who have registered their location prefs
  let list;
  try { list = await env.CIRRUS_SUBSCRIPTIONS.list({ prefix: 'user_prefs:' }); }
  catch (e) { console.error('KV list error:', e.message); return; }

  const keys = list.keys.slice(0, 100); // cap per-run
  console.log(`dispatchBriefings: processing ${keys.length} users`);

  for (const keyObj of keys) {
    try {
      const raw = await env.CIRRUS_SUBSCRIPTIONS.get(keyObj.name);
      if (!raw) continue;
      const prefs = JSON.parse(raw);
      const onesignalId = keyObj.name.slice('user_prefs:'.length);

      if (!prefs.lat || !prefs.lon || !prefs.timezone) continue;

      const localHour = getLocalHour(now, prefs.timezone);
      const dateStr = getLocalDateStr(now, prefs.timezone);

      // Morning briefing
      if (prefs.notif_morning === '1' && localHour === parseInt(prefs.morning_hour || 6)) {
        const dedupKey = `briefing:${onesignalId}:morning:${dateStr}`;
        const already = await env.CIRRUS_SUBSCRIPTIONS.get(dedupKey);
        if (!already) {
          await sendPersonalBriefing(env, 'morning', onesignalId, prefs);
          await env.CIRRUS_SUBSCRIPTIONS.put(dedupKey, '1', { expirationTtl: 86400 });
        }
      }

      // Evening briefing
      if (prefs.notif_evening === '1' && localHour === parseInt(prefs.evening_hour || 21)) {
        const dedupKey = `briefing:${onesignalId}:evening:${dateStr}`;
        const already = await env.CIRRUS_SUBSCRIPTIONS.get(dedupKey);
        if (!already) {
          await sendPersonalBriefing(env, 'evening', onesignalId, prefs);
          await env.CIRRUS_SUBSCRIPTIONS.put(dedupKey, '1', { expirationTtl: 86400 });
        }
      }
    } catch (e) {
      console.error('Briefing user error:', keyObj.name, e.message);
    }
  }
}

async function sendPersonalBriefing(env, type, onesignalId, prefs) {
  const weatherUrl = `https://api.pirateweather.net/forecast/${env.WEATHER_API_KEY}/${prefs.lat},${prefs.lon}?units=us&exclude=minutely,hourly,alerts,flags`;
  const wResp = await fetch(weatherUrl);
  if (!wResp.ok) { console.error('Weather fetch error:', wResp.status); return; }
  const wData = await wResp.json();

  const pirateCondLabel = {
    'clear-day':'Clear','clear-night':'Clear',
    'partly-cloudy-day':'Partly Cloudy','partly-cloudy-night':'Partly Cloudy',
    'cloudy':'Cloudy','fog':'Foggy','wind':'Windy',
    'rain':'Rain','sleet':'Sleet','snow':'Snow',
    'thunderstorm':'Thunderstorms','hail':'Hail','tornado':'Tornado',
  };

  let heading, body;

  if (type === 'morning') {
    const today = wData.daily?.data?.[0];
    if (!today) return;
    const hi = Math.round(today.temperatureHigh ?? today.temperatureMax ?? 70);
    const lo = Math.round(today.temperatureLow ?? today.temperatureMin ?? 50);
    const cond = pirateCondLabel[today.icon] || 'Mixed conditions';
    const rainChance = Math.round((today.precipProbability || 0) * 100);
    heading = `Good morning — ${cond}`;
    body = `${hi}°/${lo}° today.`;
    if (rainChance >= 40) body += ` ${rainChance}% chance of rain.`;
    else if (rainChance >= 20) body += ` Slight chance of rain (${rainChance}%).`;
    body += ' Tap for your full forecast.';
  } else {
    const tomorrow = wData.daily?.data?.[1];
    if (!tomorrow) return;
    const hi = Math.round(tomorrow.temperatureHigh ?? tomorrow.temperatureMax ?? 70);
    const lo = Math.round(tomorrow.temperatureLow ?? tomorrow.temperatureMin ?? 50);
    const cond = pirateCondLabel[tomorrow.icon] || 'Mixed conditions';
    const rainChance = Math.round((tomorrow.precipProbability || 0) * 100);
    heading = `Tomorrow — ${cond}`;
    body = `${hi}°/${lo}°.`;
    if (rainChance >= 40) body += ` ${rainChance}% chance of rain.`;
    body += ' Tap to see the full forecast.';
  }

  await sendOneSignalNotification(env, {
    app_id: env.ONESIGNAL_APP_ID,
    include_aliases: { onesignal_id: [onesignalId] },
    target_channel: 'push',
    headings: { en: heading },
    contents: { en: body },
    url: 'https://cirrusweather.app',
    ttl: 3600,
  });
}

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

// ── Referral Helpers ────────────────────────────────────────────────────────
function generateRefCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 ambiguity
  let code = '';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  for (const b of arr) code += chars[b % chars.length];
  return code;
}

function refCodeKey(code) { return `ref_code:${code.toUpperCase()}`; }
function referrerCodeKey(email) { return `referrer_code:${email.toLowerCase()}`; }
function pendingRefKey(sessionId) { return `pending_ref:${sessionId}`; }

// Get or create a referral code for an email
async function getOrCreateRefCode(env, email) {
  const existingCode = await env.CIRRUS_SUBSCRIPTIONS.get(referrerCodeKey(email));
  if (existingCode) return existingCode;

  const code = generateRefCode();
  await env.CIRRUS_SUBSCRIPTIONS.put(referrerCodeKey(email), code);
  await env.CIRRUS_SUBSCRIPTIONS.put(refCodeKey(code), email);
  return code;
}

// ── Create Stripe Checkout Session ─────────────────────────────────────────
async function handleCreateCheckout(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { email, plan, ref } = body; // plan: 'monthly' | 'annual', ref: optional referral code
  if (!email || !email.includes('@')) return err('Valid email required');
  if (!['monthly', 'annual'].includes(plan)) return err('Invalid plan');

  const priceId = plan === 'annual'
    ? env.STRIPE_ANNUAL_PRICE_ID
    : env.STRIPE_MONTHLY_PRICE_ID;

  const origin = request.headers.get('Origin') || 'https://cirrusweather.app';

  // Validate referral code and extend trial if valid
  let trialDays = 7;
  let referrerEmail = null;
  if (ref) {
    const refEmail = await env.CIRRUS_SUBSCRIPTIONS.get(refCodeKey(ref));
    if (refEmail && refEmail.toLowerCase() !== email.toLowerCase()) {
      // Valid code that isn't self-referral
      trialDays = 30;
      referrerEmail = refEmail;
    }
  }

  const params = new URLSearchParams({
    'mode': 'subscription',
    'customer_email': email,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'subscription_data[trial_period_days]': String(trialDays),
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

  // Store pending referral so we can reward the referrer on conversion
  if (referrerEmail && session.id) {
    await env.CIRRUS_SUBSCRIPTIONS.put(
      pendingRefKey(session.id),
      referrerEmail,
      { expirationTtl: 60 * 60 * 24 * 40 } // 40 days — covers trial + grace period
    );
  }

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
        // Generate referral code for new subscriber
        await getOrCreateRefCode(env, email);
        // Bridge pending referral from session_id → subscription_id so invoice.paid can find it
        if (sub.id && sub.subscription) {
          const referrerEmail = await env.CIRRUS_SUBSCRIPTIONS.get(pendingRefKey(sub.id));
          if (referrerEmail) {
            await env.CIRRUS_SUBSCRIPTIONS.put(
              `sub_ref:${sub.subscription}`,
              referrerEmail,
              { expirationTtl: 60 * 60 * 24 * 40 }
            );
            await env.CIRRUS_SUBSCRIPTIONS.delete(pendingRefKey(sub.id));
          }
        }
        // Welcome email + add to contacts list
        await sendWelcomeEmail(env, email, plan);
        await addContact(env, email);
      }
      break;
    }
    case 'invoice.paid': {
      // Invoice paid — if this is a referred user converting from trial, reward referrer
      const customerId = sub.customer;
      const billingReason = sub.billing_reason; // 'subscription_cycle' = first real charge after trial
      if (billingReason === 'subscription_cycle' && customerId) {
        const email = await getEmailForCustomer(env, customerId);
        if (email) {
          // Find which checkout session this originated from (stored in subscription metadata)
          // We stored pending_ref by session_id at checkout; look it up via subscription
          const subscriptionId = sub.subscription || sub.lines?.data?.[0]?.subscription;
          if (subscriptionId) {
            // Try to find the referrer via pending_ref keys
            // Stripe doesn't give us session_id here, so we stored it on subscription metadata
            // Check our KV for a referrer stored under this subscription
            const referrerEmail = await env.CIRRUS_SUBSCRIPTIONS.get(`sub_ref:${subscriptionId}`);
            if (referrerEmail) {
              // Apply $3.99 credit to referrer's next invoice
              const referrerSub = await getSubscription(env, referrerEmail);
              if (referrerSub?.customerId) {
                await applyReferralCredit(env, referrerSub.customerId, email);
              }
              // Clean up
              await env.CIRRUS_SUBSCRIPTIONS.delete(`sub_ref:${subscriptionId}`);
            }
          }
        }
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

// ── Referral Info Endpoint ──────────────────────────────────────────────────
async function handleReferralInfo(request, env) {
  const url = new URL(request.url);
  const email = url.searchParams.get('email')?.toLowerCase().trim();
  if (!email || !email.includes('@')) return err('Email required');

  const sub = await getSubscription(env, email);
  if (!sub || (sub.status !== 'active' && sub.status !== 'beta' && sub.status !== 'trial')) {
    return err('Active subscription required', 403);
  }

  const code = await getOrCreateRefCode(env, email);
  return json({
    code,
    link: `https://cirrusweather.app?ref=${code}`,
  });
}

// ── Referral Credit ─────────────────────────────────────────────────────────
async function applyReferralCredit(env, stripeCustomerId, referredEmail) {
  // $3.99 credit (399 cents) applied to referrer's next invoice
  try {
    const params = new URLSearchParams({
      amount: '-399', // negative = credit
      currency: 'usd',
      description: `Referral reward \u2014 ${referredEmail} subscribed`,
    });
    const resp = await fetch(`https://api.stripe.com/v1/customers/${stripeCustomerId}/balance_transactions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!resp.ok) console.error('Referral credit failed:', await resp.text());
    else console.log(`Referral credit applied to ${stripeCustomerId} for referring ${referredEmail}`);
  } catch (e) {
    console.error('Referral credit error:', e.message);
  }
}

// ── Stripe Customer Portal ──────────────────────────────────────────────────
async function handleCreatePortalSession(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const email = body.email?.toLowerCase().trim();
  const returnUrl = body.return_url || 'https://cirrusweather.app';
  if (!email || !email.includes('@')) return err('Valid email required');

  const sub = await getSubscription(env, email);
  if (!sub || !sub.stripe_customer_id) {
    return err('No subscription found for this email', 404);
  }

  // Create a Stripe billing portal session
  const params = new URLSearchParams({
    customer: sub.stripe_customer_id,
    return_url: returnUrl,
  });

  const stripeRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!stripeRes.ok) {
    const stripeErr = await stripeRes.json();
    return err(stripeErr?.error?.message || 'Failed to create portal session', 500);
  }

  const session = await stripeRes.json();
  return json({ url: session.url });
}

// ── Email via Resend ─────────────────────────────────────────────────────────

function buildWelcomeEmail(type) {
  const intro = `I got tired of opening a weather app and having to fight through ads, sponsored articles, and videos designed to keep me scrolling &mdash; just to find out if I needed a jacket or flip flops.<br><br>
So I built Cirrus. Clean. Fast. Beautiful. And a little opinionated about the weather. &#9925;`;

  const installTip = `One thing worth doing: install Cirrus to your home screen. In Safari, tap Share &rarr; &ldquo;Add to Home Screen.&rdquo; Opens instantly, feels like a real app, no App Store required.`;

  const feedback = `If you spot a bug or have a feature idea, hit reply. I read every one and fix things fast &mdash; like, same-day fast.`;

  const content = {
    trial: {
      subject: "Welcome to Cirrus. \u26C5",
      body: `Hey &mdash; Josh here from Cirrus. Thanks for giving it a try.<br><br>
${intro}<br><br>
You&rsquo;ve got 7 days of full access, starting now.<br><br>
<strong>No ads. No articles. No agenda.</strong><br><br>
<strong>Just the weather.</strong><br><br>
${installTip}<br><br>
${feedback}<br><br>
What made you give it a try? I&rsquo;d love to know. &#9728;<br><br>
&mdash; Josh<br>
<span style="color:#8a9aaa">Founder, Cirrus</span>`,
    },
    paid: {
      subject: "Thank you for subscribing. \u2600",
      body: `Hey &mdash; Josh here from Cirrus. Thanks for subscribing.<br><br>
You tried it. You stuck around. That genuinely means a lot. &#9925;<br><br>
<strong>No ads. No articles. No agenda.</strong><br><br>
<strong>Just the weather.</strong><br><br>
That&rsquo;s the promise &mdash; and I intend to keep it.<br><br>
If you ever want something added or spot something off, just reply. I build fast.<br><br>
&mdash; Josh<br>
<span style="color:#8a9aaa">Founder, Cirrus</span>`,
    },
    beta: {
      subject: "Welcome to Cirrus. \u26C5",
      body: `Hey &mdash; Josh here from Cirrus. Thanks for being a beta tester.<br><br>
${intro}<br><br>
Your code worked. You&rsquo;re in.<br><br>
<strong>No ads. No articles. No agenda.</strong><br><br>
<strong>Just the weather.</strong><br><br>
${installTip}<br><br>
${feedback}<br><br>
What brought you to Cirrus? I&rsquo;d love to know. &#9728;<br><br>
&mdash; Josh<br>
<span style="color:#8a9aaa">Founder, Cirrus</span>`,
    },
  };

  const c = content[type] || content.trial;

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <style>
    :root { color-scheme: light only; }
    @media (prefers-color-scheme: dark) {
      body, .email-bg { background-color:#3db5e8 !important; }
      .email-card { background:#ffffff !important; }
      .email-card p { color:#2a3a4a !important; }
    }
  </style>
</head>
<body class="email-bg" style="margin:0;padding:0;background-color:#4ab8e8 !important;background:linear-gradient(170deg,#7dcbea 0%,#3db5e8 40%,#28b87a 100%) !important;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#4ab8e8" style="background-color:#4ab8e8 !important;background:linear-gradient(170deg,#7dcbea 0%,#3db5e8 40%,#28b87a 100%);padding:48px 20px 40px">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:500px">

        <!-- Header -->
        <tr><td style="padding:0 0 24px;text-align:center">
          <img src="https://cirrusweather.app/cirrus-icon-256.png" width="80" height="80" alt="Cirrus" style="display:block;margin:0 auto 18px;border-radius:20px;border:2px solid rgba(255,255,255,0.45);box-shadow:0 8px 24px rgba(0,0,0,0.15)">
          <div style="font-size:32px;font-weight:800;letter-spacing:7px;color:#ffffff !important;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;margin-bottom:8px">CIRRUS</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.95) !important;letter-spacing:2px;text-transform:uppercase;text-shadow:0 1px 3px rgba(0,0,0,0.15)">No ads. No articles. No agenda.</div>
          <div style="font-size:13px;font-weight:800;color:#ffffff !important;letter-spacing:2px;text-transform:uppercase;margin-top:5px">Just the weather.</div>
        </td></tr>

        <!-- Body card -->
        <tr><td class="email-card" style="background:#ffffff !important;padding:36px 32px;border-radius:20px">
          <p style="margin:0 0 28px;font-size:15px;color:#2a3a4a !important;line-height:1.85">${c.body}</p>
          <table cellpadding="0" cellspacing="0" width="100%"><tr><td align="center">
            <a href="https://cirrusweather.app" style="display:inline-block;background-color:#1a90e4 !important;background:linear-gradient(135deg,#1a90e4,#28b87a) !important;color:#ffffff !important;font-size:16px;font-weight:700;text-decoration:none;padding:15px 44px;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif">Open Cirrus &#8594;</a>
          </td></tr></table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 16px 0;text-align:center">
          <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.8) !important;line-height:1.8;letter-spacing:1px;text-transform:uppercase">No ads. No articles. No agenda.</p>
          <p style="margin:4px 0 10px;font-size:13px;font-weight:800;color:#ffffff !important;letter-spacing:1px;text-transform:uppercase">Just the weather.</p>
          <a href="https://cirrusweather.app" style="font-size:12px;color:rgba(255,255,255,0.8) !important;text-decoration:none">cirrusweather.app</a>
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
