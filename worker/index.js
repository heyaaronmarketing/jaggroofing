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

import { handleStats } from './stats.js';

const ACCULYNX = 'https://api.acculynx.com/api/v2';

// Account-specific lookup ids, resolved once per isolate.
let lookupCache = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // go.jagg-roofing.com/<slug> — short links for the Facebook group posts
    if (url.hostname.startsWith('go.')) return handleShortLink(url, request, env, ctx);

    // The group board carries competitive data and the do-not-post list, and
    // the progress dashboard is internal, so both stay private. The week-1 page
    // is the client's own copy for review and must open without a password.
    // Gate narrowly by exact prefix — gating all of /review/* once locked the
    // client out of their own review page.
    for (const priv of ['/review/groups', '/review/stats', '/review/join']) {
      if (url.pathname === priv || url.pathname.startsWith(priv + '/')
          || url.pathname.startsWith(priv + '.')) {
        const gate = reviewGate(request, env, priv);
        if (gate) return gate;
      }
    }

    if (url.pathname === '/review/stats' || url.pathname === '/review/stats/') {
      return handleStats(url, env, LINKS);
    }

    if (url.pathname === '/api/geo') return handleGeo(url);
    if (url.pathname === '/api/lookups') return handleLookups(url, env);
    if (url.pathname === '/api/lead-source-report') return handleLeadSourceReport(url, env);
    if (url.pathname === '/api/sync-leads') return handleSyncLeads(url, env);
    if (url.pathname === '/api/schedule') return handleSchedule(request, env);
    if (url.pathname === '/api/joins') return handleJoins(request, env);
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
function reviewGate(request, env, scope) {
  const pw = env.REVIEW_PASSWORD || 'shingle';
  const url = new URL(request.url);

  if (url.searchParams.get('pw') === pw) {
    const to = new URL(url); to.searchParams.delete('pw');
    return new Response(null, {
      status: 302,
      headers: {
        location: to.pathname + to.search,
        'set-cookie': `${REVIEW_COOKIE}=${pw}; Path=${scope}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
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
 * `members` and `at` exist so the dashboard can report reach and spot a post
 * that was scheduled but never actually went out. Week 2 times are provisional
 * until the VA confirms the groupposting.com queue.
 */
/**
 * One slug per (post x group) so a lead traces to the exact post and group that
 * produced it. Slugs live here rather than in a database so the redirect is a
 * single edge hop with nothing to go wrong on launch day.
 *
 * Group selection comes from Ride the Wave's own export: these are the groups
 * that accepted four or more of their posts and were still accepting in
 * October. Repeat tolerance is not proof of conversion - JAGG's ~10 leads a
 * month across 100 groups is far too thin to attribute - but it is the only
 * hard evidence there is, and it beats picking by member count.
 *
 * Three groups per post, six placements a day. Six a day was Ride the Wave's
 * observed ceiling across 258 posts; going past it on a warm account is an
 * untested risk for no measured gain.
 */
const LINKS = {
  w1a:   { post: 'Just finished - full roof',   group: 'Shirley and the Mastics',                      content: 'p1-justfinished',   term: 'g-shirleymastics',       members: 57000,  at: '2026-11-05T19:00', week: 1 },
  w1a2:  { post: 'Just finished - full roof',   group: 'Town of Babylon group',                        content: 'p1-justfinished',   term: 'g-babylontown',          members: 31100,  at: '2026-11-05T23:00', week: 1 },
  w1a3:  { post: 'Just finished - full roof',   group: 'Coram Community News',                         content: 'p1-justfinished',   term: 'g-coram',                members: 8000,   at: '2026-11-06T00:00', week: 1 },
  w1b:   { post: 'Once the crew leaves',        group: 'Centereach NY Community Group',                content: 'p2-aftercare',      term: 'g-centereach',           members: 21300,  at: '2026-11-06T11:00', week: 1 },
  w1b2:  { post: 'Once the crew leaves',        group: 'Center Moriches Community Posts',              content: 'p2-aftercare',      term: 'g-centermoriches',       members: 10500,  at: '2026-11-06T12:00', week: 1 },
  w1b3:  { post: 'Once the crew leaves',        group: 'Smithtown Moms and Dads Uncensored',           content: 'p2-aftercare',      term: 'g-smithtownmoms',        members: 12800,  at: '2026-11-06T13:00', week: 1 },
  w1c:   { post: 'Ready for another LI winter', group: 'WHAT\'S UP MONTAUK',                           content: 'p3-winterready',    term: 'g-montauk',              members: 22600,  at: '2026-11-09T10:00', week: 1 },
  w1c2:  { post: 'Ready for another LI winter', group: 'Westhampton Beach Area Community LOCAL',       content: 'p3-winterready',    term: 'g-westhamptonbeach',     members: 4200,   at: '2026-11-09T11:00', week: 1 },
  w1c3:  { post: 'Ready for another LI winter', group: 'Wake Up Lake!',                                content: 'p3-winterready',    term: 'g-wakeuplake',           members: 6700,   at: '2026-11-09T13:00', week: 1 },
  w1d:   { post: 'Most roofers say replace',    group: 'Bohemia, Ronkonkoma, Sayville',                content: 'p4-replacerepair',  term: 'g-bohemia',              members: 24100,  at: '2026-11-09T14:00', week: 1 },
  w1d2:  { post: 'Most roofers say replace',    group: 'The Deer Park We all remember',                content: 'p4-replacerepair',  term: 'g-deerpark',             members: 12800,  at: '2026-11-09T15:00', week: 1 },
  w1d3:  { post: 'Most roofers say replace',    group: 'Positively East Islip',                        content: 'p4-replacerepair',  term: 'g-positivelyeastislip',  members: 6300,   at: '2026-11-09T17:00', week: 1 },
  w1e:   { post: 'Family / pumpkins',           group: 'Patchogue-Medford Mom\'s & Dad\'s Group',      content: 'p5-family',         term: 'g-patchoguemedmoms',     members: 6600,   at: '2026-11-10T10:00', week: 1 },
  w1e2:  { post: 'Family / pumpkins',           group: 'Shirley/Mastics Community Group',              content: 'p5-family',         term: 'g-shirleymasticscomm',   members: 19800,  at: '2026-11-10T11:00', week: 1 },
  w1e3:  { post: 'Family / pumpkins',           group: 'Sayville Moms and Dads Uncensored',            content: 'p5-family',         term: 'g-sayvillemoms',         members: 2400,   at: '2026-11-10T13:00', week: 1 },
  w1f:   { post: 'First company photo',         group: 'MT. SINAI/MILLER PLACE COMMUNITY BUSINESS',    content: 'p6-crew',           term: 'g-mtsinaimillerplace',   members: 9300,   at: '2026-11-10T14:00', week: 1 },
  w1f2:  { post: 'First company photo',         group: 'Islip That & This',                            content: 'p6-crew',           term: 'g-islipthatthis',        members: 6000,   at: '2026-11-10T15:00', week: 1 },
  w1f3:  { post: 'First company photo',         group: 'Brightwaters/Bay Shore Community Uncensored',  content: 'p6-crew',           term: 'g-brightwaters',         members: 6600,   at: '2026-11-10T17:00', week: 1 },
  w2a:   { post: 'Four generations in Suffolk', group: 'East Patchogue Community',                     content: 'p7-generations',    term: 'g-eastpatchoguecommu',   members: 28900,  at: '2026-11-11T10:00', week: 2 },
  w2b:   { post: 'As a father',                 group: 'Patchogue Community NY',                       content: 'p8-asafather',      term: 'g-patchoguecommunity',   members: 14000,  at: '2026-11-11T13:00', week: 2 },
  w2c:   { post: 'The socks photo',             group: 'Islip Terrace And All Of The Islips',          content: 'p9-socks',          term: 'g-islipterraceandall',   members: 13300,  at: '2026-11-11T15:00', week: 2 },
  w2d:   { post: 'Four generations in Suffolk', group: 'The People Of Lindenhurst',                    content: 'p7-generations',    term: 'g-thepeopleoflindenh',   members: 9400,   at: '2026-11-11T17:00', week: 2 },
  w2e:   { post: 'As a father',                 group: 'Babylon Village Connection',                   content: 'p8-asafather',      term: 'g-babylonvillageconn',   members: 8200,   at: '2026-11-12T10:00', week: 2 },
  w2f:   { post: 'The socks photo',             group: 'Parents of Huntington',                        content: 'p9-socks',          term: 'g-parentsofhuntingto',   members: 7400,   at: '2026-11-12T13:00', week: 2 },
  w2g:   { post: 'Four generations in Suffolk', group: 'North Babylon Community Group',                content: 'p7-generations',    term: 'g-northbabyloncommun',   members: 7200,   at: '2026-11-12T15:00', week: 2 },
  w2h:   { post: 'As a father',                 group: 'SHIRLEY - MASTIC’S - MORICHES - SMITH POINT',  content: 'p8-asafather',      term: 'g-shirleymasticsmori',   members: 7300,   at: '2026-11-12T17:00', week: 2 },
  w2i:   { post: 'The socks photo',             group: 'Huntington Station Matters',                   content: 'p9-socks',          term: 'g-huntingtonstationm',   members: 5700,   at: '2026-11-13T10:00', week: 2 },
  w2j:   { post: 'Four generations in Suffolk', group: 'Amityville Families & Community Group',        content: 'p7-generations',    term: 'g-amityvillefamilies',   members: 5300,   at: '2026-11-13T13:00', week: 2 },
  w2k:   { post: 'As a father',                 group: 'Happy Days In Hampton Bays',                   content: 'p8-asafather',      term: 'g-happydaysinhampton',   members: 4500,   at: '2026-11-13T15:00', week: 2 },
  w2l:   { post: 'The socks photo',             group: 'Miller Place Parents & Communities',           content: 'p9-socks',          term: 'g-millerplaceparents',   members: 2700,   at: '2026-11-13T17:00', week: 2 },
  w3a:   { post: 'Just finished - full roof',   group: 'Huntington Matters Community Forum',           content: 'p1-justfinished',   term: 'g-huntingtonmattersc',   members: 61700,  at: '2026-11-09T12:00', week: 3 },
  w3b:   { post: 'Just finished - full roof',   group: 'Kings Park Community',                         content: 'p1-justfinished',   term: 'g-kingsparkcommunity',   members: 28700,  at: '2026-11-09T16:00', week: 3 },
  w3c:   { post: 'Just finished - full roof',   group: 'Massapequa Moms',                              content: 'p1-justfinished',   term: 'g-massapequamoms',       members: 10700,  at: '2026-11-09T18:00', week: 3 },
  w3d:   { post: 'Once the crew leaves',        group: 'Plainview Moms',                               content: 'p2-aftercare',      term: 'g-plainviewmoms',        members: 8400,   at: '2026-11-10T12:00', week: 3 },
  w3e:   { post: 'Once the crew leaves',        group: 'Dix Hills Moms / South Huntington Moms',       content: 'p2-aftercare',      term: 'g-dixhillsmomssouthh',   members: 13600,  at: '2026-11-10T16:00', week: 3 },
  w3f:   { post: 'Once the crew leaves',        group: 'Mastic, Shirley, Mastic beach our community page!', content: 'p2-aftercare',      term: 'g-masticshirleymasti',   members: 12200,  at: '2026-11-10T18:00', week: 3 },
  w3g:   { post: 'The socks photo',             group: 'East Moriches Community Posts',                content: 'p9-socks',          term: 'g-eastmorichescommun',   members: 20800,  at: '2026-11-11T11:00', week: 3 },
  w3h:   { post: 'The socks photo',             group: 'West Islip Community',                         content: 'p9-socks',          term: 'g-westislipcommunity',   members: 6400,   at: '2026-11-11T12:00', week: 3 },
  w3i:   { post: 'The socks photo',             group: 'Neighbors of Quogue Westhampton Speonk Remsenburg Eastport Manorville', content: 'p9-socks',          term: 'g-neighborsofquoguew',   members: 14100,  at: '2026-11-11T14:00', week: 3 },
  w3j:   { post: 'Ready for another LI winter', group: 'East Hampton Ny Community News',               content: 'p3-winterready',    term: 'g-easthamptonnycommu',   members: 17900,  at: '2026-11-11T16:00', week: 3 },
  w3k:   { post: 'Ready for another LI winter', group: 'Copiague Friends and Neighbors',               content: 'p3-winterready',    term: 'g-copiaguefriendsand',   members: 7200,   at: '2026-11-11T18:00', week: 3 },
  w3l:   { post: 'Most roofers say replace',    group: 'Port Jeff, Port Jefferson Station , & Terryville Neighborhood Page',                             content: 'p4-replacerepair',  term: 'g-portjeffportjeffer',       members: 6100,   at: '2026-11-12T11:00', week: 3 },
  w3m:   { post: 'Most roofers say replace',    group: 'Long Island, NY Business Owners',              content: 'p4-replacerepair',  term: 'g-longislandnybusine',   members: 27500,  at: '2026-11-12T12:00', week: 3 },
  w3n:   { post: 'Family / pumpkins',           group: 'Lindenhurst, my Home Town',    content: 'p5-family',         term: 'g-lindenhurstmyhomet',   members: 8300,  at: '2026-11-12T14:00', week: 3 },
  w3o:   { post: 'Family / pumpkins',           group: 'I AM WYANDANCH',                   content: 'p5-family',         term: 'g-iamwyandanch',   members: 3400,   at: '2026-11-12T16:00', week: 3 },
  w3p:   { post: 'First company photo',         group: 'Deer Park NY - News, Gossip and Chatter',      content: 'p6-crew',           term: 'g-deerparknynewsgoss',   members: 11200,  at: '2026-11-12T18:00', week: 3 },
  w3q:   { post: 'First company photo',         group: 'Rocky Point & Local Surrounding Businesses/Organizations', content: 'p6-crew',           term: 'g-rockypointlocalsur',   members: 8500,   at: '2026-11-13T11:00', week: 3 },
  w3r:   { post: 'Four generations in Suffolk', group: 'East Islip NY Uncensored',                                    content: 'p7-generations',    term: 'g-eastislipnyuncenso',            members: 4200,  at: '2026-11-13T12:00', week: 3 },
  w3s:   { post: 'Four generations in Suffolk', group: 'Everything Babylon',           content: 'p7-generations',    term: 'g-everythingbabylon',   members: 6300,   at: '2026-11-13T14:00', week: 3 },
  w3t:   { post: 'As a father',                 group: 'West Babylon NY Moms & Dads',                              content: 'p8-asafather',      term: 'g-westbabylonnymomsd',       members: 4200,   at: '2026-11-13T16:00', week: 3 },
  w3u:   { post: 'As a father',                 group: 'Lindenhurst, NY - Events around town',         content: 'p8-asafather',      term: 'g-lindenhurstnyevent',   members: 7900,   at: '2026-11-13T18:00', week: 3 },
  w4a1:   { post: 'Just finished - full roof',   group: 'Port Jefferson, Setauket, Stony Brook & Mount Sinai Recommendations', content: 'p1-justfinished',   term: 'g-portjeffersonsetau',   members: 6100,   at: '2026-11-16T10:00', week: 4 },
  w4b1:   { post: 'Once the crew leaves',        group: 'Wyandanch Stand Up',                           content: 'p2-aftercare',      term: 'g-wyandanchstandup',     members: 4200,   at: '2026-11-16T11:00', week: 4 },
  w4c1:   { post: 'Ready for another LI winter', group: 'Farmingville Community Page',                  content: 'p3-winterready',    term: 'g-farmingvillecommun',   members: 4500,   at: '2026-11-16T12:00', week: 4 },
  w4d1:   { post: 'Most roofers say replace',    group: 'You really know you\'re from Huntington if',   content: 'p4-replacerepair',  term: 'g-youreallyknowyoure',   members: 1900,   at: '2026-11-16T13:00', week: 4 },
  w4e1:   { post: 'Family / pumpkins',           group: 'Yaphank News',                                 content: 'p5-family',         term: 'g-yaphanknews',          members: 2000,   at: '2026-11-16T14:00', week: 4 },
  w4f1:   { post: 'First company photo',         group: 'Smithtown , St. James , Nesconset and Hauppauge - United We Stand', content: 'p6-crew',           term: 'g-smithtownstjamesne',   members: 4000,   at: '2026-11-16T15:00', week: 4 },
  w4g1:   { post: 'Four generations in Suffolk', group: 'Huntington Station Community Forum',           content: 'p7-generations',    term: 'g-huntingtonstationc',   members: 2300,   at: '2026-11-16T16:00', week: 4 },
  w4h1:   { post: 'As a father',                 group: 'Syosset ~ Long Island, NY',                    content: 'p8-asafather',      term: 'g-syossetlongislandn',   members: 2000,   at: '2026-11-16T17:00', week: 4 },
  w4i1:   { post: 'The socks photo',             group: 'Lindenhurst Uncensored',                       content: 'p9-socks',          term: 'g-lindenhurstuncenso',   members: 3300,   at: '2026-11-16T18:00', week: 4 },
  w4a2:   { post: 'Just finished - full roof',   group: 'Growing up Copiague',                          content: 'p1-justfinished',   term: 'g-growingupcopiague',    members: 3200,   at: '2026-11-17T10:00', week: 4 },
  w4b2:   { post: 'Once the crew leaves',        group: 'Mastic Beach, NY: Support Your Neighbors!',    content: 'p2-aftercare',      term: 'g-masticbeachnysuppo',   members: 3500,   at: '2026-11-17T11:00', week: 4 },
  w4c2:   { post: 'Ready for another LI winter', group: 'Miller Place / Sound Beach Community',         content: 'p3-winterready',    term: 'g-millerplacesoundbe',   members: 3500,   at: '2026-11-17T12:00', week: 4 },
  w4d2:   { post: 'Most roofers say replace',    group: 'Sound Beach Neighbors',                        content: 'p4-replacerepair',  term: 'g-soundbeachneighbor',   members: 6100,   at: '2026-11-17T13:00', week: 4 },
  w4e2:   { post: 'Family / pumpkins',           group: 'Mount Sinai Community',                        content: 'p5-family',         term: 'g-mountsinaicommunit',   members: 2700,   at: '2026-11-17T14:00', week: 4 },
  w4f2:   { post: 'First company photo',         group: 'Holbrook Happenings',                          content: 'p6-crew',           term: 'g-holbrookhappenings',   members: 7100,   at: '2026-11-17T15:00', week: 4 },
  w4g2:   { post: 'Four generations in Suffolk', group: 'Wading River Shoreham Local Businesses',       content: 'p7-generations',    term: 'g-wadingrivershoreha',   members: 4900,   at: '2026-11-17T16:00', week: 4 },
  w4h2:   { post: 'As a father',                 group: 'Strathmore Court Residents - Coram, NY',       content: 'p8-asafather',      term: 'g-strathmorecourtres',   members: 496,    at: '2026-11-17T17:00', week: 4 },
  w4i2:   { post: 'The socks photo',             group: 'Babylon Village Community... A Page for the People of the Village', content: 'p9-socks',          term: 'g-babylonvillagecomm',   members: 0,      at: '2026-11-17T18:00', week: 4 },
  w4a3:   { post: 'Just finished - full roof',   group: 'Deer Park Talk',                               content: 'p1-justfinished',   term: 'g-deerparktalk',         members: 0,      at: '2026-11-18T10:00', week: 4 },
  w4b3:   { post: 'Once the crew leaves',        group: 'Smithtown Community Alerts',                   content: 'p2-aftercare',      term: 'g-smithtowncommunity',   members: 0,      at: '2026-11-18T11:00', week: 4 },
  w4c3:   { post: 'Ready for another LI winter', group: 'WEST BABYLON 11704',                           content: 'p3-winterready',    term: 'g-westbabylon11704',     members: 0,      at: '2026-11-18T12:00', week: 4 },
  w4d3:   { post: 'Most roofers say replace',    group: 'Nesconset Neighbors United',                   content: 'p4-replacerepair',  term: 'g-nesconsetneighbors',   members: 272,    at: '2026-11-18T13:00', week: 4 },
  w4e3:   { post: 'Family / pumpkins',           group: 'Concerned Citizens of Northport/East Northport', content: 'p5-family',         term: 'g-concernedcitizenso',   members: 0,      at: '2026-11-18T14:00', week: 4 },
  w4f3:   { post: 'First company photo',         group: 'Bayport Blue Point Community',                 content: 'p6-crew',           term: 'g-bayportbluepointco',   members: 8900,   at: '2026-11-18T15:00', week: 4 },
  w4g3:   { post: 'Four generations in Suffolk', group: 'East Islip Parents',                           content: 'p7-generations',    term: 'g-eastislipparents',     members: 6000,   at: '2026-11-18T16:00', week: 4 },
  w4h3:   { post: 'As a father',                 group: 'Northport villagers, NY',                      content: 'p8-asafather',      term: 'g-northportvillagers',   members: 1600,   at: '2026-11-18T17:00', week: 4 },
  w4i3:   { post: 'The socks photo',             group: 'Sayville Happenings & History',                content: 'p9-socks',          term: 'g-sayvillehappenings',   members: 9900,   at: '2026-11-18T18:00', week: 4 },
  w4a4:   { post: 'Just finished - full roof',   group: 'WE ARE NORTH AMITYVILLE',                      content: 'p1-justfinished',   term: 'g-wearenorthamityvil',   members: 0,      at: '2026-11-19T10:00', week: 4 },
  w4b4:   { post: 'Once the crew leaves',        group: 'The Glen Cove Community',                      content: 'p2-aftercare',      term: 'g-theglencovecommuni',   members: 10700,  at: '2026-11-19T11:00', week: 4 },
  w4c4:   { post: 'Ready for another LI winter', group: 'Commack Parents',                              content: 'p3-winterready',    term: 'g-commackparents',       members: 3700,   at: '2026-11-19T12:00', week: 4 },
  w4d4:   { post: 'Most roofers say replace',    group: 'Long Island History',                          content: 'p4-replacerepair',  term: 'g-longislandhistory',    members: 175800, at: '2026-11-19T13:00', week: 4 },
  w4e4:   { post: 'Family / pumpkins',           group: 'Lake Grove (NY) & Surrounding Areas Parents',  content: 'p5-family',         term: 'g-lakegrovenysurroun',   members: 2200,   at: '2026-11-19T14:00', week: 4 },
  w4f4:   { post: 'First company photo',         group: 'WESTHAMPTON BEACH FRIENDS AND NEIGHBORS',      content: 'p6-crew',           term: 'g-westhamptonbeachfr',   members: 1800,   at: '2026-11-19T15:00', week: 4 },
  w4g4:   { post: 'Four generations in Suffolk', group: 'EAST YAPHANK/NORTH SHIRLEY COMMUNITY',         content: 'p7-generations',    term: 'g-eastyaphanknorthsh',   members: 1500,   at: '2026-11-19T16:00', week: 4 },
  w4h4:   { post: 'As a father',                 group: 'Bonac - East Hampton - Southampton NY',        content: 'p8-asafather',      term: 'g-bonaceasthamptonso',   members: 2900,   at: '2026-11-19T17:00', week: 4 },
  w4i4:   { post: 'The socks photo',             group: 'East Quogue Community News',                   content: 'p9-socks',          term: 'g-eastquoguecommunit',   members: 1300,   at: '2026-11-19T18:00', week: 4 },
  w4a5:   { post: 'Just finished - full roof',   group: 'Center Moriches Parents',                      content: 'p1-justfinished',   term: 'g-centermorichespare',   members: 1600,   at: '2026-11-20T10:00', week: 4 },
  w4b5:   { post: 'Once the crew leaves',        group: 'Riverhead Community',                          content: 'p2-aftercare',      term: 'g-riverheadcommunity',   members: 0,      at: '2026-11-20T11:00', week: 4 },
  w4c5:   { post: 'Ready for another LI winter', group: 'Village of Bellport Community (Unrestricted)', content: 'p3-winterready',    term: 'g-villageofbellportc',   members: 1000,   at: '2026-11-20T12:00', week: 4 },
  w4d5:   { post: 'Most roofers say replace',    group: 'NETWORKING IN THE HAMPTONS',                   content: 'p4-replacerepair',  term: 'g-networkingintheham',   members: 8400,   at: '2026-11-20T13:00', week: 4 },
  w4e5:   { post: 'Family / pumpkins',           group: 'bayport Neighborhood community',               content: 'p5-family',         term: 'g-bayportneighborhoo',   members: 909,    at: '2026-11-20T14:00', week: 4 },
  w4f5:   { post: 'First company photo',         group: 'Helping Nobody Starves on Long Island Animal Rescue & Food Pantry', content: 'p6-crew',           term: 'g-helpingnobodystarv',   members: 0,      at: '2026-11-20T15:00', week: 4 },
  w4g5:   { post: 'Four generations in Suffolk', group: 'Unofficial Port Jefferson Village Hot Topics',                         content: 'p7-generations',    term: 'g-unofficialportjeff',    members: 4600,      at: '2026-11-20T16:00', week: 4 },
  w4h5:   { post: 'As a father',                 group: 'Long Island 10-13 Club',                       content: 'p8-asafather',      term: 'g-longisland1013club',   members: 0,      at: '2026-11-20T17:00', week: 4 },
  w4i5:   { post: 'The socks photo',             group: 'Babylon Village Community Discussion',                   content: 'p9-socks',          term: 'g-babylonvillagediscussion',   members: 7800,      at: '2026-11-20T18:00', week: 4 },
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
    target.searchParams.set('utm_content', entry.content);
    target.searchParams.set('utm_term', entry.term);
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
      `INSERT INTO clicks (slug, ts, day, city, region, country, device, bot, ua)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(slug, now.toISOString(), localDay(now), cf.city || null, cf.region || null,
            cf.country || null, /mobile|android|iphone/i.test(ua) ? 'mobile' : 'desktop',
            isBot ? 1 : 0, ua.slice(0, 200) || null)
      .run().catch((e) => console.error('click insert failed', e && e.message)));
  }

  console.log(JSON.stringify({
    evt: 'click', slug, known: !!entry, bot: isBot,
    post: entry ? entry.post : null, group: entry ? entry.group : null,
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

/* ------------------------------------------------- scheduling checklist */

/**
 * Tracks which placements have actually been queued in groupposting.com.
 *
 * Open to anyone holding the link, both reads and writes. See the note on the
 * write path for why the key gate was taken out.
 */
async function handleSchedule(request, env) {
  if (!env.DB) return json({ ok: false, error: 'No database binding' }, 503);

  if (request.method === 'GET') {
    const rs = await env.DB.prepare(
      'SELECT slug, done_at, done_by FROM placements_done').all();
    const done = {};
    for (const r of rs.results || []) done[r.slug] = { at: r.done_at, by: r.done_by };
    return json({ ok: true, done });
  }

  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }

  // No key check. Gating writes behind a ?k= meant bookmarks and copied links
  // silently disabled every button, which made the feature look broken three
  // times running. The stakes here are a checkbox on an unlisted page, and
  // reliability is worth more than stopping an accidental toggle.
  const slug = String(body.slug || '').toLowerCase();
  if (!LINKS[slug]) return json({ ok: false, error: 'Unknown placement' }, 400);
  const by = String(body.by || '').slice(0, 40) || null;

  if (body.done) {
    await env.DB.prepare(
      `INSERT INTO placements_done (slug, done_at, done_by) VALUES (?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET done_at = excluded.done_at, done_by = excluded.done_by`)
      .bind(slug, new Date().toISOString(), by).run();
  } else {
    await env.DB.prepare('DELETE FROM placements_done WHERE slug = ?').bind(slug).run();
  }
  return json({ ok: true, slug, done: !!body.done });
}

/* ------------------------------------------------------- join tracking */

/**
 * Which groups the VA has requested to join.
 *
 * Open like the posting checklist, and for the same reason. Status is a free
 * string rather than a boolean because a join request can be sent, accepted or
 * declined, and "declined" is the one worth keeping — it stops the group being
 * handed back to the VA next week.
 */
async function handleJoins(request, env) {
  if (!env.DB) return json({ ok: false, error: 'No database binding' }, 503);

  if (request.method === 'GET') {
    const rs = await env.DB.prepare(
      'SELECT gid, status, done_at, done_by FROM group_joins').all();
    const rows = {};
    for (const r of rs.results || []) {
      rows[r.gid] = { status: r.status, at: r.done_at, by: r.done_by };
    }
    return json({ ok: true, joins: rows });
  }

  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }

  const gid = String(body.gid || '').slice(0, 80);
  if (!/^[a-z0-9-]{3,80}$/.test(gid)) return json({ ok: false, error: 'Bad group id' }, 400);
  const status = String(body.status || '');
  const by = String(body.by || '').slice(0, 40) || null;

  if (!status) {
    await env.DB.prepare('DELETE FROM group_joins WHERE gid = ?').bind(gid).run();
    return json({ ok: true, gid, status: null });
  }
  if (!['requested', 'joined', 'declined'].includes(status)) {
    return json({ ok: false, error: 'Bad status' }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO group_joins (gid, status, done_at, done_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(gid) DO UPDATE SET status = excluded.status,
       done_at = excluded.done_at, done_by = excluded.done_by`)
    .bind(gid, status, new Date().toISOString(), by).run();
  return json({ ok: true, gid, status });
}

/* --------------------------------------------------- lead reconciliation */

/**
 * Pulls jobs from AccuLynx for a window and upserts the ones carrying our lead
 * source into D1.
 *
 * The form already writes every lead it creates, so this is a reconciliation
 * pass, not the primary path. It matters because the dashboard's numbers get
 * emailed to the owner: this is how we prove the count matches the CRM rather
 * than asking anyone to take it on faith. It also backfills leads created
 * before the dashboard existed.
 *
 * AccuLynx cannot filter by lead source and does not expand it on the list
 * endpoint, so each job in the window has to be read individually.
 */
async function handleSyncLeads(url, env) {
  const token = url.searchParams.get('token') || '';
  if (!env.DIAG_TOKEN || token !== env.DIAG_TOKEN) return json({ ok: false, error: 'Not found' }, 404);
  if (!env.DB) return json({ ok: false, error: 'No database binding' }, 503);

  const want = (env.LEAD_SOURCE_NAME || 'Hey Aaron').trim().toLowerCase();
  const from = url.searchParams.get('from') || '2026-11-01';
  const to = url.searchParams.get('to') || localDay();
  const cap = Math.min(Number(url.searchParams.get('cap') || 300), 600);

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

  const matched = [];
  let read = 0, failed = 0;
  for (let i = 0; i < ids.length; i += 6) {
    const batch = await Promise.all(ids.slice(i, i + 6).map((id) =>
      acculynx(env, `/jobs/${id}`).catch(() => null)));
    for (const j of batch) {
      if (!j) { failed++; continue; }
      read++;
      const src = (j.leadSource && (j.leadSource.name || j.leadSource.description)) || '';
      if (src.trim().toLowerCase() !== want) continue;

      // Test jobs are deliberately named so they can be excluded and deleted.
      const label = JSON.stringify(j).slice(0, 4000);
      if (/ZZTEST/i.test(label)) continue;

      const notes = String(j.notes || j.note || '');
      const m = notes.match(/rtw_pid=([a-z0-9]+)/i);
      const created = String(j.createdDate || j.created || j.createdOn || '');
      const addr = j.locationAddress || j.jobAddress || {};
      matched.push({
        job_id: String(j.id),
        created,
        day: created.slice(0, 10) || localDay(),
        lead_source: src,
        slug: m ? m[1].toLowerCase() : null,
        town: addr.city || null,
        trade: (listOf(j.tradeTypes).map(nameOf).filter(Boolean).join(', ')) || null,
      });
    }
  }

  if (matched.length) {
    await env.DB.batch(matched.map((r) => env.DB.prepare(
      `INSERT OR REPLACE INTO leads
         (job_id, created, day, lead_source, slug, town, trade, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(r.job_id, r.created, r.day, r.lead_source, r.slug, r.town, r.trade,
            new Date().toISOString())));
  }

  const have = await env.DB.prepare(
    'SELECT COUNT(*) AS n, SUM(CASE WHEN slug IS NULL THEN 1 ELSE 0 END) AS untraced FROM leads').first();

  return json({
    ok: true, from, to, leadSource: env.LEAD_SOURCE_NAME || 'Hey Aaron',
    jobsInWindow: ids.length, read, failed,
    matchedThisSource: matched.length,
    leadsInDashboard: have && have.n, untraced: have && have.untraced,
    slugs: matched.reduce((a, r) => { const k = r.slug || '(none)'; a[k] = (a[k] || 0) + 1; return a; }, {}),
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
    const jobId = job && (job.id || job.jobId);

    // Record the lead locally too. The form knows which post produced it; by
    // the time it reaches AccuLynx that is buried in a free-text note, so this
    // is the only place the attribution is cheap and certain.
    if (env.DB && jobId) {
      const now = new Date();
      let slug = null;
      try { slug = new URLSearchParams(String(body.utm || '').replace(/^\?/, '')).get('rtw_pid'); } catch { /* ignore */ }
      ctx.waitUntil(env.DB.prepare(
        `INSERT OR REPLACE INTO leads
           (job_id, created, day, lead_source, slug, town, trade, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(String(jobId), now.toISOString(), localDay(now),
              env.LEAD_SOURCE_NAME || null, slug, city || null, service || null,
              now.toISOString())
        .run().catch((e) => console.error('lead insert failed', e && e.message)));
    }

    return json({ ok: true, jobId });
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
