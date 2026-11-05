/**
 * JAGG Roofing, Siding and Windows — estimate landing page.
 *
 * Serves the static landing page and takes the form submission, which it turns
 * into an AccuLynx Contact + Job (AccuLynx has no "create lead" endpoint; a lead
 * IS a job created in the Lead milestone, so it is a two-call sequence).
 *
 *   POST /api/v2/contacts  -> contact id
 *   POST /api/v2/jobs      -> job in the Lead milestone, linked to that contact
 *
 * Secrets / vars (see README):
 *   ACCULYNX_API_KEY   secret, required
 *   LEAD_SOURCE_NAME   var, optional (default "Website")
 *   CONTACT_TYPE_NAME  var, optional (default "Customer")
 *   RESEND_API_KEY     secret, optional — fallback notification if AccuLynx errors
 *   NOTIFY_EMAIL       var, optional — where that fallback goes
 */

const ACCULYNX = 'https://api.acculynx.com/api/v2';

// Account-specific lookup ids, resolved once per isolate.
let lookupCache = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // go.jagg-roofing.com/<slug> — short links for the Facebook group posts
    if (url.hostname.startsWith('go.')) return handleShortLink(url, request, env, ctx);

    // The group board carries competitive data and the do-not-post list, so it
    // stays private. The week-1 page is the client's own copy for review and
    // must open without a password.
    if (url.pathname.startsWith('/review/groups')) {
      const gate = reviewGate(request, env);
      if (gate) return gate;
    }

    if (url.pathname === '/api/geo') return handleGeo(url);
    if (url.pathname === '/api/lookups') return handleLookups(url, env);
    if (url.pathname === '/api/lead-source-report') return handleLeadSourceReport(url, env);
    if (url.pathname === '/api/lead') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
      return handleLead(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};

/* ---------------------------------------------------------------- helpers */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/* ------------------------------------------------- address autocomplete */

// Photon (keyless, OSM-backed). Nominatim explicitly forbids autocomplete use.
async function handleGeo(url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 4) return json({ results: [] });

  const endpoint =
    'https://photon.komoot.io/api/?limit=6&lang=en&lat=40.78&lon=-73.44&q=' + encodeURIComponent(q);

  try {
    const r = await fetch(endpoint, { headers: { accept: 'application/json' } });
    if (!r.ok) return json({ results: [] });
    const data = await r.json();

    const results = (data.features || [])
      .filter((f) => (f.properties || {}).countrycode === 'US')
      .map((f) => {
        const p = f.properties || {};
        const street = [p.housenumber, p.street || p.name].filter(Boolean).join(' ');
        const city = p.city || p.town || p.village || p.district || '';
        return {
          label: [street || p.name, city, p.state, p.postcode].filter(Boolean).join(', '),
          street: street || p.name || '',
          city,
          state: stateAbbr(p.state),
          zip: p.postcode || '',
        };
      })
      .filter((r2) => r2.street);

    // Photon returns the same address more than once for multi-polygon OSM data.
    const seen = new Set();
    const unique = results.filter((r2) => {
      if (seen.has(r2.label)) return false;
      seen.add(r2.label);
      return true;
    });

    return json({ results: unique });
  } catch (err) {
    return json({ results: [] });
  }
}

const STATE_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'puerto rico': 'PR', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY',
};

function stateAbbr(name) {
  if (!name) return '';
  if (name.length === 2) return name.toUpperCase();
  return STATE_ABBR[name.toLowerCase()] || '';
}

/* ------------------------------------------------------- AccuLynx calls */

async function acculynx(env, path, init = {}) {
  const r = await fetch(ACCULYNX + path, {
    ...init,
    headers: {
      authorization: 'Bearer ' + env.ACCULYNX_API_KEY,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });

  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (!r.ok) {
    const err = new Error('AccuLynx ' + path + ' -> ' + r.status + ' ' + text.slice(0, 500));
    err.status = r.status;
    throw err;
  }
  return body;
}

// AccuLynx list endpoints have used `records` and `items` across versions.
function listOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.records || payload.items || payload.data || payload.results || [];
}

function nameOf(row) {
  return String(row.name || row.description || row.displayName || row.title || '');
}

async function getLookups(env) {
  if (lookupCache) return lookupCache;

  const wantLeadSource = (env.LEAD_SOURCE_NAME || 'Website').toLowerCase();
  const wantContactType = (env.CONTACT_TYPE_NAME || 'Customer').toLowerCase();

  const [contactTypes, leadSources, tradeTypes] = await Promise.all([
    acculynx(env, '/contacts/contact-types').then(listOf).catch(() => []),
    acculynx(env, '/company-settings/leads/lead-sources').then(listOf).catch(() => []),
    acculynx(env, '/company-settings/job-file-settings/trade-types').then(listOf).catch(() => []),
  ]);

  // Exact match first, then a contains match. Deliberately NO "just take the
  // first row" fallback for the lead source: guessing silently mis-attributes
  // every lead, which is worse than sending none.
  const match = (rows, want) =>
    rows.find((r) => nameOf(r).toLowerCase() === want) ||
    rows.find((r) => nameOf(r).toLowerCase().includes(want)) ||
    null;

  // A contact does need a type, so there the first active one is a safe default.
  const contactType = match(contactTypes, wantContactType) || contactTypes[0] || null;
  const leadSource = match(leadSources, wantLeadSource);

  if (!leadSource) {
    console.error(
      'LEAD SOURCE NOT FOUND: no active AccuLynx lead source matches "' +
        (env.LEAD_SOURCE_NAME || 'Website') + '". Available: ' +
        leadSources.map(nameOf).join(' | ') +
        '. Leads will be created WITHOUT a source until this is fixed.');
  }

  const tradeByName = {};
  for (const t of tradeTypes) tradeByName[nameOf(t).toLowerCase()] = t.id;

  lookupCache = {
    contactTypeId: contactType ? contactType.id : null,
    leadSourceId: leadSource ? leadSource.id : null,
    resolved: {
      leadSourceWanted: env.LEAD_SOURCE_NAME || 'Website',
      leadSourceMatched: leadSource ? nameOf(leadSource) : null,
      contactTypeMatched: contactType ? nameOf(contactType) : null,
      availableLeadSources: leadSources.map(nameOf),
      availableContactTypes: contactTypes.map(nameOf),
      availableTradeTypes: tradeTypes.map(nameOf),
    },
    tradeByName,
  };
  return lookupCache;
}

function tradeIdsFor(service, tradeByName) {
  const key = String(service || '').toLowerCase();
  const id = tradeByName[key];
  if (id !== undefined && id !== null) return [{ id }];
  // "Other" / free text has no matching trade type — leave it off the job and
  // let the note carry the detail.
  return [];
}

/* --------------------------------------------------- lookup diagnostics */

// Shows what AccuLynx actually offers and what the config resolved to, so a
// mis-attributed lead source is visible instead of silent. Token-gated.
async function handleLookups(url, env) {
  const token = url.searchParams.get('token') || '';
  if (!env.DIAG_TOKEN || token !== env.DIAG_TOKEN) {
    return json({ ok: false, error: 'Not found' }, 404);
  }
  if (url.searchParams.get('fresh')) lookupCache = null;
  try {
    const l = await getLookups(env);
    return json({ ok: true, ...l.resolved, leadSourceId: l.leadSourceId });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message) }, 502);
  }
}

/* ------------------------------------------------------- review gate */

const REVIEW_COOKIE = 'jagg_review';

/** Returns a Response when the visitor should be stopped, otherwise null. */
function reviewGate(request, env) {
  const pw = env.REVIEW_PASSWORD || 'shingle';
  const url = new URL(request.url);

  if (url.searchParams.get('pw') === pw) {
    const to = new URL(url); to.searchParams.delete('pw');
    return new Response(null, {
      status: 302,
      headers: {
        location: to.pathname + to.search,
        'set-cookie': `${REVIEW_COOKIE}=${pw}; Path=/review/groups; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      },
    });
  }

  const cookie = request.headers.get('cookie') || '';
  if (cookie.split(';').some((c) => c.trim() === `${REVIEW_COOKIE}=${pw}`)) return null;

  return new Response(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>JAGG</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14213D;
color:#fff;font:15px/1.5 Inter,system-ui,sans-serif}
form{background:#fff;color:#14213D;padding:28px;border-radius:12px;width:min(92vw,330px);
display:flex;flex-direction:column;gap:12px}
label{font-size:12px;font-weight:700;color:#5A6678}
input{font:inherit;font-size:16px;padding:11px;border:1px solid #DCE1E9;border-radius:8px}
button{font:inherit;font-weight:700;font-size:15px;padding:12px;border:0;border-radius:8px;
background:#C2410C;color:#fff;cursor:pointer}</style>
<form method="GET"><label for="pw">Password</label>
<input id="pw" name="pw" type="password" autofocus autocomplete="current-password">
<button type="submit">View</button></form>`,
    { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** YYYY-MM-DD in Long Island local time, which is how the client thinks about days. */
function localDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/* --------------------------------------------------------- short links */

/**
 * One slug per (post x group) so a lead can be traced to the exact post and
 * group that produced it. Slugs live here rather than in a database so the
 * redirect is a single edge hop with nothing to go wrong on launch day.
 *
 * slug: [post title, group, utm_content, utm_term]
 */
const LINKS = {
  w1a: ['Just finished - full roof',        'East Patchogue Community',        'p1-justfinished',  'g-eastpatchogue'],
  w1b: ['Once the crew leaves',             'Bohemia Ronkonkoma Sayville',     'p2-aftercare',     'g-bohemia'],
  w1c: ['Ready for another LI winter',      'East Islip NY Uncensored',        'p3-winterready',   'g-eastislip'],
  w1d: ['Most roofers say replace',         'Patchogue Long Island NY',        'p4-replacerepair', 'g-patchogue'],
  w1e: ['Family / pumpkins',                'Centereach NY Community Group',   'p5-family',        'g-centereach'],
  w1f: ['First company photo',             'East Moriches Community Posts',   'p6-crew',          'g-eastmoriches'],

  w2a: ['Four generations in Suffolk',      'Town of Babylon group',              'p7-generations',  'g-babylontown'],
  w2b: ['As a father',                      'Babylon Village Connection',         'p8-asafather',    'g-babylonvillage'],
  w2c: ['The socks photo',                  'West Islip Community',               'p9-socks',        'g-westislip'],
  w2d: ['Just finished - full roof',        'Smithtown NY community page',        'p1-justfinished', 'g-smithtown'],
  w2e: ['Once the crew leaves',             'Shirley and the Mastics',            'p2-aftercare',    'g-shirleymastics'],
  w2f: ['Ready for another LI winter',      'Port Jeff, Setauket, Stony Brook',   'p3-winterready',  'g-portjeff'],
  w2g: ['Most roofers say replace',         'Huntington Station Matters',         'p4-replacerepair','g-huntingtonstn'],
  w2h: ['Four generations in Suffolk',      'Long Island, NY Business Owners',    'p7-generations',  'g-libusiness'],
  w2i: ['Family / pumpkins',                'The Deer Park We all remember.',     'p5-family',       'g-deerpark'],
  w2j: ['As a father',                      'Miller Place / Sound Beach',         'p8-asafather',    'g-millerplace'],
  w2k: ['First company photo',              'Islip That & This',                  'p6-crew',         'g-islipthatthis'],
  w2l: ['The socks photo',                  'Lake Grove/Centereach',              'p9-socks',        'g-lakegrove'],
};

const DEST = 'https://quote.jagg-roofing.com/';

async function handleShortLink(url, request, env, ctx) {
  const slug = url.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();

  // bare domain or unknown slug: send them to the quote page rather than a 404
  const entry = LINKS[slug];
  const target = new URL(DEST);
  target.searchParams.set('utm_source', 'facebook');
  target.searchParams.set('utm_medium', 'fb_group');
  target.searchParams.set('utm_campaign', 'rtw_jagg');
  if (entry) {
    target.searchParams.set('utm_content', entry[2]);
    target.searchParams.set('utm_term', entry[3]);
    target.searchParams.set('rtw_pid', slug);
  }

  const cf = request.cf || {};
  const ua = request.headers.get('user-agent') || '';
  // Facebook, Slack and friends fetch every link for a preview card. Those are
  // not people, and counting them would inflate every number on the dashboard.
  const isBot = /bot|crawler|spider|facebookexternalhit|preview|slackbot|whatsapp|headless/i.test(ua);

  if (env.DB) {
    const now = new Date();
    ctx.waitUntil(env.DB.prepare(
      `INSERT INTO clicks (slug, ts, day, city, region, country, device, bot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(slug, now.toISOString(), localDay(now), cf.city || null, cf.region || null,
            cf.country || null, /mobile|android|iphone/i.test(ua) ? 'mobile' : 'desktop',
            isBot ? 1 : 0)
      .run().catch((e) => console.error('click insert failed', e && e.message)));
  }

  console.log(JSON.stringify({
    evt: 'click', slug, known: !!entry, bot: isBot,
    post: entry ? entry[0] : null, group: entry ? entry[1] : null,
    city: cf.city || null, region: cf.region || null, country: cf.country || null,
    ua: (request.headers.get('user-agent') || '').slice(0, 120),
    ref: request.headers.get('referer') || null,
    ts: new Date().toISOString(),
  }));

  return Response.redirect(target.toString(), 302);
}

/* ------------------------------------------- lead source history report */

/**
 * Counts jobs by lead source and month over a date range.
 *
 * AccuLynx has no lead-source filter and does not expand leadSource on the
 * list endpoint, so this lists job ids for the range and then reads each job
 * individually. Jobs are fetched in small concurrent batches to stay inside
 * the documented rate limit.
 */
async function handleLeadSourceReport(url, env) {
  const token = url.searchParams.get('token') || '';
  if (!env.DIAG_TOKEN || token !== env.DIAG_TOKEN) return json({ ok: false, error: 'Not found' }, 404);

  const from = url.searchParams.get('from') || '2026-06-01';
  const to = url.searchParams.get('to') || '2026-10-31';
  const cap = Math.min(Number(url.searchParams.get('cap') || 400), 800);

  // 1. page the job list for the window
  const ids = [];
  let start = 0;
  while (ids.length < cap) {
    const page = await acculynx(env,
      `/jobs?startDate=${from}&endDate=${to}&dateFilterType=CreatedDate` +
      `&pageSize=25&pageStartIndex=${start}&sortBy=CreatedDate&sortOrder=Ascending`);
    const rows = listOf(page);
    if (!rows.length) break;
    for (const r of rows) if (r && r.id) ids.push(r.id);
    if (rows.length < 25) break;
    start += 25;
  }

  if (url.searchParams.get('debug')) {
    const one = ids.length ? await acculynx(env, `/jobs/${ids[0]}`) : null;
    return json({ ok: true, found: ids.length, sampleKeys: one ? Object.keys(one) : [], sample: one });
  }

  // 2. read each job for its lead source, 6 at a time
  const byMonth = {};
  const bySource = {};
  let read = 0, failed = 0;
  for (let i = 0; i < ids.length; i += 6) {
    const batch = await Promise.all(ids.slice(i, i + 6).map((id) =>
      acculynx(env, `/jobs/${id}`).catch(() => null)));
    for (const j of batch) {
      if (!j) { failed++; continue; }
      read++;
      const src = (j.leadSource && (j.leadSource.name || j.leadSource.description)) || 'None';
      const created = String(j.createdDate || j.created || j.createdOn || '').slice(0, 7) || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;
      byMonth[created] = byMonth[created] || {};
      byMonth[created][src] = (byMonth[created][src] || 0) + 1;
    }
  }

  return json({
    ok: true, from, to,
    jobsInRange: ids.length, read, failed,
    bySource: Object.fromEntries(Object.entries(bySource).sort((a, b) => b[1] - a[1])),
    byMonth: Object.fromEntries(Object.entries(byMonth).sort()),
  });
}

/* ------------------------------------------------------------ lead intake */

async function handleLead(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }

  const name = String(body.name || '').trim();
  const phoneDigits = String(body.phoneDigits || '').replace(/\D/g, '');
  const email = String(body.email || '').trim();
  const street1 = String(body.street1 || '').trim();
  const city = String(body.city || '').trim();
  const state = String(body.state || '').trim();
  const zip = String(body.zip || '').trim();
  const service = String(body.service || '').trim();

  if (!name || phoneDigits.length < 7 || !street1 || !city || !state || !zip) {
    return json({ ok: false, error: 'Missing required fields' }, 400);
  }
  if (!env.ACCULYNX_API_KEY) {
    ctx.waitUntil(notifyFallback(env, body, 'ACCULYNX_API_KEY is not configured'));
    return json({ ok: false, error: 'CRM not configured' }, 500);
  }

  const { firstName, lastName } = splitName(name);
  const noteLines = [
    'Submitted from the JAGG estimate landing page.',
    service ? 'Service requested: ' + service : 'Service requested: (not specified)',
    body.pageUrl ? 'Page: ' + body.pageUrl : '',
    body.referrer ? 'Referrer: ' + body.referrer : '',
    body.utm ? 'Query: ' + body.utm : '',
  ].filter(Boolean);
  const notes = noteLines.join('\n').slice(0, 1000);

  try {
    const lookups = await getLookups(env);

    // AccuLynx requires a 10-digit national number; keep the raw entry in the
    // note when it isn't a US/CA number so nothing is silently dropped.
    const national = phoneDigits.length > 10 ? phoneDigits.slice(-10) : phoneDigits;
    const phoneOk = /^\d{10}$/.test(national);

    const contactBody = {
      firstName,
      lastName,
      note: notes + (phoneOk ? '' : '\nPhone as entered: ' + String(body.phone || '')),
      phoneNumbers: phoneOk
        ? [{ number: national, primary: true, type: 'Mobile', hasTextingAvailable: true }]
        : [],
    };
    if (lookups.contactTypeId) contactBody.contactTypeIds = [lookups.contactTypeId];
    if (email) contactBody.emailAddresses = [{ address: email, primary: true, type: 'Personal' }];

    const created = await acculynx(env, '/contacts', {
      method: 'POST',
      body: JSON.stringify(contactBody),
    });

    const contactId = created && (created.id || created.contactId || (created.data && created.data.id));
    if (!contactId) throw new Error('No contact id returned: ' + JSON.stringify(created).slice(0, 300));

    const jobBody = {
      contact: { id: contactId },
      locationAddress: { street1, city, state, country: 'US', zipCode: zip },
      priority: 'Normal',
      notes,
    };
    if (lookups.leadSourceId) jobBody.leadSource = { id: lookups.leadSourceId };
    const trades = tradeIdsFor(service, lookups.tradeByName);
    if (trades.length) jobBody.tradeTypes = trades;

    const job = await acculynx(env, '/jobs', { method: 'POST', body: JSON.stringify(jobBody) });

    return json({ ok: true, jobId: job && (job.id || job.jobId) });
  } catch (err) {
    console.error('AccuLynx submission failed', err && err.message);
    // Never lose the lead because the CRM is down.
    ctx.waitUntil(notifyFallback(env, body, err && err.message));
    return json({ ok: false, error: 'CRM submission failed' }, 502);
  }
}

async function notifyFallback(env, body, reason) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return;
  const rows = Object.entries(body)
    .map(([k, v]) => '<tr><td><b>' + k + '</b></td><td>' + String(v ?? '') + '</td></tr>')
    .join('');
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + env.RESEND_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.NOTIFY_FROM || 'JAGG Estimates <leads@jaggroofingsidingandwindows.com>',
        to: [env.NOTIFY_EMAIL],
        subject: 'JAGG estimate request (AccuLynx handoff failed)',
        html:
          '<p>A form submission could not be written to AccuLynx.</p><p><b>Reason:</b> ' +
          String(reason || 'unknown') +
          '</p><table border="1" cellpadding="6" cellspacing="0">' + rows + '</table>',
      }),
    });
  } catch (e) {
    console.error('Fallback notification failed', e && e.message);
  }
}
