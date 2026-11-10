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
  w101:   { post: 'Ready for another LI winter', group: 'WHAT\'S UP MONTAUK',                           content: 'p3-winterready',    term: 'g-montauk',              members: 22600,  at: '2026-11-09T11:00', week: 1 },
  w102:  { post: 'Ready for another LI winter', group: 'Westhampton Beach Area Community LOCAL',       content: 'p3-winterready',    term: 'g-westhamptonbeach',     members: 4200,   at: '2026-11-09T12:00', week: 1 },
  w104:  { post: 'Ready for another LI winter', group: 'Wake Up Lake!',                                content: 'p3-winterready',    term: 'g-wakeuplake',           members: 6700,   at: '2026-11-09T14:00', week: 1 },
  w105:   { post: 'Most roofers say replace',    group: 'Bohemia, Ronkonkoma, Sayville',                content: 'p4-replacerepair',  term: 'g-bohemia',              members: 24100,  at: '2026-11-09T15:00', week: 1 },
  w106:  { post: 'Most roofers say replace',    group: 'The Deer Park We all remember',                content: 'p4-replacerepair',  term: 'g-deerpark',             members: 12800,  at: '2026-11-09T16:00', week: 1 },
  w108:  { post: 'Most roofers say replace',    group: 'Positively East Islip',                        content: 'p4-replacerepair',  term: 'g-positivelyeastislip',  members: 6300,   at: '2026-11-09T18:00', week: 1 },
  w110:   { post: 'Family / pumpkins',           group: 'Patchogue-Medford Mom\'s & Dad\'s Group',      content: 'p5-family',         term: 'g-patchoguemedmoms',     members: 6600,   at: '2026-11-10T07:00', week: 1 },
  w111:  { post: 'Family / pumpkins',           group: 'Shirley/Mastics Community Group',              content: 'p5-family',         term: 'g-shirleymasticscomm',   members: 19800,  at: '2026-11-10T09:00', week: 1 },
  w113:  { post: 'Family / pumpkins',           group: 'Sayville Moms and Dads Uncensored',            content: 'p5-family',         term: 'g-sayvillemoms',         members: 2400,   at: '2026-11-10T15:00', week: 1 },
  w114:   { post: 'First company photo',         group: 'MT. SINAI/MILLER PLACE COMMUNITY BUSINESS',    content: 'p6-crew',           term: 'g-mtsinaimillerplace',   members: 9300,   at: '2026-11-10T16:00', week: 1 },
  w115:  { post: 'First company photo',         group: 'Islip That & This',                            content: 'p6-crew',           term: 'g-islipthatthis',        members: 6000,   at: '2026-11-10T18:00', week: 1 },
  w117:  { post: 'First company photo',         group: 'Brightwaters/Bay Shore Community Uncensored',  content: 'p6-crew',           term: 'g-brightwaters',         members: 6600,   at: '2026-11-10T20:00', week: 1 },
  w119:   { post: 'Four generations in Suffolk', group: 'East Patchogue Community',                     content: 'p7-generations',    term: 'g-eastpatchoguecommu',   members: 28900,  at: '2026-11-11T07:00', week: 1 },
  w122:   { post: 'As a father',                 group: 'Patchogue Community NY',                       content: 'p8-asafather',      term: 'g-patchoguecommunity',   members: 14000,  at: '2026-11-11T15:00', week: 1 },
  w124:   { post: 'The socks photo',             group: 'Islip Terrace And All Of The Islips',          content: 'p9-socks',          term: 'g-islipterraceandall',   members: 13300,  at: '2026-11-11T18:00', week: 1 },
  w126:   { post: 'Four generations in Suffolk', group: 'The People Of Lindenhurst',                    content: 'p7-generations',    term: 'g-thepeopleoflindenh',   members: 9400,   at: '2026-11-11T20:00', week: 1 },
  w128:   { post: 'As a father',                 group: 'Babylon Village Connection',                   content: 'p8-asafather',      term: 'g-babylonvillageconn',   members: 8200,   at: '2026-11-12T07:00', week: 1 },
  w131:   { post: 'The socks photo',             group: 'Parents of Huntington',                        content: 'p9-socks',          term: 'g-parentsofhuntingto',   members: 7400,   at: '2026-11-12T15:00', week: 1 },
  w133:   { post: 'Four generations in Suffolk', group: 'North Babylon Community Group',                content: 'p7-generations',    term: 'g-northbabyloncommun',   members: 7200,   at: '2026-11-12T18:00', week: 1 },
  w135:   { post: 'As a father',                 group: 'SHIRLEY - MASTIC’S - MORICHES - SMITH POINT',  content: 'p8-asafather',      term: 'g-shirleymasticsmori',   members: 7300,   at: '2026-11-12T20:00', week: 1 },
  w137:   { post: 'The socks photo',             group: 'Huntington Station Matters',                   content: 'p9-socks',          term: 'g-huntingtonstationm',   members: 5700,   at: '2026-11-13T07:00', week: 1 },
  w140:   { post: 'Four generations in Suffolk', group: 'Amityville Families & Community Group',        content: 'p7-generations',    term: 'g-amityvillefamilies',   members: 5300,   at: '2026-11-13T15:00', week: 1 },
  w142:   { post: 'As a father',                 group: 'Happy Days In Hampton Bays',                   content: 'p8-asafather',      term: 'g-happydaysinhampton',   members: 4500,   at: '2026-11-13T18:00', week: 1 },
  w144:   { post: 'The socks photo',             group: 'Miller Place Parents & Communities',           content: 'p9-socks',          term: 'g-millerplaceparents',   members: 2700,   at: '2026-11-13T20:00', week: 1 },
  w103:   { post: 'Just finished - full roof',   group: 'Huntington Matters Community Forum',           content: 'p1-justfinished',   term: 'g-huntingtonmattersc',   members: 61700,  at: '2026-11-09T13:00', week: 1 },
  w107:   { post: 'Just finished - full roof',   group: 'Kings Park Community',                         content: 'p1-justfinished',   term: 'g-kingsparkcommunity',   members: 28700,  at: '2026-11-09T17:00', week: 1 },
  w109:   { post: 'Just finished - full roof',   group: 'Massapequa Moms',                              content: 'p1-justfinished',   term: 'g-massapequamoms',       members: 10700,  at: '2026-11-09T19:00', week: 1 },
  w112:   { post: 'Once the crew leaves',        group: 'Plainview Moms',                               content: 'p2-aftercare',      term: 'g-plainviewmoms',        members: 8400,   at: '2026-11-10T12:00', week: 1 },
  w116:   { post: 'Once the crew leaves',        group: 'Dix Hills Moms / South Huntington Moms',       content: 'p2-aftercare',      term: 'g-dixhillsmomssouthh',   members: 13600,  at: '2026-11-10T19:00', week: 1 },
  w118:   { post: 'Once the crew leaves',        group: 'Mastic, Shirley, Mastic beach our community page!', content: 'p2-aftercare',      term: 'g-masticshirleymasti',   members: 12200,  at: '2026-11-10T21:00', week: 1 },
  w120:   { post: 'The socks photo',             group: 'East Moriches Community Posts',                content: 'p9-socks',          term: 'g-eastmorichescommun',   members: 20800,  at: '2026-11-11T09:00', week: 1 },
  w121:   { post: 'The socks photo',             group: 'West Islip Community',                         content: 'p9-socks',          term: 'g-westislipcommunity',   members: 6400,   at: '2026-11-11T12:00', week: 1 },
  w123:   { post: 'The socks photo',             group: 'Neighbors of Quogue Westhampton Speonk Remsenburg Eastport Manorville', content: 'p9-socks',          term: 'g-neighborsofquoguew',   members: 14100,  at: '2026-11-11T16:00', week: 1 },
  w125:   { post: 'Ready for another LI winter', group: 'East Hampton Ny Community News',               content: 'p3-winterready',    term: 'g-easthamptonnycommu',   members: 17900,  at: '2026-11-11T19:00', week: 1 },
  w127:   { post: 'Ready for another LI winter', group: 'Copiague Friends and Neighbors',               content: 'p3-winterready',    term: 'g-copiaguefriendsand',   members: 7200,   at: '2026-11-11T21:00', week: 1 },
  w129:   { post: 'Most roofers say replace',    group: 'Port Jeff, Port Jefferson Station , & Terryville Neighborhood Page',                             content: 'p4-replacerepair',  term: 'g-portjeffportjeffer',       members: 6100,   at: '2026-11-12T09:00', week: 1 },
  w130:   { post: 'Most roofers say replace',    group: 'Long Island, NY Business Owners',              content: 'p4-replacerepair',  term: 'g-longislandnybusine',   members: 27500,  at: '2026-11-12T12:00', week: 1 },
  w132:   { post: 'Family / pumpkins',           group: 'Lindenhurst, my Home Town',    content: 'p5-family',         term: 'g-lindenhurstmyhomet',   members: 8300,  at: '2026-11-12T16:00', week: 1 },
  w134:   { post: 'Family / pumpkins',           group: 'I AM WYANDANCH',                   content: 'p5-family',         term: 'g-iamwyandanch',   members: 3400,   at: '2026-11-12T19:00', week: 1 },
  w136:   { post: 'First company photo',         group: 'Deer Park NY - News, Gossip and Chatter',      content: 'p6-crew',           term: 'g-deerparknynewsgoss',   members: 11200,  at: '2026-11-12T21:00', week: 1 },
  w138:   { post: 'First company photo',         group: 'Rocky Point & Local Surrounding Businesses/Organizations', content: 'p6-crew',           term: 'g-rockypointlocalsur',   members: 8500,   at: '2026-11-13T09:00', week: 1 },
  w139:   { post: 'Four generations in Suffolk', group: 'East Islip NY Uncensored',                                    content: 'p7-generations',    term: 'g-eastislipnyuncenso',            members: 4200,  at: '2026-11-13T12:00', week: 1 },
  w141:   { post: 'Four generations in Suffolk', group: 'Everything Babylon',           content: 'p7-generations',    term: 'g-everythingbabylon',   members: 6300,   at: '2026-11-13T16:00', week: 1 },
  w143:   { post: 'As a father',                 group: 'West Babylon NY Moms & Dads',                              content: 'p8-asafather',      term: 'g-westbabylonnymomsd',       members: 4200,   at: '2026-11-13T19:00', week: 1 },
  w145:   { post: 'As a father',                 group: 'Lindenhurst, NY - Events around town',         content: 'p8-asafather',      term: 'g-lindenhurstnyevent',   members: 7900,   at: '2026-11-13T21:00', week: 1 },
  w201:    { post: 'Just finished - full roof',           group: 'Shirley and the Mastics. Our Town, Our Community, Our Home!', content: 'p1-justfinished',             term: 'g-shirleyandthemasti',            members: 57000,   at: '2026-11-16T07:00', week: 2 },
  w202:    { post: 'Once the crew leaves',                group: 'Bellmore/Merrick Uncensored',                             content: 'p2-aftercare',                term: 'g-bellmoremerrickunc',            members: 21800,   at: '2026-11-16T09:00', week: 2 },
  w203:    { post: 'Ready for another LI winter',         group: 'Bohemia. Ronkonkoma,Sayville, Oakdale And Surrounding Suffolk Communities', content: 'p3-winterready',              term: 'g-bohemiaronkonkomas',            members: 24100,   at: '2026-11-16T12:00', week: 2 },
  w204:    { post: 'Most roofers say replace',            group: 'Centereach , NY Community Group, Post Your Ad Here, Post Your Business Here', content: 'p4-replacerepair',            term: 'g-centereachnycommun',            members: 21300,   at: '2026-11-16T15:00', week: 2 },
  w205:    { post: 'Family / pumpkins',                   group: 'Wantagh Mammas',                                          content: 'p5-family',                   term: 'g-wantaghmammas',                 members: 18700,   at: '2026-11-16T16:00', week: 2 },
  w206:    { post: 'First company photo',                 group: 'Commack Community Forum',                                 content: 'p6-crew',                     term: 'g-commackcommunityfo',            members: 6000,    at: '2026-11-16T18:00', week: 2 },
  w207:    { post: 'Four generations in Suffolk',         group: 'East Meadow Moms',                                        content: 'p7-generations',              term: 'g-eastmeadowmoms',                members: 5700,    at: '2026-11-16T19:00', week: 2 },
  w208:    { post: 'As a father',                         group: 'Wantagh Moms',                                            content: 'p8-asafather',                term: 'g-wantaghmoms',                   members: 4800,    at: '2026-11-16T20:00', week: 2 },
  w209:    { post: 'The socks photo',                     group: 'Melville City Chat',                                      content: 'p9-socks',                    term: 'g-melvillecitychat',              members: 27000,   at: '2026-11-16T21:00', week: 2 },
  w210:    { post: 'Just finished - full roof',           group: 'Lake Grove/Centereach Long Island NY',                    content: 'p1-justfinished',             term: 'g-lakegrovecentereac',            members: 14700,   at: '2026-11-17T07:00', week: 2 },
  w211:    { post: 'Once the crew leaves',                group: 'Baldwin NY 11510 and Freeport NY 11520',                  content: 'p2-aftercare',                term: 'g-baldwinny11510andf',            members: 17000,   at: '2026-11-17T09:00', week: 2 },
  w212:    { post: 'Ready for another LI winter',         group: 'What’s Happening East Meadow',                            content: 'p3-winterready',              term: 'g-whatshappeningeast',            members: 11500,   at: '2026-11-17T12:00', week: 2 },
  w213:    { post: 'Most roofers say replace',            group: 'Freeporters for Freeport',                                content: 'p4-replacerepair',            term: 'g-freeportersforfree',            members: 10900,   at: '2026-11-17T15:00', week: 2 },
  w214:    { post: 'Family / pumpkins',                   group: 'Patchogue: From the Past to the Present',                 content: 'p5-family',                   term: 'g-patchoguefromthepa',            members: 22000,   at: '2026-11-17T16:00', week: 2 },
  w215:    { post: 'First company photo',                 group: 'Lynbrook, NY Local Business Bulletin Board',              content: 'p6-crew',                     term: 'g-lynbrooknylocalbus',            members: 4600,    at: '2026-11-17T18:00', week: 2 },
  w216:    { post: 'Four generations in Suffolk',         group: 'Holtsville Neighbors Yard Sale',                          content: 'p7-generations',              term: 'g-holtsvilleneighbor',            members: 16900,   at: '2026-11-17T19:00', week: 2 },
  w217:    { post: 'As a father',                         group: 'Levittown moms group',                                    content: 'p8-asafather',                term: 'g-levittownmomsgroup',            members: 10000,   at: '2026-11-17T20:00', week: 2 },
  w218:    { post: 'The socks photo',                     group: 'All things Valley Stream',                                content: 'p9-socks',                    term: 'g-allthingsvalleystr',            members: 9600,    at: '2026-11-17T21:00', week: 2 },
  w219:    { post: 'Just finished - full roof',           group: 'Everything Eastport @  The Villages',                     content: 'p1-justfinished',             term: 'g-everythingeastport',            members: 34600,   at: '2026-11-18T07:00', week: 2 },
  w220:    { post: 'Once the crew leaves',                group: 'Huntington, New York',                                    content: 'p2-aftercare',                term: 'g-huntingtonnewyork',             members: 8600,    at: '2026-11-18T09:00', week: 2 },
  w221:    { post: 'Ready for another LI winter',         group: 'Franklin Square Moms',                                    content: 'p3-winterready',              term: 'g-franklinsquaremoms',            members: 8400,    at: '2026-11-18T12:00', week: 2 },
  w222:    { post: 'Most roofers say replace',            group: 'Bethpage Long Island\'s Official Page',                   content: 'p4-replacerepair',            term: 'g-bethpagelongisland',            members: 13300,   at: '2026-11-18T15:00', week: 2 },
  w223:    { post: 'Family / pumpkins',                   group: 'West islip mom’s uncensored',                             content: 'p5-family',                   term: 'g-westislipmomsuncen',            members: 3500,    at: '2026-11-18T16:00', week: 2 },
  w224:    { post: 'First company photo',                 group: 'North Lawrence Community',                                content: 'p6-crew',                     term: 'g-northlawrencecommu',            members: 5600,    at: '2026-11-18T18:00', week: 2 },
  w225:    { post: 'Four generations in Suffolk',         group: 'Oceanside NY  Business Network',                          content: 'p7-generations',              term: 'g-oceansidenybusines',            members: 3600,    at: '2026-11-18T19:00', week: 2 },
  w226:    { post: 'As a father',                         group: 'Baldwin Inside',                                          content: 'p8-asafather',                term: 'g-baldwininside',                 members: 14900,   at: '2026-11-18T20:00', week: 2 },
  w227:    { post: 'The socks photo',                     group: 'Lindenhurst Moms',                                        content: 'p9-socks',                    term: 'g-lindenhurstmoms',               members: 3100,    at: '2026-11-18T21:00', week: 2 },
  w228:    { post: 'Just finished - full roof',           group: 'LONG ISLAND MOMS',                                        content: 'p1-justfinished',             term: 'g-longislandmoms',                members: 85000,   at: '2026-11-19T07:00', week: 2 },
  w229:    { post: 'Once the crew leaves',                group: 'Town of Babylon group',                                   content: 'p2-aftercare',                term: 'g-townofbabylongroup',            members: 31100,   at: '2026-11-19T09:00', week: 2 },
  w230:    { post: 'Ready for another LI winter',         group: 'Franklin Square & Garden City South Business Community',  content: 'p3-winterready',              term: 'g-franklinsquaregard',            members: 8400,    at: '2026-11-19T12:00', week: 2 },
  w231:    { post: 'Most roofers say replace',            group: 'Massapequa/N Massapequa Mommy\'s Market',                 content: 'p4-replacerepair',            term: 'g-massapequanmassape',            members: 20700,   at: '2026-11-19T15:00', week: 2 },
  w232:    { post: 'Family / pumpkins',                   group: 'Mastics/shirley Moriches Community Group',                content: 'p5-family',                   term: 'g-masticsshirleymori',            members: 5500,    at: '2026-11-19T16:00', week: 2 },
  w233:    { post: 'First company photo',                 group: 'Westbury Moms And Dads',                                  content: 'p6-crew',                     term: 'g-westburymomsanddad',            members: 7700,    at: '2026-11-19T18:00', week: 2 },
  w234:    { post: 'Four generations in Suffolk',         group: 'Holbrook Moms NY',                                        content: 'p7-generations',              term: 'g-holbrookmomsny',                members: 1500,    at: '2026-11-19T19:00', week: 2 },
  w235:    { post: 'As a father',                         group: 'Mastic, Shirley, Mastic beach our community',             content: 'p8-asafather',                term: 'g-masticshirleym2',               members: 0,       at: '2026-11-19T20:00', week: 2 },
  w236:    { post: 'The socks photo',                     group: 'SAINT JAMES / SMITHTOWN INFORMATIVE GROUP',               content: 'p9-socks',                    term: 'g-saintjamessmithtow',            members: 13000,   at: '2026-11-19T21:00', week: 2 },
  w237:    { post: 'Just finished - full roof',           group: 'Sayville Moms and Dads',                                  content: 'p1-justfinished',             term: 'g-sayvillemomsanddad',            members: 3900,    at: '2026-11-20T07:00', week: 2 },
  w238:    { post: 'Once the crew leaves',                group: 'Bellport Village Residents',                              content: 'p2-aftercare',                term: 'g-bellportvillageres',            members: 9600,    at: '2026-11-20T09:00', week: 2 },
  w239:    { post: 'Ready for another LI winter',         group: 'Montauk Village',                                         content: 'p3-winterready',              term: 'g-montaukvillage',                members: 6600,    at: '2026-11-20T12:00', week: 2 },
  w240:    { post: 'Most roofers say replace',            group: 'Deer Park NY Community Page',                             content: 'p4-replacerepair',            term: 'g-deerparknycommunit',            members: 13800,   at: '2026-11-20T15:00', week: 2 },
  w241:    { post: 'Family / pumpkins',                   group: 'Smithtown Moms and Dads Uncensored',                      content: 'p5-family',                   term: 'g-smithtownmomsandda',            members: 12800,   at: '2026-11-20T16:00', week: 2 },
  w242:    { post: 'First company photo',                 group: 'Brentwood',                                               content: 'p6-crew',                     term: 'g-brentwood',                     members: 12500,   at: '2026-11-20T18:00', week: 2 },
  w243:    { post: 'Four generations in Suffolk',         group: 'Huntington Small Businesses Matter',                      content: 'p7-generations',              term: 'g-huntingtonsmallbus',            members: 4900,    at: '2026-11-20T19:00', week: 2 },
  w244:    { post: 'As a father',                         group: 'Port Jefferson, Setauket, Stony Brook & Mount Sinai Recommendations', content: 'p8-asafather',                term: 'g-portjeffersonsetau',            members: 6100,    at: '2026-11-20T20:00', week: 2 },
  w245:    { post: 'The socks photo',                     group: 'THE ORIGINAL Islip This & That',                          content: 'p9-socks',                    term: 'g-theoriginalislipth',            members: 11000,   at: '2026-11-20T21:00', week: 2 },
  w301:    { post: 'Thanksgiving table',                  group: 'Huntington Matters Community Forum',                      content: 'p10-thanksgiving',            term: 'g-huntingtonmatt2',               members: 61700,   at: '2026-11-23T07:00', week: 3 },
  w302:    { post: 'Thanksgiving table',                  group: 'Kings Park Community',                                    content: 'p10-thanksgiving',            term: 'g-kingsparkcommu2',               members: 28700,   at: '2026-11-23T09:00', week: 3 },
  w303:    { post: 'Thanksgiving table',                  group: 'WHAT\'S UP MONTAUK',                                      content: 'p10-thanksgiving',            term: 'g-whatsupmontauk',                members: 22600,   at: '2026-11-23T16:00', week: 3 },
  w304:    { post: 'Just finished - full roof',           group: 'The Deer Park We all remember',                           content: 'p1-justfinished',             term: 'g-thedeerparkweallre',            members: 12800,   at: '2026-11-23T18:00', week: 3 },
  w305:    { post: 'Once the crew leaves',                group: 'Massapequa Moms',                                         content: 'p2-aftercare',                term: 'g-massapequamoms2',               members: 10700,   at: '2026-11-23T20:00', week: 3 },
  w306:    { post: 'Ready for another LI winter',         group: 'Shirley/Mastic/Mastic Beach/Manorville/Moriches Community Group', content: 'p3-winterready',              term: 'g-shirleymasticmasti',            members: 14300,   at: '2026-11-23T21:00', week: 3 },
  w307:    { post: 'Most roofers say replace',            group: 'Plainview Moms',                                          content: 'p4-replacerepair',            term: 'g-plainviewmoms2',                members: 8400,    at: '2026-11-24T07:00', week: 3 },
  w308:    { post: 'Family / pumpkins',                   group: 'Dix Hills Moms / South Huntington Moms',                  content: 'p5-family',                   term: 'g-dixhillsmomsso2',               members: 13600,   at: '2026-11-24T09:00', week: 3 },
  w309:    { post: 'First company photo',                 group: 'Mastic, Shirley, Mastic beach our community page!',       content: 'p6-crew',                     term: 'g-masticshirleym3',               members: 12200,   at: '2026-11-24T16:00', week: 3 },
  w310:    { post: 'Four generations in Suffolk',         group: 'Shirley/Mastics Community Group',                         content: 'p7-generations',              term: 'g-shirleymastics2',               members: 19800,   at: '2026-11-24T18:00', week: 3 },
  w311:    { post: 'As a father',                         group: 'MT. SINAI/MILLER PLACE COMMUNITY BUSINESS',               content: 'p8-asafather',                term: 'g-mtsinaimillerp2',               members: 9300,    at: '2026-11-24T20:00', week: 3 },
  w312:    { post: 'The socks photo',                     group: 'Islip That & This',                                       content: 'p9-socks',                    term: 'g-islipthatthis2',                members: 6000,    at: '2026-11-24T21:00', week: 3 },
  w313:    { post: 'Thanksgiving table',                  group: 'East Patchogue Community',                                content: 'p10-thanksgiving',            term: 'g-eastpatchoguec2',               members: 28900,   at: '2026-11-25T07:00', week: 3 },
  w314:    { post: 'Thanksgiving table',                  group: 'East Moriches Community Posts',                           content: 'p10-thanksgiving',            term: 'g-eastmorichesco2',               members: 20800,   at: '2026-11-25T18:00', week: 3 },
  w315:    { post: 'Thanksgiving table',                  group: 'West Islip Community',                                    content: 'p10-thanksgiving',            term: 'g-westislipcommu2',               members: 6400,    at: '2026-11-25T20:00', week: 3 },
  w316:    { post: 'Just finished - full roof',           group: 'East Hampton Ny Community News',                          content: 'p1-justfinished',             term: 'g-easthamptonnyc2',               members: 17900,   at: '2026-11-25T21:00', week: 3 },
  w401:    { post: 'Just finished - full roof',           group: 'Bellmore/Merrick Uncensored',                             content: 'p1-justfinished',             term: 'g-bellmoremerric2',               members: 21800,   at: '2026-11-30T07:00', week: 4 },
  w402:    { post: 'Once the crew leaves',                group: 'Shirley and the Mastics. Our Town, Our Community, Our Home!', content: 'p2-aftercare',                term: 'g-shirleyandthem2',               members: 57000,   at: '2026-11-30T09:00', week: 4 },
  w403:    { post: 'Ready for another LI winter',         group: 'Centereach , NY Community Group, Post Your Ad Here, Post Your Business Here', content: 'p3-winterready',              term: 'g-centereachnyco2',               members: 21300,   at: '2026-11-30T12:00', week: 4 },
  w404:    { post: 'Most roofers say replace',            group: 'Bohemia. Ronkonkoma,Sayville, Oakdale And Surrounding Suffolk Communities', content: 'p4-replacerepair',            term: 'g-bohemiaronkonk2',               members: 24100,   at: '2026-11-30T15:00', week: 4 },
  w405:    { post: 'Family / pumpkins',                   group: 'Commack Community Forum',                                 content: 'p5-family',                   term: 'g-commackcommuni2',               members: 6000,    at: '2026-11-30T16:00', week: 4 },
  w406:    { post: 'First company photo',                 group: 'Wantagh Mammas',                                          content: 'p6-crew',                     term: 'g-wantaghmammas2',                members: 18700,   at: '2026-11-30T18:00', week: 4 },
  w407:    { post: 'Four generations in Suffolk',         group: 'Wantagh Moms',                                            content: 'p7-generations',              term: 'g-wantaghmoms2',                  members: 4800,    at: '2026-11-30T19:00', week: 4 },
  w408:    { post: 'As a father',                         group: 'East Meadow Moms',                                        content: 'p8-asafather',                term: 'g-eastmeadowmoms2',               members: 5700,    at: '2026-11-30T20:00', week: 4 },
  w409:    { post: 'The socks photo',                     group: 'Copiague Friends and Neighbors',                          content: 'p9-socks',                    term: 'g-copiaguefriend2',               members: 7200,    at: '2026-11-30T21:00', week: 4 },
  w410:    { post: 'Just finished - full roof',           group: 'Melville City Chat',                                      content: 'p1-justfinished',             term: 'g-melvillecitych2',               members: 27000,   at: '2026-12-01T07:00', week: 4 },
  w411:    { post: 'Once the crew leaves',                group: 'Lake Grove/Centereach Long Island NY',                    content: 'p2-aftercare',                term: 'g-lakegrovecente2',               members: 14700,   at: '2026-12-01T09:00', week: 4 },
  w412:    { post: 'Ready for another LI winter',         group: 'Baldwin NY 11510 and Freeport NY 11520',                  content: 'p3-winterready',              term: 'g-baldwinny115102',               members: 17000,   at: '2026-12-01T12:00', week: 4 },
  w413:    { post: 'Most roofers say replace',            group: 'What’s Happening East Meadow',                            content: 'p4-replacerepair',            term: 'g-whatshappening2',               members: 11500,   at: '2026-12-01T15:00', week: 4 },
  w414:    { post: 'Family / pumpkins',                   group: 'Freeporters for Freeport',                                content: 'p5-family',                   term: 'g-freeportersfor2',               members: 10900,   at: '2026-12-01T16:00', week: 4 },
  w415:    { post: 'First company photo',                 group: 'Patchogue: From the Past to the Present',                 content: 'p6-crew',                     term: 'g-patchoguefromt2',               members: 22000,   at: '2026-12-01T18:00', week: 4 },
  w416:    { post: 'Four generations in Suffolk',         group: 'Lynbrook, NY Local Business Bulletin Board',              content: 'p7-generations',              term: 'g-lynbrooknyloca2',               members: 4600,    at: '2026-12-01T19:00', week: 4 },
  w417:    { post: 'As a father',                         group: 'Holtsville Neighbors Yard Sale',                          content: 'p8-asafather',                term: 'g-holtsvilleneig2',               members: 16900,   at: '2026-12-01T20:00', week: 4 },
  w418:    { post: 'The socks photo',                     group: 'Levittown moms group',                                    content: 'p9-socks',                    term: 'g-levittownmomsg2',               members: 10000,   at: '2026-12-01T21:00', week: 4 },
  w419:    { post: 'Just finished - full roof',           group: 'All things Valley Stream',                                content: 'p1-justfinished',             term: 'g-allthingsvalle2',               members: 9600,    at: '2026-12-02T07:00', week: 4 },
  w420:    { post: 'Once the crew leaves',                group: 'Everything Eastport @  The Villages',                     content: 'p2-aftercare',                term: 'g-everythingeast2',               members: 34600,   at: '2026-12-02T09:00', week: 4 },
  w421:    { post: 'Ready for another LI winter',         group: 'Huntington, New York',                                    content: 'p3-winterready',              term: 'g-huntingtonnewy2',               members: 8600,    at: '2026-12-02T12:00', week: 4 },
  w422:    { post: 'Most roofers say replace',            group: 'Franklin Square Moms',                                    content: 'p4-replacerepair',            term: 'g-franklinsquare2',               members: 8400,    at: '2026-12-02T15:00', week: 4 },
  w423:    { post: 'Family / pumpkins',                   group: 'Bethpage Long Island\'s Official Page',                   content: 'p5-family',                   term: 'g-bethpagelongis2',               members: 13300,   at: '2026-12-02T16:00', week: 4 },
  w424:    { post: 'First company photo',                 group: 'West islip mom’s uncensored',                             content: 'p6-crew',                     term: 'g-westislipmomsu2',               members: 3500,    at: '2026-12-02T18:00', week: 4 },
  w425:    { post: 'Four generations in Suffolk',         group: 'North Lawrence Community',                                content: 'p7-generations',              term: 'g-northlawrencec2',               members: 5600,    at: '2026-12-02T19:00', week: 4 },
  w426:    { post: 'As a father',                         group: 'Oceanside NY  Business Network',                          content: 'p8-asafather',                term: 'g-oceansidenybus2',               members: 3600,    at: '2026-12-02T20:00', week: 4 },
  w427:    { post: 'The socks photo',                     group: 'Baldwin Inside',                                          content: 'p9-socks',                    term: 'g-baldwininside2',                members: 14900,   at: '2026-12-02T21:00', week: 4 },
  w428:    { post: 'Just finished - full roof',           group: 'Lindenhurst Moms',                                        content: 'p1-justfinished',             term: 'g-lindenhurstmom2',               members: 3100,    at: '2026-12-03T07:00', week: 4 },
  w429:    { post: 'Once the crew leaves',                group: 'SHIRLEY - MASTIC’S - MORICHES - SMITH POINT',             content: 'p2-aftercare',                term: 'g-shirleymastics3',               members: 7300,    at: '2026-12-03T09:00', week: 4 },
  w430:    { post: 'Ready for another LI winter',         group: 'Town of Babylon group',                                   content: 'p3-winterready',              term: 'g-townofbabylong2',               members: 31100,   at: '2026-12-03T12:00', week: 4 },
  w431:    { post: 'Most roofers say replace',            group: 'LONG ISLAND MOMS',                                        content: 'p4-replacerepair',            term: 'g-longislandmoms2',               members: 85000,   at: '2026-12-03T15:00', week: 4 },
  w432:    { post: 'Family / pumpkins',                   group: 'Franklin Square & Garden City South Business Community',  content: 'p5-family',                   term: 'g-franklinsquare3',               members: 8400,    at: '2026-12-03T16:00', week: 4 },
  w433:    { post: 'First company photo',                 group: 'Massapequa/N Massapequa Mommy\'s Market',                 content: 'p6-crew',                     term: 'g-massapequanmas2',               members: 20700,   at: '2026-12-03T18:00', week: 4 },
  w434:    { post: 'Four generations in Suffolk',         group: 'Mastics/shirley Moriches Community Group',                content: 'p7-generations',              term: 'g-masticsshirley2',               members: 5500,    at: '2026-12-03T19:00', week: 4 },
  w435:    { post: 'As a father',                         group: 'Westbury Moms And Dads',                                  content: 'p8-asafather',                term: 'g-westburymomsan2',               members: 7700,    at: '2026-12-03T20:00', week: 4 },
  w436:    { post: 'The socks photo',                     group: 'Holbrook Moms NY',                                        content: 'p9-socks',                    term: 'g-holbrookmomsny2',               members: 1500,    at: '2026-12-03T21:00', week: 4 },
  w437:    { post: 'Just finished - full roof',           group: 'Mastic, Shirley, Mastic beach our community',             content: 'p1-justfinished',             term: 'g-masticshirleym4',               members: 0,       at: '2026-12-04T07:00', week: 4 },
  w438:    { post: 'Once the crew leaves',                group: 'Long Island, NY Business Owners',                         content: 'p2-aftercare',                term: 'g-longislandnybu2',               members: 27500,   at: '2026-12-04T09:00', week: 4 },
  w439:    { post: 'Ready for another LI winter',         group: 'SAINT JAMES / SMITHTOWN INFORMATIVE GROUP',               content: 'p3-winterready',              term: 'g-saintjamessmit2',               members: 13000,   at: '2026-12-04T12:00', week: 4 },
  w440:    { post: 'Most roofers say replace',            group: 'Sayville Moms and Dads',                                  content: 'p4-replacerepair',            term: 'g-sayvillemomsan2',               members: 3900,    at: '2026-12-04T15:00', week: 4 },
  w441:    { post: 'Family / pumpkins',                   group: 'Bellport Village Residents',                              content: 'p5-family',                   term: 'g-bellportvillag2',               members: 9600,    at: '2026-12-04T16:00', week: 4 },
  w442:    { post: 'First company photo',                 group: 'Montauk Village',                                         content: 'p6-crew',                     term: 'g-montaukvillage2',               members: 6600,    at: '2026-12-04T18:00', week: 4 },
  w443:    { post: 'Four generations in Suffolk',         group: 'Deer Park NY - News, Gossip and Chatter',                 content: 'p7-generations',              term: 'g-deerparknynews2',               members: 11200,   at: '2026-12-04T19:00', week: 4 },
  w444:    { post: 'As a father',                         group: 'Deer Park NY Community Page',                             content: 'p8-asafather',                term: 'g-deerparknycomm2',               members: 13800,   at: '2026-12-04T20:00', week: 4 },
  w445:    { post: 'The socks photo',                     group: 'Patchogue Community NY',                                  content: 'p9-socks',                    term: 'g-patchoguecommu2',               members: 14000,   at: '2026-12-04T21:00', week: 4 },
  w501:    { post: 'Just finished - full roof',           group: 'WHAT\'S UP MONTAUK',                                      content: 'p1-justfinished',             term: 'g-whatsupmontauk2',               members: 22600,   at: '2026-12-07T07:00', week: 5 },
  w502:    { post: 'Once the crew leaves',                group: 'Huntington Matters Community Forum',                      content: 'p2-aftercare',                term: 'g-huntingtonmatt3',               members: 61700,   at: '2026-12-07T09:00', week: 5 },
  w503:    { post: 'Ready for another LI winter',         group: 'Kings Park Community',                                    content: 'p3-winterready',              term: 'g-kingsparkcommu3',               members: 28700,   at: '2026-12-07T12:00', week: 5 },
  w504:    { post: 'Most roofers say replace',            group: 'Massapequa Moms',                                         content: 'p4-replacerepair',            term: 'g-massapequamoms3',               members: 10700,   at: '2026-12-07T15:00', week: 5 },
  w505:    { post: 'Family / pumpkins',                   group: 'The Deer Park We all remember',                           content: 'p5-family',                   term: 'g-thedeerparkwea2',               members: 12800,   at: '2026-12-07T16:00', week: 5 },
  w506:    { post: 'First company photo',                 group: 'Islip Terrace And All Of The Islips',                     content: 'p6-crew',                     term: 'g-islipterracean2',               members: 13300,   at: '2026-12-07T18:00', week: 5 },
  w507:    { post: 'Four generations in Suffolk',         group: 'Rocky Point & Local Surrounding Businesses/Organizations', content: 'p7-generations',              term: 'g-rockypointloca2',               members: 8500,    at: '2026-12-07T19:00', week: 5 },
  w508:    { post: 'As a father',                         group: 'Smithtown Moms and Dads Uncensored',                      content: 'p8-asafather',                term: 'g-smithtownmomsa2',               members: 12800,   at: '2026-12-07T20:00', week: 5 },
  w509:    { post: 'The socks photo',                     group: 'Babylon Village Connection',                              content: 'p9-socks',                    term: 'g-babylonvillage2',               members: 8200,    at: '2026-12-07T21:00', week: 5 },
  w510:    { post: 'Just finished - full roof',           group: 'Plainview Moms',                                          content: 'p1-justfinished',             term: 'g-plainviewmoms3',                members: 8400,    at: '2026-12-08T07:00', week: 5 },
  w511:    { post: 'Once the crew leaves',                group: 'Shirley/Mastics Community Group',                         content: 'p2-aftercare',                term: 'g-shirleymastics4',               members: 19800,   at: '2026-12-08T09:00', week: 5 },
  w512:    { post: 'Ready for another LI winter',         group: 'Dix Hills Moms / South Huntington Moms',                  content: 'p3-winterready',              term: 'g-dixhillsmomsso3',               members: 13600,   at: '2026-12-08T12:00', week: 5 },
  w513:    { post: 'Most roofers say replace',            group: 'Mastic, Shirley, Mastic beach our community page!',       content: 'p4-replacerepair',            term: 'g-masticshirleym5',               members: 12200,   at: '2026-12-08T15:00', week: 5 },
  w514:    { post: 'Family / pumpkins',                   group: 'MT. SINAI/MILLER PLACE COMMUNITY BUSINESS',               content: 'p5-family',                   term: 'g-mtsinaimillerp3',               members: 9300,    at: '2026-12-08T16:00', week: 5 },
  w515:    { post: 'First company photo',                 group: 'Huntington Small Businesses Matter',                      content: 'p6-crew',                     term: 'g-huntingtonsmal2',               members: 4900,    at: '2026-12-08T18:00', week: 5 },
  w516:    { post: 'Four generations in Suffolk',         group: 'Brentwood',                                               content: 'p7-generations',              term: 'g-brentwood2',                    members: 12500,   at: '2026-12-08T19:00', week: 5 },
  w517:    { post: 'As a father',                         group: 'Islip That & This',                                       content: 'p8-asafather',                term: 'g-islipthatthis3',                members: 6000,    at: '2026-12-08T20:00', week: 5 },
  w518:    { post: 'The socks photo',                     group: 'Lindenhurst, NY - Events around town',                    content: 'p9-socks',                    term: 'g-lindenhurstnye2',               members: 7900,    at: '2026-12-08T21:00', week: 5 },
  w519:    { post: 'Just finished - full roof',           group: 'East Patchogue Community',                                content: 'p1-justfinished',             term: 'g-eastpatchoguec3',               members: 28900,   at: '2026-12-09T07:00', week: 5 },
  w520:    { post: 'Once the crew leaves',                group: 'East Moriches Community Posts',                           content: 'p2-aftercare',                term: 'g-eastmorichesco3',               members: 20800,   at: '2026-12-09T09:00', week: 5 },
  w521:    { post: 'Ready for another LI winter',         group: 'West Islip Community',                                    content: 'p3-winterready',              term: 'g-westislipcommu3',               members: 6400,    at: '2026-12-09T12:00', week: 5 },
  w522:    { post: 'Most roofers say replace',            group: 'East Hampton Ny Community News',                          content: 'p4-replacerepair',            term: 'g-easthamptonnyc3',               members: 17900,   at: '2026-12-09T15:00', week: 5 },
  w523:    { post: 'Family / pumpkins',                   group: 'Neighbors of Quogue Westhampton Speonk Remsenburg Eastport Manorville', content: 'p5-family',                   term: 'g-neighborsofquo2',               members: 14100,   at: '2026-12-09T16:00', week: 5 },
  w524:    { post: 'First company photo',                 group: 'Port Jeff, Port Jefferson Station , & Terryville Neighborhood Page', content: 'p6-crew',                     term: 'g-portjeffportje2',               members: 6100,    at: '2026-12-09T18:00', week: 5 },
  w525:    { post: 'Four generations in Suffolk',         group: 'Port Jefferson, Setauket, Stony Brook & Mount Sinai Recommendations', content: 'p7-generations',              term: 'g-portjeffersons2',               members: 6100,    at: '2026-12-09T19:00', week: 5 },
  w526:    { post: 'As a father',                         group: 'THE ORIGINAL Islip This & That',                          content: 'p8-asafather',                term: 'g-theoriginalisl2',               members: 11000,   at: '2026-12-09T20:00', week: 5 },
  w527:    { post: 'The socks photo',                     group: 'Lindenhurst, my Home Town',                               content: 'p9-socks',                    term: 'g-lindenhurstmyh2',               members: 8300,    at: '2026-12-09T21:00', week: 5 },
  w528:    { post: 'Just finished - full roof',           group: 'Shirley/Mastic/Mastic Beach/Manorville/Moriches Community Group', content: 'p1-justfinished',             term: 'g-shirleymasticm2',               members: 14300,   at: '2026-12-10T07:00', week: 5 },
  w529:    { post: 'Once the crew leaves',                group: 'Babylon Village Community... A Page for the People of the Village', content: 'p2-aftercare',                term: 'g-babylonvillagecomm',            members: 0,       at: '2026-12-10T09:00', week: 5 },
  w530:    { post: 'Ready for another LI winter',         group: 'Babylon Village Strong 🧡',                                content: 'p3-winterready',              term: 'g-babylonvillagestro',            members: 0,       at: '2026-12-10T12:00', week: 5 },
  w531:    { post: 'Most roofers say replace',            group: 'Brentwood Moms & Dads Group (NY)',                        content: 'p4-replacerepair',            term: 'g-brentwoodmomsdadsg',            members: 0,       at: '2026-12-10T15:00', week: 5 },
  w532:    { post: 'Family / pumpkins',                   group: 'Deer Park Talk',                                          content: 'p5-family',                   term: 'g-deerparktalk',                  members: 0,       at: '2026-12-10T16:00', week: 5 },
  w533:    { post: 'First company photo',                 group: 'East Islip, NY 11730',                                    content: 'p6-crew',                     term: 'g-eastislipny11730',              members: 0,       at: '2026-12-10T18:00', week: 5 },
  w534:    { post: 'Four generations in Suffolk',         group: 'Huntington Curb Alert',                                   content: 'p7-generations',              term: 'g-huntingtoncurbaler',            members: 0,       at: '2026-12-10T19:00', week: 5 },
  w535:    { post: 'As a father',                         group: 'Huntington High School Class of 1995',                    content: 'p8-asafather',                term: 'g-huntingtonhighscho',            members: 0,       at: '2026-12-10T20:00', week: 5 },
  w536:    { post: 'The socks photo',                     group: 'Huntington Nightlife, Long Island NY',                    content: 'p9-socks',                    term: 'g-huntingtonnightlif',            members: 0,       at: '2026-12-10T21:00', week: 5 },
  w537:    { post: 'Just finished - full roof',           group: 'Parents of Huntington NY',                                content: 'p1-justfinished',             term: 'g-parentsofhunti2',               members: 0,       at: '2026-12-11T07:00', week: 5 },
  w538:    { post: 'Once the crew leaves',                group: 'Patchogue Village Neighbors',                             content: 'p2-aftercare',                term: 'g-patchoguevillagene',            members: 0,       at: '2026-12-11T09:00', week: 5 },
  w539:    { post: 'Ready for another LI winter',         group: 'Sayville Community NY',                                   content: 'p3-winterready',              term: 'g-sayvillecommunityn',            members: 15100,   at: '2026-12-11T12:00', week: 5 },
  w540:    { post: 'Most roofers say replace',            group: 'Smithtown Community Alerts',                              content: 'p4-replacerepair',            term: 'g-smithtowncommunity',            members: 0,       at: '2026-12-11T15:00', week: 5 },
  w541:    { post: 'Family / pumpkins',                   group: 'The Huntington High School Rock',                         content: 'p5-family',                   term: 'g-thehuntingtonhighs',            members: 0,       at: '2026-12-11T16:00', week: 5 },
  w542:    { post: 'First company photo',                 group: 'Town of Babylon Shopping Local',                          content: 'p6-crew',                     term: 'g-townofbabylonshopp',            members: 0,       at: '2026-12-11T18:00', week: 5 },
  w543:    { post: 'Four generations in Suffolk',         group: 'WEST BABYLON 11704',                                      content: 'p7-generations',              term: 'g-westbabylon11704',              members: 0,       at: '2026-12-11T19:00', week: 5 },
  w544:    { post: 'As a father',                         group: 'West Babylon Community Group and Surrounding LI Towns',   content: 'p8-asafather',                term: 'g-westbabyloncommuni',            members: 0,       at: '2026-12-11T20:00', week: 5 },
  w545:    { post: 'The socks photo',                     group: 'West Babylon Mom\'s',                                     content: 'p9-socks',                    term: 'g-westbabylonmoms',               members: 577,     at: '2026-12-11T21:00', week: 5 },
  w601:    { post: 'Just finished - full roof',           group: 'Bohemia. Ronkonkoma,Sayville, Oakdale And Surrounding Suffolk Communities', content: 'p1-justfinished',             term: 'g-bohemiaronkonk3',               members: 24100,   at: '2026-12-14T07:00', week: 6 },
  w602:    { post: 'Once the crew leaves',                group: 'Centereach , NY Community Group, Post Your Ad Here, Post Your Business Here', content: 'p2-aftercare',                term: 'g-centereachnyco3',               members: 21300,   at: '2026-12-14T09:00', week: 6 },
  w603:    { post: 'Ready for another LI winter',         group: 'Shirley and the Mastics. Our Town, Our Community, Our Home!', content: 'p3-winterready',              term: 'g-shirleyandthem3',               members: 57000,   at: '2026-12-14T12:00', week: 6 },
  w604:    { post: 'Most roofers say replace',            group: 'Bellmore/Merrick Uncensored',                             content: 'p4-replacerepair',            term: 'g-bellmoremerric3',               members: 21800,   at: '2026-12-14T15:00', week: 6 },
  w605:    { post: 'Family / pumpkins',                   group: 'East Meadow Moms',                                        content: 'p5-family',                   term: 'g-eastmeadowmoms3',               members: 5700,    at: '2026-12-14T16:00', week: 6 },
  w606:    { post: 'First company photo',                 group: 'Wantagh Moms',                                            content: 'p6-crew',                     term: 'g-wantaghmoms3',                  members: 4800,    at: '2026-12-14T18:00', week: 6 },
  w607:    { post: 'Four generations in Suffolk',         group: 'Wantagh Mammas',                                          content: 'p7-generations',              term: 'g-wantaghmammas3',                members: 18700,   at: '2026-12-14T19:00', week: 6 },
  w608:    { post: 'As a father',                         group: 'Commack Community Forum',                                 content: 'p8-asafather',                term: 'g-commackcommuni3',               members: 6000,    at: '2026-12-14T20:00', week: 6 },
  w609:    { post: 'The socks photo',                     group: 'Mount Sinai-miller place community no rules',             content: 'p9-socks',                    term: 'g-mountsinaimillerpl',            members: 5200,    at: '2026-12-14T21:00', week: 6 },
  w610:    { post: 'Just finished - full roof',           group: 'Baldwin NY 11510 and Freeport NY 11520',                  content: 'p1-justfinished',             term: 'g-baldwinny115103',               members: 17000,   at: '2026-12-15T07:00', week: 6 },
  w611:    { post: 'Once the crew leaves',                group: 'Melville City Chat',                                      content: 'p2-aftercare',                term: 'g-melvillecitych3',               members: 27000,   at: '2026-12-15T09:00', week: 6 },
  w612:    { post: 'Ready for another LI winter',         group: 'Lake Grove/Centereach Long Island NY',                    content: 'p3-winterready',              term: 'g-lakegrovecente3',               members: 14700,   at: '2026-12-15T12:00', week: 6 },
  w613:    { post: 'Most roofers say replace',            group: 'Patchogue: From the Past to the Present',                 content: 'p4-replacerepair',            term: 'g-patchoguefromt3',               members: 22000,   at: '2026-12-15T15:00', week: 6 },
  w614:    { post: 'Family / pumpkins',                   group: 'What’s Happening East Meadow',                            content: 'p5-family',                   term: 'g-whatshappening3',               members: 11500,   at: '2026-12-15T16:00', week: 6 },
  w615:    { post: 'First company photo',                 group: 'Freeporters for Freeport',                                content: 'p6-crew',                     term: 'g-freeportersfor3',               members: 10900,   at: '2026-12-15T18:00', week: 6 },
  w616:    { post: 'Four generations in Suffolk',         group: 'Levittown moms group',                                    content: 'p7-generations',              term: 'g-levittownmomsg3',               members: 10000,   at: '2026-12-15T19:00', week: 6 },
  w617:    { post: 'As a father',                         group: 'Lynbrook, NY Local Business Bulletin Board',              content: 'p8-asafather',                term: 'g-lynbrooknyloca3',               members: 4600,    at: '2026-12-15T20:00', week: 6 },
  w618:    { post: 'The socks photo',                     group: 'Holtsville Neighbors Yard Sale',                          content: 'p9-socks',                    term: 'g-holtsvilleneig3',               members: 16900,   at: '2026-12-15T21:00', week: 6 },
  w619:    { post: 'Just finished - full roof',           group: 'Huntington, New York',                                    content: 'p1-justfinished',             term: 'g-huntingtonnewy3',               members: 8600,    at: '2026-12-16T07:00', week: 6 },
  w620:    { post: 'Once the crew leaves',                group: 'All things Valley Stream',                                content: 'p2-aftercare',                term: 'g-allthingsvalle3',               members: 9600,    at: '2026-12-16T09:00', week: 6 },
  w621:    { post: 'Ready for another LI winter',         group: 'Everything Eastport @  The Villages',                     content: 'p3-winterready',              term: 'g-everythingeast3',               members: 34600,   at: '2026-12-16T12:00', week: 6 },
  w622:    { post: 'Most roofers say replace',            group: 'West islip mom’s uncensored',                             content: 'p4-replacerepair',            term: 'g-westislipmomsu3',               members: 3500,    at: '2026-12-16T16:00', week: 6 },
  w623:    { post: 'Family / pumpkins',                   group: 'Franklin Square Moms',                                    content: 'p5-family',                   term: 'g-franklinsquare4',               members: 8400,    at: '2026-12-16T18:00', week: 6 },
  w624:    { post: 'First company photo',                 group: 'Bethpage Long Island\'s Official Page',                   content: 'p6-crew',                     term: 'g-bethpagelongis3',               members: 13300,   at: '2026-12-16T19:00', week: 6 },
  w625:    { post: 'Four generations in Suffolk',         group: 'Baldwin Inside',                                          content: 'p7-generations',              term: 'g-baldwininside3',                members: 14900,   at: '2026-12-16T20:00', week: 6 },
  w626:    { post: 'As a father',                         group: 'North Lawrence Community',                                content: 'p8-asafather',                term: 'g-northlawrencec3',               members: 5600,    at: '2026-12-16T21:00', week: 6 },
  w627:    { post: 'The socks photo',                     group: 'Town of Babylon group',                                   content: 'p9-socks',                    term: 'g-townofbabylong3',               members: 31100,   at: '2026-12-17T07:00', week: 6 },
  w628:    { post: 'Just finished - full roof',           group: 'Oceanside NY  Business Network',                          content: 'p1-justfinished',             term: 'g-oceansidenybus3',               members: 3600,    at: '2026-12-17T09:00', week: 6 },
  w629:    { post: 'Once the crew leaves',                group: 'Lindenhurst Moms',                                        content: 'p2-aftercare',                term: 'g-lindenhurstmom3',               members: 3100,    at: '2026-12-17T12:00', week: 6 },
  w630:    { post: 'Ready for another LI winter',         group: 'SHIRLEY - MASTIC’S - MORICHES - SMITH POINT',             content: 'p3-winterready',              term: 'g-shirleymastics5',               members: 7300,    at: '2026-12-17T16:00', week: 6 },
  w631:    { post: 'Most roofers say replace',            group: 'Copiague Friends and Neighbors',                          content: 'p4-replacerepair',            term: 'g-copiaguefriend3',               members: 7200,    at: '2026-12-17T18:00', week: 6 },
  w632:    { post: 'Family / pumpkins',                   group: 'LONG ISLAND MOMS',                                        content: 'p5-family',                   term: 'g-longislandmoms3',               members: 85000,   at: '2026-12-17T19:00', week: 6 },
  w633:    { post: 'First company photo',                 group: 'Franklin Square & Garden City South Business Community',  content: 'p6-crew',                     term: 'g-franklinsquare5',               members: 8400,    at: '2026-12-17T20:00', week: 6 },
  w634:    { post: 'Four generations in Suffolk',         group: 'Massapequa/N Massapequa Mommy\'s Market',                 content: 'p7-generations',              term: 'g-massapequanmas3',               members: 20700,   at: '2026-12-17T21:00', week: 6 },
  w635:    { post: 'As a father',                         group: 'Mastics/shirley Moriches Community Group',                content: 'p8-asafather',                term: 'g-masticsshirley3',               members: 5500,    at: '2026-12-18T07:00', week: 6 },
  w636:    { post: 'The socks photo',                     group: 'Westbury Moms And Dads',                                  content: 'p9-socks',                    term: 'g-westburymomsan3',               members: 7700,    at: '2026-12-18T09:00', week: 6 },
  w637:    { post: 'Just finished - full roof',           group: 'Holbrook Moms NY',                                        content: 'p1-justfinished',             term: 'g-holbrookmomsny3',               members: 1500,    at: '2026-12-18T12:00', week: 6 },
  w638:    { post: 'Once the crew leaves',                group: 'Mastic, Shirley, Mastic beach our community',             content: 'p2-aftercare',                term: 'g-masticshirleym6',               members: 0,       at: '2026-12-18T16:00', week: 6 },
  w639:    { post: 'Ready for another LI winter',         group: 'Long Island, NY Business Owners',                         content: 'p3-winterready',              term: 'g-longislandnybu3',               members: 27500,   at: '2026-12-18T18:00', week: 6 },
  w640:    { post: 'Most roofers say replace',            group: 'SAINT JAMES / SMITHTOWN INFORMATIVE GROUP',               content: 'p4-replacerepair',            term: 'g-saintjamessmit3',               members: 13000,   at: '2026-12-18T19:00', week: 6 },
  w641:    { post: 'Family / pumpkins',                   group: 'Sayville Moms and Dads',                                  content: 'p5-family',                   term: 'g-sayvillemomsan3',               members: 3900,    at: '2026-12-18T20:00', week: 6 },
  w642:    { post: 'First company photo',                 group: 'Bellport Village Residents',                              content: 'p6-crew',                     term: 'g-bellportvillag3',               members: 9600,    at: '2026-12-18T21:00', week: 6 },
  w701:    { post: 'Just finished - full roof',           group: 'Montauk Village',                                         content: 'p1-justfinished',             term: 'g-montaukvillage3',               members: 6600,    at: '2026-12-21T07:00', week: 7 },
  w702:    { post: 'Once the crew leaves',                group: 'Kings Park Community',                                    content: 'p2-aftercare',                term: 'g-kingsparkcommu4',               members: 28700,   at: '2026-12-21T09:00', week: 7 },
  w703:    { post: 'Ready for another LI winter',         group: 'Huntington Matters Community Forum',                      content: 'p3-winterready',              term: 'g-huntingtonmatt4',               members: 61700,   at: '2026-12-21T18:00', week: 7 },
  w704:    { post: 'Most roofers say replace',            group: 'WHAT\'S UP MONTAUK',                                      content: 'p4-replacerepair',            term: 'g-whatsupmontauk3',               members: 22600,   at: '2026-12-21T20:00', week: 7 },
  w705:    { post: 'Family / pumpkins',                   group: 'Massapequa Moms',                                         content: 'p5-family',                   term: 'g-massapequamoms4',               members: 10700,   at: '2026-12-21T21:00', week: 7 },
  w706:    { post: 'First company photo',                 group: 'Plainview Moms',                                          content: 'p6-crew',                     term: 'g-plainviewmoms4',                members: 8400,    at: '2026-12-22T07:00', week: 7 },
  w707:    { post: 'Four generations in Suffolk',         group: 'Dix Hills Moms / South Huntington Moms',                  content: 'p7-generations',              term: 'g-dixhillsmomsso4',               members: 13600,   at: '2026-12-22T09:00', week: 7 },
  w708:    { post: 'As a father',                         group: 'Mastic, Shirley, Mastic beach our community page!',       content: 'p8-asafather',                term: 'g-masticshirleym7',               members: 12200,   at: '2026-12-22T18:00', week: 7 },
  w709:    { post: 'The socks photo',                     group: 'Shirley/Mastics Community Group',                         content: 'p9-socks',                    term: 'g-shirleymastics6',               members: 19800,   at: '2026-12-22T20:00', week: 7 },
  w710:    { post: 'Just finished - full roof',           group: 'Deer Park NY - News, Gossip and Chatter',                 content: 'p1-justfinished',             term: 'g-deerparknynews3',               members: 11200,   at: '2026-12-22T21:00', week: 7 },
  w801:    { post: 'Between Christmas and New Year',      group: 'Shirley and the Mastics. Our Town, Our Community, Our Home!', content: 'p11-newyear',                 term: 'g-shirleyandthem4',               members: 57000,   at: '2026-12-28T07:00', week: 8 },
  w802:    { post: 'Between Christmas and New Year',      group: 'Bellmore/Merrick Uncensored',                             content: 'p11-newyear',                 term: 'g-bellmoremerric4',               members: 21800,   at: '2026-12-28T09:00', week: 8 },
  w803:    { post: 'Between Christmas and New Year',      group: 'East Patchogue Community',                                content: 'p11-newyear',                 term: 'g-eastpatchoguec4',               members: 28900,   at: '2026-12-28T16:00', week: 8 },
  w804:    { post: 'Just finished - full roof',           group: 'Centereach , NY Community Group, Post Your Ad Here, Post Your Business Here', content: 'p1-justfinished',             term: 'g-centereachnyco4',               members: 21300,   at: '2026-12-28T18:00', week: 8 },
  w805:    { post: 'Once the crew leaves',                group: 'Bohemia. Ronkonkoma,Sayville, Oakdale And Surrounding Suffolk Communities', content: 'p2-aftercare',                term: 'g-bohemiaronkonk4',               members: 24100,   at: '2026-12-28T20:00', week: 8 },
  w806:    { post: 'Ready for another LI winter',         group: 'Wantagh Mammas',                                          content: 'p3-winterready',              term: 'g-wantaghmammas4',                members: 18700,   at: '2026-12-28T21:00', week: 8 },
  w807:    { post: 'Most roofers say replace',            group: 'Commack Community Forum',                                 content: 'p4-replacerepair',            term: 'g-commackcommuni4',               members: 6000,    at: '2026-12-29T07:00', week: 8 },
  w808:    { post: 'Family / pumpkins',                   group: 'Wantagh Moms',                                            content: 'p5-family',                   term: 'g-wantaghmoms4',                  members: 4800,    at: '2026-12-29T09:00', week: 8 },
  w809:    { post: 'First company photo',                 group: 'East Meadow Moms',                                        content: 'p6-crew',                     term: 'g-eastmeadowmoms4',               members: 5700,    at: '2026-12-29T16:00', week: 8 },
  w810:    { post: 'Four generations in Suffolk',         group: 'Melville City Chat',                                      content: 'p7-generations',              term: 'g-melvillecitych4',               members: 27000,   at: '2026-12-29T18:00', week: 8 },
  w811:    { post: 'As a father',                         group: 'Lake Grove/Centereach Long Island NY',                    content: 'p8-asafather',                term: 'g-lakegrovecente4',               members: 14700,   at: '2026-12-29T20:00', week: 8 },
  w812:    { post: 'The socks photo',                     group: 'Baldwin NY 11510 and Freeport NY 11520',                  content: 'p9-socks',                    term: 'g-baldwinny115104',               members: 17000,   at: '2026-12-29T21:00', week: 8 },
  w813:    { post: 'Between Christmas and New Year',      group: 'What’s Happening East Meadow',                            content: 'p11-newyear',                 term: 'g-whatshappening4',               members: 11500,   at: '2026-12-30T07:00', week: 8 },
  w814:    { post: 'Between Christmas and New Year',      group: 'Freeporters for Freeport',                                content: 'p11-newyear',                 term: 'g-freeportersfor4',               members: 10900,   at: '2026-12-30T09:00', week: 8 },
  w815:    { post: 'Between Christmas and New Year',      group: 'Patchogue: From the Past to the Present',                 content: 'p11-newyear',                 term: 'g-patchoguefromt4',               members: 22000,   at: '2026-12-30T16:00', week: 8 },
  w816:    { post: 'Just finished - full roof',           group: 'Lynbrook, NY Local Business Bulletin Board',              content: 'p1-justfinished',             term: 'g-lynbrooknyloca4',               members: 4600,    at: '2026-12-30T18:00', week: 8 },
  w817:    { post: 'Once the crew leaves',                group: 'Holtsville Neighbors Yard Sale',                          content: 'p2-aftercare',                term: 'g-holtsvilleneig4',               members: 16900,   at: '2026-12-30T20:00', week: 8 },
  w818:    { post: 'Ready for another LI winter',         group: 'Levittown moms group',                                    content: 'p3-winterready',              term: 'g-levittownmomsg4',               members: 10000,   at: '2026-12-30T21:00', week: 8 },
  w819:    { post: 'Most roofers say replace',            group: 'Town of Babylon group',                                   content: 'p4-replacerepair',            term: 'g-townofbabylong4',               members: 31100,   at: '2026-12-31T07:00', week: 8 },
  w820:    { post: 'Family / pumpkins',                   group: 'All things Valley Stream',                                content: 'p5-family',                   term: 'g-allthingsvalle4',               members: 9600,    at: '2026-12-31T18:00', week: 8 },
  w821:    { post: 'First company photo',                 group: 'Everything Eastport @  The Villages',                     content: 'p6-crew',                     term: 'g-everythingeast4',               members: 34600,   at: '2026-12-31T20:00', week: 8 },
  w822:    { post: 'Four generations in Suffolk',         group: 'Huntington, New York',                                    content: 'p7-generations',              term: 'g-huntingtonnewy4',               members: 8600,    at: '2026-12-31T21:00', week: 8 },

  // Experiment: short, photo-led, no link, ends on a question. Measured in
  // comments rather than clicks, because these carry no link at all.
  x101:    { post: 'Old roof / Southampton',    group: 'Long Island History',               content: 'x1-oldroof',      term: 'g-x-x101',          members: 175800,  at: '2026-11-10T07:30', week: 1, experiment: true, photo: 21 },
  x102:    { post: 'Old house / dormers',       group: 'Sayville Happenings & History',     content: 'x2-oldhouse',     term: 'g-x-x102',          members: 9900,    at: '2026-11-11T07:30', week: 1, experiment: true, photo: 22 },
  x103:    { post: 'How long does a roof last', group: 'The Deer Park We all remember',     content: 'x4-howlong',      term: 'g-x-x103',          members: 12800,   at: '2026-11-12T07:30', week: 1, experiment: true, photo: 24 },
  x104:    { post: 'Metal roof',                group: 'North Babylon Times & Memories',    content: 'x5-metal',        term: 'g-x-x104',          members: 3900,    at: '2026-11-13T07:30', week: 1, experiment: true, photo: 25 },
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
  // The command-line agents matter just as much: a single verification sweep
  // over the link table put 283 machine hits into one day against about 20
  // real ones, and the dashboard reported all of them as clicks.
  const isBot = /bot|crawler|spider|facebookexternalhit|preview|slackbot|whatsapp|headless/i.test(ua)
    || /curl|wget|python-requests|python-urllib|go-http|okhttp|java\/|libwww|scrapy|axios|node-fetch|httpie|postman|checker|monitor|scan|probe|insomnia/i.test(ua)
    || ua === ''
    // Our own checks pass ?qa=1. A spoofed browser user-agent is the only way
    // past Cloudflare's block on script clients, so the user-agent cannot be
    // what identifies them.
    || url.searchParams.get('qa') === '1';

  // Only a slug that exists is a campaign click. Everything else hitting this
  // Worker is a scanner walking for .env, wp-admin, xmlrpc.php and the like,
  // and writing those rows is what put "wp-login.php" in the post report.
  if (env.DB && entry) {
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
