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
    for (const priv of ['/review/groups', '/review/stats', '/review/join', '/review/rules']) {
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
    if (url.pathname === '/api/funnel') return handleFunnel(request, env, ctx);
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
  w1a:   { post: 'Just finished - full roof',   group: 'Shirley and the Mastics. Our Town, Our Community, Our Home!',                      content: 'p1-justfinished',   term: 'g-shirleymastics',       members: 57000,  at: '2026-11-05T19:00', week: 1 },
  w1a2:  { post: 'Just finished - full roof',   group: 'Town of Babylon group',                        content: 'p1-justfinished',   term: 'g-babylontown',          members: 31100,  at: '2026-11-05T23:00', week: 1 },
  w1a3:  { post: 'Just finished - full roof',   group: 'Coram Community News',                         content: 'p1-justfinished',   term: 'g-coram',                members: 8000,   at: '2026-11-06T00:00', week: 1 },
  w1b:   { post: 'Once the crew leaves',        group: 'Centereach , NY Community Group, Post Your Ad Here, Post Your Business Here',                content: 'p2-aftercare',      term: 'g-centereach',           members: 21300,  at: '2026-11-06T11:00', week: 1 },
  w1b2:  { post: 'Once the crew leaves',        group: 'Center Moriches Community Posts',              content: 'p2-aftercare',      term: 'g-centermoriches',       members: 10500,  at: '2026-11-06T12:00', week: 1 },
  w1b3:  { post: 'Once the crew leaves',        group: 'Smithtown Moms and Dads Uncensored',           content: 'p2-aftercare',      term: 'g-smithtownmoms',        members: 12800,  at: '2026-11-06T13:00', week: 1 },
  w101:   { post: 'Ready for another LI winter', group: 'WHAT\'S UP MONTAUK',                           content: 'p3-winterready',    term: 'g-montauk',              members: 22600,  at: '2026-11-09T11:00', week: 1 },
  w102:  { post: 'Ready for another LI winter', group: 'Westhampton Beach Area Community LOCAL',       content: 'p3-winterready',    term: 'g-westhamptonbeach',     members: 4200,   at: '2026-11-09T12:00', week: 1 },
  w104:  { post: 'Ready for another LI winter', group: 'Wake Up Lake!',                                content: 'p3-winterready',    term: 'g-wakeuplake',           members: 6700,   at: '2026-11-09T14:00', week: 1 },
  w105:   { post: 'Most roofers say replace',    group: 'Bohemia. Ronkonkoma,Sayville, Oakdale And Surrounding Suffolk Communities',                content: 'p4-replacerepair',  term: 'g-bohemia',              members: 24100,  at: '2026-11-09T15:00', week: 1 },
  w106:  { post: 'Most roofers say replace',    group: 'The Deer Park We all remember',                content: 'p4-replacerepair',  term: 'g-deerpark',             members: 12800,  at: '2026-11-09T16:00', week: 1 },
  w108:  { post: 'Most roofers say replace',    group: 'Positively East Islip',                        content: 'p4-replacerepair',  term: 'g-positivelyeastislip',  members: 6300,   at: '2026-11-09T18:00', week: 1 },
  w110:    { post: 'Family / pumpkins',                   group: 'Bellmore/Merrick Uncensored',                             content: 'p5-family',                   term: 'g-bellmoremerrickunc',            members: 21800,   at: '2026-11-10T07:00', week: 1 },
  w111:    { post: 'Family / pumpkins',                   group: 'East Patchogue Community',                                content: 'p5-family',                   term: 'g-eastpatchoguecommu',            members: 28900,   at: '2026-11-10T09:00', week: 1 },
  w113:    { post: 'Family / pumpkins',                   group: 'Centereach , NY Community Group, Post Your Ad Here, Post Your Business Here', content: 'p5-family',                   term: 'g-centereachnycommun',            members: 21300,   at: '2026-11-10T15:00', week: 1 },
  w114:    { post: 'First company photo',                 group: 'Commack Community Forum',                                 content: 'p6-crew',                     term: 'g-commackcommunityfo',            members: 6000,    at: '2026-11-10T16:00', week: 1 },
  w115:    { post: 'First company photo',                 group: 'East Meadow Moms',                                        content: 'p6-crew',                     term: 'g-eastmeadowmoms',                members: 5700,    at: '2026-11-10T18:00', week: 1 },
  w117:    { post: 'First company photo',                 group: 'Melville City Chat',                                      content: 'p6-crew',                     term: 'g-melvillecitychat',              members: 27000,   at: '2026-11-10T20:00', week: 1 },
  w119:    { post: 'Four generations in Suffolk',         group: 'Plainview Moms',                                          content: 'p7-generations',              term: 'g-plainviewmoms',                 members: 8400,    at: '2026-11-11T07:00', week: 1 },
  w122:    { post: 'As a father',                         group: 'Dix Hills Moms / South Huntington Moms',                  content: 'p8-asafather',                term: 'g-dixhillsmomssouthh',            members: 13600,   at: '2026-11-11T15:00', week: 1 },
  w124:    { post: 'The socks photo',                     group: 'Everything Babylon',                                      content: 'p9-socks',                    term: 'g-everythingbabylon',             members: 6000,    at: '2026-11-11T18:00', week: 1 },
  w126:    { post: 'Four generations in Suffolk',         group: 'Shirley/Mastic/Mastic Beach/Manorville/Moriches Community Group', content: 'p7-generations',          term: 'g-shirleymasticmanor',            members: 14000,   at: '2026-11-11T20:00', week: 1 },
  w128:    { post: 'As a father',                         group: 'East Moriches Community Posts',                                    content: 'p8-asafather',                term: 'g-eastmorichesco4',            members: 20000,    at: '2026-11-12T07:00', week: 1 },
  w131:    { post: 'The socks photo',                     group: 'Bellport Village Residents',                                    content: 'p9-socks',                    term: 'g-bellportvillag3',            members: 9000,    at: '2026-11-12T15:00', week: 1 },
  w133:    { post: 'Four generations in Suffolk',         group: 'Holbrook Happenings',                             content: 'p7-generations',              term: 'g-holbrookhappenings',            members: 7000,    at: '2026-11-12T18:00', week: 1 },
  w135:    { post: 'As a father',                         group: 'LONG ISLAND MOMS',                          content: 'p8-asafather',                term: 'g-longislandmoms4',            members: 86000,    at: '2026-11-12T20:00', week: 1 },
  w137:    { post: 'The socks photo',                     group: 'Deer Park NY Community Page',             content: 'p9-socks',                    term: 'g-deerparknycomm5',            members: 13000,    at: '2026-11-13T07:00', week: 1 },
  w140:    { post: 'Four generations in Suffolk',         group: 'Malverne News and Views',                 content: 'p7-generations',              term: 'g-malvernenewsan2',            members: 5000,   at: '2026-11-13T15:00', week: 1 },
  w142:    { post: 'As a father',                         group: 'Glen Head-Glenwood-Sea Cliff-Brookville-Greenvale-Roslyn Harbor Neighbors',                                  content: 'p8-asafather',                term: 'g-glenheadglenwoodse',            members: 12000,    at: '2026-11-13T06:00', week: 1 },
  w144:    { post: 'The socks photo',                     group: 'Mastic, Shirley, Mastic beach our community page!',             content: 'p9-socks',                    term: 'g-masticshirleym7',               members: 12000,       at: '2026-11-13T13:00', week: 1 },
  w103:   { post: 'Just finished - full roof',   group: 'Huntington Matters Community Forum',           content: 'p1-justfinished',   term: 'g-huntingtonmattersc',   members: 61700,  at: '2026-11-09T13:00', week: 1 },
  w107:   { post: 'Just finished - full roof',   group: 'Kings Park Community',                         content: 'p1-justfinished',   term: 'g-kingsparkcommunity',   members: 28700,  at: '2026-11-09T17:00', week: 1 },
  w109:   { post: 'Just finished - full roof',   group: 'Massapequa Moms',                              content: 'p1-justfinished',   term: 'g-massapequamoms',       members: 10700,  at: '2026-11-09T19:00', week: 1 },
  w112:    { post: 'Once the crew leaves',                group: 'Bohemia. Ronkonkoma,Sayville, Oakdale And Surrounding Suffolk Communities', content: 'p2-aftercare',                term: 'g-bohemiaronkonkomas',            members: 24100,   at: '2026-11-10T12:00', week: 1 },
  w116:    { post: 'Once the crew leaves',                group: 'Wantagh Moms',                                            content: 'p2-aftercare',                term: 'g-wantaghmoms',                   members: 4800,    at: '2026-11-10T19:00', week: 1 },
  w118:    { post: 'Once the crew leaves',                group: 'Lake Grove/Centereach Long Island NY',                    content: 'p2-aftercare',                term: 'g-lakegrovecentereac',            members: 14700,   at: '2026-11-10T21:00', week: 1 },
  w120:    { post: 'The socks photo',                     group: 'What’s Happening East Meadow',                            content: 'p9-socks',                    term: 'g-whatshappeningeast',            members: 11500,   at: '2026-11-11T09:00', week: 1 },
  w121:    { post: 'The socks photo',                     group: 'Freeporters for Freeport',                                content: 'p9-socks',                    term: 'g-freeportersforfree',            members: 10900,   at: '2026-11-11T12:00', week: 1 },
  w123:    { post: 'The socks photo',                     group: 'Lynbrook, NY Local Business Bulletin Board',              content: 'p9-socks',                    term: 'g-lynbrooknylocalbus',            members: 4600,    at: '2026-11-11T16:00', week: 1 },
  w125:    { post: 'Ready for another LI winter',         group: 'Levittown moms group',                                    content: 'p3-winterready',              term: 'g-levittownmomsgroup',            members: 10000,   at: '2026-11-11T19:00', week: 1 },
  w127:    { post: 'Ready for another LI winter',         group: 'Huntington, New York',                                    content: 'p3-winterready',              term: 'g-huntingtonnewyork',             members: 8600,    at: '2026-11-11T21:00', week: 1 },
  w129:    { post: 'Most roofers say replace',            group: 'Massapequa Moms Group',       content: 'p4-replacerepair',            term: 'g-massapequamoms5',            members: 20000,   at: '2026-11-12T09:00', week: 1 },
  w130:    { post: 'Most roofers say replace',            group: 'Eastport, Manorville, Speonk, Center.East.Moriches  Community',                           content: 'p4-replacerepair',            term: 'g-eastportmanorv3',            members: 35000,   at: '2026-11-12T12:00', week: 1 },
  w132:    { post: 'Family / pumpkins',                   group: 'Oceanside NY  Business Network',                   content: 'p5-family',                   term: 'g-oceansidenybus4',            members: 3000,   at: '2026-11-12T16:00', week: 1 },
  w134:    { post: 'Family / pumpkins',                   group: 'North Lawrence Community',                                content: 'p5-family',                   term: 'g-northlawrencecommu',            members: 5600,    at: '2026-11-12T19:00', week: 1 },
  w136:    { post: 'First company photo',                 group: 'Lindenhurst Moms',                                        content: 'p6-crew',                     term: 'g-lindenhurstmoms',               members: 3100,    at: '2026-11-12T21:00', week: 1 },
  w138:    { post: 'First company photo',                 group: 'WHAT\'S UP MONTAUK',                                        content: 'p6-crew',                     term: 'g-whatsupmontauk3',                members: 22000,   at: '2026-11-13T09:00', week: 1 },
  w139:    { post: 'Four generations in Suffolk',         group: 'Center Moriches Community News',  content: 'p7-generations',              term: 'g-centermorichescomm',            members: 9000,    at: '2026-11-13T12:00', week: 1 },
  w141:    { post: 'Four generations in Suffolk',         group: 'Long Beach City',                content: 'p7-generations',              term: 'g-longbeachcity',            members: 41000,    at: '2026-11-13T14:00', week: 1 },
  w143:    { post: 'As a father',                         group: 'Long Island, NY Business Owners',                                        content: 'p8-asafather',                term: 'g-longislandnybu3',                members: 27000,    at: '2026-11-13T08:00', week: 1 },
  w145:    { post: 'As a father',                         group: 'Best of Hampton Bays, NY',                         content: 'p8-asafather',                term: 'g-bestofhamptonb2',            members: 7000,   at: '2026-11-13T10:00', week: 1 },
  w201:    { post: 'Just finished - full roof',           group: 'Center Moriches Community Posts',                          content: 'p1-justfinished',             term: 'b-261116-p1-justfinished',            members: 10000,    at: '2026-11-16T07:00', week: 2, batch: 'b-261116-p1-justfinished'},
  w202:    { post: 'Once the crew leaves',                group: 'Eyes on Lindy',                                  content: 'p2-aftercare',                term: 'b-261119-p2-aftercare',            members: 12000,    at: '2026-11-19T09:00', week: 2, batch: 'b-261119-p2-aftercare'},
  w203:    { post: 'Ready for another LI winter',         group: 'Islip Town New York Community',                              content: 'p3-winterready',              term: 'g-isliptownnewyorkco',            members: 5000,    at: '2026-11-19T12:00', week: 2, batch: 'b-261119-p3-winterready', via: 'r1116111'},
  w204:    { post: 'Most roofers say replace',            group: 'Commack Connected',                             content: 'p4-replacerepair',            term: 'g-commackconnected',            members: 1000,   at: '2026-11-16T15:00', week: 2, batch: 'b-261116-p4-replacerepair', via: 'r111621'},
  w205:    { post: 'Family / pumpkins',                   group: 'Northport-East Northport Community Forum',                                         content: 'p5-family',                   term: 'g-northporteastnorth',                members: 3000,    at: '2026-11-16T14:00', week: 2 },
  w206:    { post: 'First company photo',                 group: 'Kings Park Community',                 content: 'p6-crew',                     term: 'g-kingsparkcommu4',            members: 28000,   at: '2026-11-16T06:00', week: 2, batch: 'b-261116-p6-crew', via: 'r1116141'},
  w207:    { post: 'Four generations in Suffolk',         group: 'Islip That & This', content: 'p7-generations',              term: 'g-islipthatthis',            members: 6000,   at: '2026-11-16T08:00', week: 2, batch: 'b-261116-p7-generations', via: 'r1116116'},
  w208:    { post: 'As a father',                         group: 'Westhampton Beach Area Community LOCAL',                                  content: 'p8-asafather',                term: 'g-westhamptonbeach',            members: 4000,   at: '2026-11-16T13:00', week: 2, batch: 'b-261116-p8-asafather', via: 'r1116126'},
  w209:    { post: 'The socks photo',                     group: 'Babylon Village Community Discussion',                             content: 'p9-socks',                    term: 'b-261116-p9-socks',            members: 7000,   at: '2026-11-16T10:00', week: 2, batch: 'b-261116-p9-socks'},
  w210:    { post: 'Just finished - full roof',           group: 'Long Island Homes and Apartments',                                content: 'p1-justfinished',             term: 'b-261117-p1-justfinished',               members: 108000,   at: '2026-11-17T07:00', week: 2, batch: 'b-261117-p1-justfinished'},
  w211:    { post: 'Once the crew leaves',                group: 'Neighbors of Quogue Westhampton Speonk Remsenburg Eastport Manorville', content: 'p2-aftercare',                term: 'g-neighborsofquoguew',            members: 14000,    at: '2026-11-17T09:00', week: 2, batch: 'b-261117-p2-aftercare', via: 'r111607'},
  w212:    { post: 'Ready for another LI winter',         group: 'Going Local Long Island Community',                                          content: 'p3-winterready',              term: 'g-goinglocallongisla',                  members: 8000,   at: '2026-11-17T12:00', week: 2, batch: 'b-261117-p3-winterready', via: 'r111643'},
  w213:    { post: 'Most roofers say replace',            group: 'lindenhurst dads and moms',                                   content: 'p4-replacerepair',            term: 'b-261119-p4-replacerepair',            members: 5000,   at: '2026-11-19T15:00', week: 2, batch: 'b-261119-p4-replacerepair'},
  w214:    { post: 'Family / pumpkins',                   group: 'West Islip Moms AND Dads',                                      content: 'p5-family',                   term: 'g-westislipmomsandda',             members: 5000,   at: '2026-11-17T14:00', week: 2 },
  w215:    { post: 'First company photo',                 group: 'Centereach , NY Community Group, Post Your Ad Here, Post Your Business Here',                              content: 'p6-crew',                     term: 'b-261117-p6-crew',            members: 21000,    at: '2026-11-17T06:00', week: 2, batch: 'b-261117-p6-crew'},
  w216:    { post: 'Four generations in Suffolk',         group: 'WHAT\'S UP MONTAUK',                       content: 'p7-generations',              term: 'g-whatsupmontauk3',            members: 22000,   at: '2026-11-18T08:00', week: 2, batch: 'b-261118-p7-generations', via: 'r111602'},
  w217:    { post: 'As a father',                         group: 'West Islip Community',                                content: 'p8-asafather',                term: 'g-westislipcommu4',            members: 6000,   at: '2026-11-17T13:00', week: 2, batch: 'b-261117-p8-asafather', via: 'r111683'},
  w218:    { post: 'The socks photo',                     group: 'The People Of Lindenhurst', content: 'p9-socks',                    term: 'g-thepeopleoflindenh',            members: 9000,   at: '2026-11-17T10:00', week: 2, batch: 'b-261117-p9-socks', via: 'r1116112'},
  w219:    { post: 'Just finished - full roof',           group: 'Sayville Happenings & History', content: 'p1-justfinished',             term: 'b-261118-p1-justfinished',            members: 9000,   at: '2026-11-18T07:00', week: 2, batch: 'b-261118-p1-justfinished'},
  w220:    { post: 'Once the crew leaves',                group: 'Sayville Moms and Dads',                                          content: 'p2-aftercare',                term: 'b-261118-p2-aftercare',                 members: 4000,   at: '2026-11-18T09:00', week: 2, batch: 'b-261118-p2-aftercare'},
  w221:    { post: 'Ready for another LI winter',         group: 'Smithtown NY community page', content: 'p3-winterready',              term: 'b-261118-p3-winterready',            members: 4000,   at: '2026-11-18T12:00', week: 2, batch: 'b-261118-p3-winterready'},
  w222:    { post: 'Most roofers say replace',            group: 'You\'re probably from Sayville if', content: 'p4-replacerepair',            term: 'g-youreprobablyfroms',            members: 3000,   at: '2026-11-18T15:00', week: 2, batch: 'b-261118-p4-replacerepair', via: 'r1116113'},
  w223:    { post: 'Family / pumpkins',                   group: 'Mastic Beach Community Group',                                           content: 'p5-family',                   term: 'g-masticbeachcommuni',                   members: 3000,   at: '2026-11-18T14:00', week: 2 },
  w224:    { post: 'First company photo',                 group: 'East Patchogue Community',                                 content: 'p6-crew',                     term: 'b-261118-p6-crew',            members: 29000,   at: '2026-11-18T06:00', week: 2, batch: 'b-261118-p6-crew'},
  w225:    { post: 'Four generations in Suffolk',         group: 'Bay Shore Community Group',                          content: 'p7-generations',              term: 'g-bayshorecommunityg',            members: 2000,    at: '2026-11-18T08:00', week: 2, batch: 'b-261118-p7-generations', via: 'r111602'},
  w226:    { post: 'As a father',                         group: 'Huntington Nightlife, Long Island NY',                                           content: 'p8-asafather',                term: 'g-huntingtonnightlif',                   members: 3000,    at: '2026-11-18T13:00', week: 2, batch: 'b-261118-p8-asafather', via: 'r111616'},
  w227:    { post: 'The socks photo',                     group: 'Unofficial Port Jefferson Village Hot Topics',                                               content: 'p9-socks',                    term: 'g-unofficialportjeff',                     members: 4000,   at: '2026-11-18T10:00', week: 2, batch: 'b-261118-p9-socks', via: 'r111688'},
  w228:    { post: 'Just finished - full roof',           group: 'East Moriches Community Posts',                                       content: 'p1-justfinished',             term: 'b-261119-p1-justfinished',                 members: 20000,    at: '2026-11-19T07:00', week: 2, batch: 'b-261119-p1-justfinished'},
  w229:    { post: 'Once the crew leaves',                group: 'Brentwood Parents & Alumni (Brentwood, New York)',                                     content: 'p2-aftercare',                term: 'g-brentwoodparentsal',             members: 3000,    at: '2026-11-19T09:00', week: 2, batch: 'b-261119-p2-aftercare', via: 'w202'},
  w230:    { post: 'Ready for another LI winter',         group: 'North Babylon Parents',                            content: 'p3-winterready',              term: 'g-northbabylonparent',            members: 2000,    at: '2026-11-19T12:00', week: 2, batch: 'b-261119-p3-winterready', via: 'r1116111'},
  w231:    { post: 'Most roofers say replace',            group: 'You know you grew up in Greenport when...',                      content: 'p4-replacerepair',            term: 'g-youknowyougrewupin',            members: 2000,    at: '2026-11-19T15:00', week: 2, batch: 'b-261119-p4-replacerepair', via: 'w213'},
  w232:    { post: 'Family / pumpkins',                   group: 'Dix Hills Moms',                                content: 'p5-family',                   term: 'g-dixhillsmoms',            members: 2000,    at: '2026-11-19T14:00', week: 2 },
  w233:    { post: 'First company photo',                 group: 'LONG ISLAND MOMS',                      content: 'p6-crew',                     term: 'b-261119-p6-crew',            members: 86000,    at: '2026-11-19T06:00', week: 2, batch: 'b-261119-p6-crew'},
  w234:    { post: 'Four generations in Suffolk',         group: 'Eastport Community Bulletin Board',                                    content: 'p7-generations',              term: 'g-eastportcommunityb',            members: 3000,    at: '2026-11-19T08:00', week: 2, batch: 'b-261119-p7-generations', via: 'r111604'},
  w235:    { post: 'As a father',                         group: 'Sayville Moms and Dads Uncensored',                content: 'p8-asafather',                term: 'g-sayvillemomsanddad',            members: 2000,    at: '2026-11-19T13:00', week: 2, batch: 'b-261119-p8-asafather', via: 'r111640'},
  w236:    { post: 'The socks photo',                     group: 'Center Moriches, NY',                                            content: 'p9-socks',                    term: 'g-centermorichesny',                   members: 2000,    at: '2026-11-19T10:00', week: 2, batch: 'b-261119-p9-socks', via: 'r1116134'},
  w237:    { post: 'Just finished - full roof',           group: 'Best of Hampton Bays, NY',                      content: 'p1-justfinished',             term: 'b-261120-p1-justfinished',            members: 7000,   at: '2026-11-20T07:00', week: 2, batch: 'b-261120-p1-justfinished', via: 'r111622'},
  w238:    { post: 'Once the crew leaves',                group: 'South Shore Long Island Locals', content: 'p2-aftercare',                term: 'g-southshorelongisla',            members: 2000,    at: '2026-11-20T09:00', week: 2, batch: 'b-261120-p2-aftercare', via: 'r1116110'},
  w239:    { post: 'Ready for another LI winter',         group: 'Bay Shore Moms',                             content: 'p3-winterready',              term: 'b-261120-p3-winterready',            members: 2000,    at: '2026-11-20T12:00', week: 2, batch: 'b-261120-p3-winterready'},
  w240:    { post: 'Most roofers say replace',            group: 'Amityville V.O.I.C.E.S',                                 content: 'p4-replacerepair',            term: 'g-amityvillevoices',            members: 1000,    at: '2026-11-20T15:00', week: 2, batch: 'b-261120-p4-replacerepair', via: 'r1116135'},
  w241:    { post: 'Family / pumpkins',                   group: 'COMMACK MOMS & DADS',     content: 'p5-family',                   term: 'g-commackmomsdads',            members: 1000,    at: '2026-11-20T14:00', week: 2 },
  w242:    { post: 'First company photo',                 group: 'Center Moriches Community News',                               content: 'p6-crew',                     term: 'b-261120-p6-crew',            members: 9000,    at: '2026-11-20T06:00', week: 2, batch: 'b-261120-p6-crew'},
  w243:    { post: 'Four generations in Suffolk',         group: 'Smithtown Moms and Dads Uncensored', content: 'p7-generations',              term: 'b-261120-p7-generations',            members: 12000,    at: '2026-11-20T08:00', week: 2, batch: 'b-261120-p7-generations'},
  w244:    { post: 'As a father',                         group: 'You really know you\'re from Huntington if',                                         content: 'p8-asafather',                term: 'g-youreallyknowyoure',                members: 1000,    at: '2026-11-20T13:00', week: 2, batch: 'b-261120-p8-asafather', via: 'r111605'},
  w245:    { post: 'The socks photo',                     group: 'Mastic Beach Uncensored',                                        content: 'p9-socks',                    term: 'b-261120-p9-socks',               members: 2000,    at: '2026-11-20T10:00', week: 2, batch: 'b-261120-p9-socks'},
  w301:    { post: 'Thanksgiving table',                  group: 'Kings Park Community',                                    content: 'p10-thanksgiving',            term: 'b-261123-p10-thanksgiving',               members: 28700,   at: '2026-11-23T07:00', week: 3, batch: 'b-261123-p10-thanksgiving'},
  w302:    { post: 'Thanksgiving table',                  group: 'Center Moriches Community Posts',                                      content: 'p10-thanksgiving',            term: 'g-centermoriches',                members: 10000,   at: '2026-11-23T09:00', week: 3, batch: 'b-261123-p10-thanksgiving', via: 'w301'},
  w303:    { post: 'Thanksgiving table',                  group: 'Islip That & This',                                         content: 'p10-thanksgiving',            term: 'g-islipthatthis',               members: 6000,   at: '2026-11-23T14:00', week: 3, batch: 'b-261123-p10-thanksgiving', via: 'w301'},
  w304:    { post: 'Just finished - full roof',           group: 'Three Village and Port Jefferson Families',                                  content: 'p1-justfinished',             term: 'g-threevillageandpor',               members: 3000,   at: '2026-11-23T06:00', week: 3 },
  w305:    { post: 'Once the crew leaves',                group: 'Wake Up Lake!',                          content: 'p2-aftercare',                term: 'g-wakeuplake',               members: 6000,    at: '2026-11-23T13:00', week: 3 },
  w306:    { post: 'Ready for another LI winter',         group: 'Centereach | Lake Grove Community',                             content: 'p3-winterready',              term: 'g-centereachlakegrov',               members: 3000,   at: '2026-11-23T10:00', week: 3 },
  w307:    { post: 'Most roofers say replace',            group: 'Sayville Community NY',                             content: 'p4-replacerepair',            term: 'g-sayvillecommunityn',               members: 15000,   at: '2026-11-24T07:00', week: 3 },
  w308:    { post: 'Family / pumpkins',                   group: 'Long Island Locals', content: 'p5-family',                   term: 'g-longislandlocals',               members: 57000,   at: '2026-11-24T09:00', week: 3 },
  w309:    { post: 'First company photo',                 group: 'Hampton Bays Bulletin Board (NOT buy and sell)',                                content: 'p6-crew',                     term: 'g-hamptonbaysbulleti',               members: 11000,   at: '2026-11-24T14:00', week: 3 },
  w310:    { post: 'Four generations in Suffolk',         group: 'Centereach , NY Community Group, Post Your Ad Here, Post Your Business Here', content: 'p7-generations',              term: 'g-centereachnyco4',               members: 21000,   at: '2026-11-24T06:00', week: 3 },
  w311:    { post: 'As a father',                         group: 'Eyes on Lindy',                                 content: 'p8-asafather',                term: 'g-eyesonlindy',               members: 12000,    at: '2026-11-24T13:00', week: 3 },
  w312:    { post: 'The socks photo',                     group: 'SAINT JAMES / SMITHTOWN INFORMATIVE GROUP',                                        content: 'p9-socks',                    term: 'g-saintjamessmithtow',               members: 13000,    at: '2026-11-24T10:00', week: 3 },
  w313:    { post: 'Thanksgiving table',                  group: 'Sayville Happenings & History',                                            content: 'p10-thanksgiving',            term: 'g-x-x102',                  members: 9000,    at: '2026-11-25T07:00', week: 3, batch: 'b-261125-p10-thanksgiving', via: 'w314'},
  w314:    { post: 'Thanksgiving table',                  group: 'East Patchogue Community',                                      content: 'p10-thanksgiving',            term: 'b-261125-p10-thanksgiving',               members: 29000,   at: '2026-11-25T06:00', week: 3, batch: 'b-261125-p10-thanksgiving'},
  w315:    { post: 'Thanksgiving table',                  group: 'Rocky Point Friends & Rentals',                    content: 'p10-thanksgiving',            term: 'g-rockypointfriendsr',               members: 10000,   at: '2026-11-25T13:00', week: 3, batch: 'b-261125-p10-thanksgiving', via: 'w314'},
  w316:    { post: 'Just finished - full roof',           group: 'Commack Community Group',                                          content: 'p1-justfinished',             term: 'g-commackcommunitygr',                members: 11000,    at: '2026-11-25T10:00', week: 3 },
  w401:    { post: 'Just finished - full roof',           group: 'LONG ISLAND MOMS',                            content: 'p1-justfinished',             term: 'b-261130-p1-justfinished',               members: 86000,   at: '2026-11-30T07:00', week: 4, batch: 'b-261130-p1-justfinished'},
  w402:    { post: 'Once the crew leaves',                group: 'Centereach | Lake Grove Community',                                content: 'p2-aftercare',                term: 'g-centereachlakegrov',               members: 3000,   at: '2026-11-30T09:00', week: 4, batch: 'b-261130-p2-aftercare', via: 'r113056'},
  w403:    { post: 'Ready for another LI winter',         group: 'Eyes on Lindy',              content: 'p3-winterready',              term: 'b-261130-p3-winterready',               members: 12000,    at: '2026-11-30T12:00', week: 4, batch: 'b-261130-p3-winterready'},
  w404:    { post: 'Most roofers say replace',            group: 'East Islip NY Uncensored',                          content: 'p4-replacerepair',            term: 'g-eastislipnyuncenso',               members: 4000,   at: '2026-11-30T15:00', week: 4, batch: 'b-261130-p4-replacerepair', via: 'r113016'},
  w405:    { post: 'Family / pumpkins',                   group: 'Suffolk County Local Business/Service',                                    content: 'p5-family',                   term: 'g-suffolkcountylocal',               members: 6000,   at: '2026-11-30T14:00', week: 4 },
  w406:    { post: 'First company photo',                 group: 'East Moriches Community Posts',                                content: 'p6-crew',                     term: 'b-261130-p6-crew',               members: 20000,    at: '2026-11-30T06:00', week: 4, batch: 'b-261130-p6-crew'},
  w407:    { post: 'Four generations in Suffolk',         group: 'Best of Hampton Bays, NY',                                    content: 'p7-generations',              term: 'b-261130-p7-generations',               members: 7000,    at: '2026-11-30T08:00', week: 4, batch: 'b-261130-p7-generations'},
  w408:    { post: 'As a father',                         group: 'Copiague Friends and Neighbors',       content: 'p8-asafather',                term: 'b-261130-p8-asafather',               members: 7000,   at: '2026-11-30T13:00', week: 4, batch: 'b-261130-p8-asafather'},
  w409:    { post: 'The socks photo',                     group: 'Suffolk County Mom\'s',                                    content: 'p9-socks',                    term: 'b-261130-p9-socks',               members: 21000,    at: '2026-11-30T10:00', week: 4, batch: 'b-261130-p9-socks'},
  w410:    { post: 'Just finished - full roof',           group: 'Centereach , NY Community Group, Post Your Ad Here, Post Your Business Here',                           content: 'p1-justfinished',             term: 'b-261201-p1-justfinished',               members: 21000,   at: '2026-12-01T07:00', week: 4, batch: 'b-261201-p1-justfinished'},
  w411:    { post: 'Once the crew leaves',                group: 'Commack Connected',                                content: 'p2-aftercare',                term: 'g-commackconnected',               members: 1000,   at: '2026-12-01T09:00', week: 4, batch: 'b-261201-p2-aftercare', via: 'r113092'},
  w412:    { post: 'Ready for another LI winter',         group: 'Long Island Sell/advertise ANYTHING Legal Only!!',                                    content: 'p3-winterready',              term: 'b-261201-p3-winterready',               members: 31000,    at: '2026-12-01T12:00', week: 4, batch: 'b-261201-p3-winterready'},
  w413:    { post: 'Most roofers say replace',            group: 'Shirley/Mastic/Mastic Beach/Manorville/Moriches Community Group',                   content: 'p4-replacerepair',            term: 'g-shirleymasticmanor',               members: 14000,   at: '2026-12-01T15:00', week: 4, batch: 'b-261201-p4-replacerepair', via: 'r113027'},
  w414:    { post: 'Family / pumpkins',                   group: 'Commack Moms',                             content: 'p5-family',                   term: 'g-commackmoms',               members: 15000,    at: '2026-12-01T14:00', week: 4 },
  w415:    { post: 'First company photo',                 group: 'Sayville Community NY',                                content: 'p6-crew',                     term: 'b-261201-p6-crew',               members: 15000,    at: '2026-12-01T06:00', week: 4, batch: 'b-261201-p6-crew'},
  w416:    { post: 'Four generations in Suffolk',         group: 'Kings Park Downtown',                          content: 'p7-generations',              term: 'g-kingsparkdowntown',               members: 3000,    at: '2026-12-01T08:00', week: 4, batch: 'b-261201-p7-generations', via: 'r113097'},
  w417:    { post: 'As a father',                         group: 'Long Island Chatter buy/sell/trade/barter/ads/less rules Nassau Suffolk',                                        content: 'p8-asafather',                term: 'g-longislandchatterb',               members: 22000,    at: '2026-12-01T13:00', week: 4, batch: 'b-261201-p8-asafather', via: 'r113022'},
  w418:    { post: 'The socks photo',                     group: 'Long Island Homes and Apartments',                                        content: 'p9-socks',                    term: 'b-261201-p9-socks',               members: 108000,   at: '2026-12-01T10:00', week: 4, batch: 'b-261201-p9-socks'},
  w419:    { post: 'Just finished - full roof',           group: 'East Patchogue Community',             content: 'p1-justfinished',             term: 'b-261202-p1-justfinished',               members: 29000,    at: '2026-12-02T07:00', week: 4, batch: 'b-261202-p1-justfinished'},
  w420:    { post: 'Once the crew leaves',                group: 'Brentwood',  content: 'p2-aftercare',                term: 'b-261202-p2-aftercare',               members: 12000,    at: '2026-12-02T09:00', week: 4, batch: 'b-261202-p2-aftercare'},
  w421:    { post: 'Ready for another LI winter',         group: 'Holbrook Happenings',                 content: 'p3-winterready',              term: 'g-holbrookhappenings',               members: 7000,   at: '2026-12-02T12:00', week: 4, batch: 'b-261202-p3-winterready', via: 'r113018'},
  w422:    { post: 'Most roofers say replace',            group: 'West Islip Moms AND Dads',                content: 'p4-replacerepair',            term: 'g-westislipmomsandda',               members: 5000,    at: '2026-12-02T15:00', week: 4, batch: 'b-261202-p4-replacerepair', via: 'r113093'},
  w423:    { post: 'Family / pumpkins',                   group: 'Commack Community Forum',                                  content: 'p5-family',                   term: 'g-commackcommunityfo',               members: 6000,    at: '2026-12-02T14:00', week: 4 },
  w424:    { post: 'First company photo',                 group: 'Sayville Happenings & History',                                        content: 'p6-crew',                     term: 'b-261202-p6-crew',               members: 9000,    at: '2026-12-02T06:00', week: 4, batch: 'b-261202-p6-crew'},
  w425:    { post: 'Four generations in Suffolk',         group: 'Lake Grove (NY) & Surrounding Areas Parents',                           content: 'p7-generations',              term: 'g-lakegrovenysurroun',            members: 2000,   at: '2026-12-02T08:00', week: 4, batch: 'b-261202-p7-generations', via: 'r113053'},
  w426:    { post: 'As a father',                         group: 'Port Jefferson, Setauket, Stony Brook & Mount Sinai Recommendations',             content: 'p8-asafather',                term: 'g-portjeffersonsetau',               members: 6000,       at: '2026-12-02T13:00', week: 4, batch: 'b-261202-p8-asafather', via: 'r113088'},
  w427:    { post: 'The socks photo',                     group: 'Rocky Point & Local Surrounding Businesses/Organizations',                         content: 'p9-socks',                    term: 'b-261202-p9-socks',               members: 8000,   at: '2026-12-02T10:00', week: 4, batch: 'b-261202-p9-socks'},
  w428:    { post: 'Just finished - full roof',           group: 'Babylon Advertising - Town of Babylon - Babylon, NY',                                  content: 'p1-justfinished',             term: 'b-261203-p1-justfinished',               members: 5000,    at: '2026-12-03T07:00', week: 4, batch: 'b-261203-p1-justfinished'},
  w429:    { post: 'As a father',                group: 'Wyandanch Stand Up',                              content: 'p8-asafather',                term: 'g-wyandanchstandup',               members: 4000,    at: '2026-12-03T09:00', week: 4, batch: 'b-261203-p8-asafather', via: 'r113044'},
  w430:    { post: 'Ready for another LI winter',         group: 'North Babylon Times & Memories',                             content: 'p3-winterready',              term: 'g-x-x104',               members: 3000,   at: '2026-12-03T12:00', week: 4, batch: 'b-261203-p3-winterready', via: 'r113084'},
  w431:    { post: 'Most roofers say replace',            group: 'Center Moriches, NY',                                         content: 'p4-replacerepair',            term: 'g-centermorichesny',               members: 2000,    at: '2026-12-03T15:00', week: 4, batch: 'b-261203-p4-replacerepair', via: 'r113049'},
  w432:    { post: 'Family / pumpkins',                   group: 'Lake Ronkonkoma neighborhood & town watch',                 content: 'p5-family',                   term: 'g-lakeronkonkomaneig',               members: 3000,   at: '2026-12-03T14:00', week: 4 },
  w433:    { post: 'First company photo',                 group: 'The OFFICIAL Patchogue-Medford Mom’s & Dad’s Group', content: 'p6-crew',                     term: 'b-261203-p6-crew',               members: 6000,   at: '2026-12-03T06:00', week: 4, batch: 'b-261203-p6-crew'},
  w434:    { post: 'Four generations in Suffolk',         group: 'Eastport Peninsula Community Bulletin Board',                             content: 'p7-generations',              term: 'g-eastportpeninsulac',               members: 5000,   at: '2026-12-03T08:00', week: 4, batch: 'b-261203-p7-generations', via: 'r113009'},
  w435:    { post: 'As a father',                         group: 'West islip mom’s uncensored', content: 'p8-asafather',                term: 'g-westislipmomsuncen',               members: 3000,    at: '2026-12-03T13:00', week: 4, batch: 'b-261203-p8-asafather', via: 'r113044'},
  w436:    { post: 'The socks photo',                     group: 'Suffolk/Nassau Community',                                          content: 'p9-socks',                    term: 'g-suffolknassaucommu',                 members: 4000,   at: '2026-12-03T10:00', week: 4, batch: 'b-261203-p9-socks', via: 'r113094'},
  w437:    { post: 'Just finished - full roof',           group: 'Amityville Families & Community Group',                                   content: 'p1-justfinished',             term: 'b-261204-p1-justfinished',               members: 5000,   at: '2026-12-04T07:00', week: 4, batch: 'b-261204-p1-justfinished'},
  w438:    { post: 'Once the crew leaves',                group: 'Brentwood Neighborhood',                                      content: 'p2-aftercare',                term: 'g-brentwoodneighborh',               members: 2000,   at: '2026-12-04T09:00', week: 4, batch: 'b-261204-p2-aftercare', via: 'r1130100'},
  w439:    { post: 'Ready for another LI winter',         group: 'Islip Community',                              content: 'p3-winterready',              term: 'g-islipcommunity',               members: 2000,    at: '2026-12-04T12:00', week: 4, batch: 'b-261204-p3-winterready', via: 'r113095'},
  w440:    { post: 'Most roofers say replace',            group: 'EAST YAPHANK/NORTH SHIRLEY COMMUNITY',                       content: 'p4-replacerepair',            term: 'g-eastyaphanknorthsh',               members: 1000,   at: '2026-12-04T15:00', week: 4, batch: 'b-261204-p4-replacerepair', via: 'r113005'},
  w441:    { post: 'Family / pumpkins',                   group: 'Huntington NY',                                content: 'p5-family',                   term: 'g-huntingtonny',               members: 1000,   at: '2026-12-04T14:00', week: 4 },
  w442:    { post: 'First company photo',                 group: 'Smithtown Moms and Dads Uncensored', content: 'p6-crew',                     term: 'b-261204-p6-crew',               members: 12000,   at: '2026-12-04T06:00', week: 4, batch: 'b-261204-p6-crew'},
  w443:    { post: 'Four generations in Suffolk',         group: 'Sayville Moms and Dads Uncensored',                      content: 'p7-generations',              term: 'g-sayvillemomsanddad',               members: 2000,   at: '2026-12-04T08:00', week: 4, batch: 'b-261204-p7-generations', via: 'r113020'},
  w444:    { post: 'As a father',                         group: 'Bayport-Blue Point Parents, Friends & Family', content: 'p8-asafather',                term: 'g-bayportbluepointpa',               members: 1000,   at: '2026-12-04T13:00', week: 4, batch: 'b-261204-p8-asafather', via: 'r113055'},
  w445:    { post: 'The socks photo',                     group: 'You know you grew up in Babylon, New York if you remember.........',                                          content: 'p9-socks',                    term: 'g-youknowyougrewupin',                members: 2000,   at: '2026-12-04T10:00', week: 4, batch: 'b-261204-p9-socks', via: 'r113050'},
  w501:    { post: 'Just finished - full roof',           group: 'Center Moriches Community News',                                      content: 'p1-justfinished',             term: 'b-261207-p1-justfinished',               members: 9000,   at: '2026-12-07T07:00', week: 5, batch: 'b-261207-p1-justfinished'},
  w502:    { post: 'Once the crew leaves',                group: 'Lindenhurst Moms',                                    content: 'p2-aftercare',                term: 'g-lindenhurstmoms',               members: 3000,   at: '2026-12-07T09:00', week: 5},
  w503:    { post: 'Ready for another LI winter',         group: 'Commack Community Group',                                         content: 'p3-winterready',              term: 'g-commackcommunitygr',               members: 11000,   at: '2026-12-11T12:00', week: 5, batch: 'b-261211-p3-winterready', via: 'r120716'},
  w504:    { post: 'Most roofers say replace',            group: 'West Babylon NY Moms & Dads',                          content: 'p4-replacerepair',            term: 'g-westbabylonnymomsd',               members: 4000,    at: '2026-12-07T15:00', week: 5, batch: 'b-261207-p4-replacerepair', via: 'r120701'},
  w505:    { post: 'Family / pumpkins',                   group: 'Sayville Community',                                  content: 'p5-family',                   term: 'g-sayvillecommunity',               members: 5000,   at: '2026-12-11T14:00', week: 5 },
  w506:    { post: 'First company photo',                 group: 'Eastport, Manorville, Speonk, Center.East.Moriches  Community', content: 'p6-crew',                     term: 'b-261207-p6-crew',               members: 35000,   at: '2026-12-07T06:00', week: 5, batch: 'b-261207-p6-crew'},
  w507:    { post: 'Four generations in Suffolk',         group: 'Mastic, Shirley, Mastic beach our community page!', content: 'p7-generations',              term: 'g-masticshirleym7',               members: 12000,   at: '2026-12-07T08:00', week: 5, batch: 'b-261207-p7-generations', via: 'r120741'},
  w508:    { post: 'As a father',                         group: 'Suffolk County Local Business/Service',                                           content: 'p8-asafather',                term: 'g-suffolkcountylocal',                  members: 6000,   at: '2026-12-11T13:00', week: 5, batch: 'b-261211-p8-asafather', via: 'r120721'},
  w509:    { post: 'The socks photo',                     group: 'Islip That & This',                                 content: 'p9-socks',                    term: 'g-islipthatthis',               members: 6000,   at: '2026-12-07T10:00', week: 5, batch: 'b-261207-p9-socks', via: 'r120706'},
  w510:    { post: 'Just finished - full roof',           group: 'Sayville Community NY',                             content: 'p1-justfinished',             term: 'b-261208-p1-justfinished',               members: 15000,   at: '2026-12-08T07:00', week: 5, batch: 'b-261208-p1-justfinished'},
  w511:    { post: 'Once the crew leaves',                group: 'Babylon Village uncensored', content: 'p2-aftercare',                term: 'g-babylonvillageunce',               members: 1000,   at: '2026-12-08T09:00', week: 5 },
  w512:    { post: 'Ready for another LI winter',         group: 'Shirley/Mastic/Mastic Beach/Manorville/Moriches Community Group',                                content: 'p3-winterready',              term: 'b-261208-p3-winterready',               members: 14000,   at: '2026-12-08T12:00', week: 5, batch: 'b-261208-p3-winterready'},
  w513:    { post: 'Most roofers say replace',            group: 'SHIRLEY - MASTIC’S - MORICHES - SMITH POINT', content: 'p4-replacerepair',            term: 'g-shirleymasticsmori',               members: 7000,   at: '2026-12-08T15:00', week: 5, batch: 'b-261208-p4-replacerepair', via: 'r120792'},
  w514:    { post: 'Family / pumpkins',                   group: 'Going Local Long Island Community',                                 content: 'p5-family',                   term: 'g-goinglocallongisla',               members: 8000,    at: '2026-12-08T14:00', week: 5 },
  w515:    { post: 'First company photo',                 group: 'Westhampton Beach Area Community LOCAL',                          content: 'p6-crew',                     term: 'g-westhamptonbeach',               members: 4000,    at: '2026-12-08T06:00', week: 5, batch: 'b-261208-p6-crew', via: 'r120742'},
  w516:    { post: 'Four generations in Suffolk',         group: 'Northport-East Northport Community Forum',                                        content: 'p7-generations',              term: 'b-261208-p7-generations',               members: 3000,    at: '2026-12-08T08:00', week: 5, batch: 'b-261208-p7-generations'},
  w517:    { post: 'As a father',                         group: 'Long Island Moms | Things To Do, Events & Local Businesses',                                               content: 'p8-asafather',                term: 'b-261208-p8-asafather',                    members: 9000,   at: '2026-12-08T13:00', week: 5, batch: 'b-261208-p8-asafather'},
  w518:    { post: 'The socks photo',                     group: 'WHAT\'S UP MONTAUK',                                           content: 'p9-socks',                    term: 'g-whatsupmontauk3',                  members: 22000,    at: '2026-12-08T10:00', week: 5 },
  w519:    { post: 'Just finished - full roof',           group: 'Miller Place / Sound Beach Community',                                            content: 'p1-justfinished',             term: 'g-millerplacesoundbe',                  members: 3000,    at: '2026-12-09T07:00', week: 5 },
  w520:    { post: 'Once the crew leaves',                group: 'Amityville V.O.I.C.E.S',                                      content: 'p2-aftercare',                term: 'g-amityvillevoices',               members: 1000,   at: '2026-12-09T09:00', week: 5, batch: 'b-261209-p2-aftercare', via: 'r120788'},
  w521:    { post: 'Ready for another LI winter',         group: 'Westhampton Beach Community',                    content: 'p3-winterready',              term: 'g-westhamptonbeachco',               members: 1000,   at: '2026-12-09T12:00', week: 5 },
  w522:    { post: 'Most roofers say replace',            group: 'WESTHAMPTON BEACH FRIENDS AND NEIGHBORS',                                          content: 'p4-replacerepair',            term: 'g-westhamptonbeachfr',                members: 1000,    at: '2026-12-09T15:00', week: 5, batch: 'b-261209-p4-replacerepair', via: 'r120703'},
  w523:    { post: 'Family / pumpkins',                   group: 'East Quogue Community News',                                       content: 'p5-family',                   term: 'g-eastquoguecommunit',                members: 1000,    at: '2026-12-09T14:00', week: 5 },
  w524:    { post: 'First company photo',                 group: 'Rocky Point Friends & Rentals',                                     content: 'p6-crew',                     term: 'g-rockypointfriendsr',               members: 10000,    at: '2026-12-09T06:00', week: 5 },
  w525:    { post: 'Four generations in Suffolk',         group: 'Kings Park Moms and Dads',                            content: 'p7-generations',              term: 'b-261209-p7-generations',               members: 2000,    at: '2026-12-09T08:00', week: 5, batch: 'b-261209-p7-generations'},
  w526:    { post: 'As a father',                         group: 'The Riverhead Township Side of Wading River',                      content: 'p8-asafather',                term: 'g-theriverheadtownsh',               members: 1000,    at: '2026-12-09T13:00', week: 5, batch: 'b-261209-p8-asafather', via: 'r120743'},
  w527:    { post: 'The socks photo',                     group: 'Sayville Moms and Dads',                                content: 'p9-socks',                    term: 'b-261209-p9-socks',               members: 4000,    at: '2026-12-09T10:00', week: 5, batch: 'b-261209-p9-socks'},
  w528:    { post: 'Just finished - full roof',           group: 'The OFFICIAL Patchogue-Medford Mom’s & Dad’s Group',                             content: 'p1-justfinished',             term: 'g-theofficialpatchog',               members: 6000,   at: '2026-12-10T07:00', week: 5 },
  w529:    { post: 'Once the crew leaves',                group: 'East Islip neighborhood & town watch',                                 content: 'p2-aftercare',                term: 'g-eastislipneighborh',               members: 809,   at: '2026-12-10T09:00', week: 5, batch: 'b-261210-p2-aftercare', via: 'r120766'},
  w530:    { post: 'As a father',         group: 'West Babylon Mom\'s',                      content: 'p8-asafather',              term: 'b-261210-p8-asafather',               members: 655,    at: '2026-12-10T12:00', week: 5, batch: 'b-261210-p8-asafather'},
  w531:    { post: 'Four generations in Suffolk',            group: 'Amityville NY',                                    content: 'p7-generations',            term: 'g-amityvilleny',               members: 125,    at: '2026-12-10T15:00', week: 5, batch: 'b-261210-p7-generations', via: 'w534'},
  w532:    { post: 'Family / pumpkins',                   group: 'Nesconset Neighbors United',                content: 'p5-family',                   term: 'g-nesconsetneighbors',               members: 277,    at: '2026-12-10T14:00', week: 5 },
  w533:    { post: 'First company photo',                 group: 'The Huntington High School Rock',                                            content: 'p6-crew',                     term: 'g-thehuntingtonhighs',                  members: 990,    at: '2026-12-10T06:00', week: 5 },
  w534:    { post: 'Four generations in Suffolk',         group: 'Kings park “ community” NO BS', content: 'p7-generations',              term: 'b-261210-p7-generations',               members: 867,    at: '2026-12-10T08:00', week: 5, batch: 'b-261210-p7-generations'},
  w535:    { post: 'As a father',                         group: 'Strathmore Court Residents - Coram, NY',                             content: 'p8-asafather',                term: 'g-strathmorecourtres',               members: 499,    at: '2026-12-10T13:00', week: 5, batch: 'b-261210-p8-asafather', via: 'w530'},
  w536:    { post: 'The socks photo',                     group: 'Hampton Bays Group',                                 content: 'p9-socks',                    term: 'g-hamptonbaysgroup',               members: 754,    at: '2026-12-10T10:00', week: 5 },
  w537:    { post: 'As a father',           group: 'Amityville Families & Community Group',                  content: 'p8-asafather',             term: 'g-amityvillefamilies',               members: 5000,   at: '2026-12-11T07:00', week: 5, batch: 'b-261211-p8-asafather', via: 'r120721'},
  w542:    { post: 'First company photo',                 group: 'Dix Hills Moms / South Huntington Moms',                                        content: 'p6-crew',                     term: 'b-261211-p6-crew',               members: 13000,    at: '2026-12-11T06:00', week: 5, batch: 'b-261211-p6-crew'},
  w543:    { post: 'Four generations in Suffolk',         group: 'Smithtown moms group',                                       content: 'p7-generations',              term: 'g-smithtownmomsgroup',              members: 66,    at: '2026-12-11T08:00', week: 5, batch: 'b-261211-p7-generations', via: 'r120796'},
  w601:    { post: 'Just finished - full roof',           group: 'Mastic, Shirley, Mastic beach our community page!',                                content: 'p1-justfinished',             term: 'b-261214-p1-justfinished',               members: 12000,   at: '2026-12-14T07:00', week: 6, batch: 'b-261214-p1-justfinished'},
  w602:    { post: 'Once the crew leaves',                group: 'East Moriches Community Posts',                            content: 'p2-aftercare',                term: 'b-261214-p2-aftercare',               members: 20000,   at: '2026-12-14T09:00', week: 6, batch: 'b-261214-p2-aftercare'},
  w603:    { post: 'Ready for another LI winter',         group: 'Brightwaters/Bay Shore Community Uncensored',                          content: 'p3-winterready',              term: 'g-brightwatersbaysho',               members: 6000,   at: '2026-12-14T12:00', week: 6, batch: 'b-261214-p3-winterready', via: 'r121416'},
  w604:    { post: 'Most roofers say replace',            group: 'Happy Days In Hampton Bays',              content: 'p4-replacerepair',            term: 'g-happydaysinhampton',               members: 4000,    at: '2026-12-14T15:00', week: 6, batch: 'b-261214-p4-replacerepair', via: 'r121411'},
  w605:    { post: 'Family / pumpkins',                   group: 'West Babylon NY Moms & Dads',                                content: 'p5-family',                   term: 'g-westbabylonnymomsd',               members: 4000,    at: '2026-12-14T14:00', week: 6 },
  w606:    { post: 'First company photo',                 group: 'Best of Hampton Bays, NY',                                    content: 'p6-crew',                     term: 'g-bestofhamptonb2',               members: 7000,   at: '2026-12-14T06:00', week: 6, batch: 'b-261214-p6-crew', via: 'r121441'},
  w607:    { post: 'Four generations in Suffolk',         group: 'LONG ISLAND MOMS',                                    content: 'p7-generations',              term: 'b-261214-p7-generations',               members: 86000,    at: '2026-12-14T08:00', week: 6, batch: 'b-261214-p7-generations'},
  w608:    { post: 'As a father',                         group: 'Islip Town New York Community',                                    content: 'p8-asafather',                term: 'g-isliptownnewyorkco',               members: 5000,    at: '2026-12-14T13:00', week: 6, batch: 'b-261214-p8-asafather', via: 'r121486'},
  w609:    { post: 'The socks photo',                     group: 'Three Village and Port Jefferson Families',       content: 'p9-socks',                    term: 'g-threevillageandpor',               members: 3000,   at: '2026-12-14T10:00', week: 6, batch: 'b-261214-p9-socks', via: 'r121406'},
  w610:    { post: 'Just finished - full roof',           group: 'Northport-East Northport Community Forum',                                    content: 'p1-justfinished',             term: 'g-northporteastnorth',               members: 3000,    at: '2026-12-15T07:00', week: 6, batch: 'b-261215-p1-justfinished', via: 'r121492'},
  w611:    { post: 'Once the crew leaves',                group: 'Long Island Mom’s and Dad’s',                           content: 'p2-aftercare',                term: 'g-longislandmomsandd',               members: 48000,   at: '2026-12-15T09:00', week: 6, batch: 'b-261215-p2-aftercare', via: 'r121487'},
  w612:    { post: 'Ready for another LI winter',         group: 'Bohemia. Ronkonkoma,Sayville, Oakdale And Surrounding Suffolk Communities',                   content: 'p3-winterready',              term: 'b-261215-p3-winterready',               members: 24000,   at: '2026-12-15T12:00', week: 6, batch: 'b-261215-p3-winterready'},
  w613:    { post: 'Most roofers say replace',            group: 'SAINT JAMES / SMITHTOWN INFORMATIVE GROUP',                                content: 'p4-replacerepair',            term: 'g-saintjamessmithtow',               members: 13000,   at: '2026-12-15T15:00', week: 6, batch: 'b-261215-p4-replacerepair', via: 'r121422'},
  w614:    { post: 'Family / pumpkins',                   group: 'Shirley/Mastic/Mastic Beach/Manorville/Moriches Community Group',                          content: 'p5-family',                   term: 'g-shirleymasticmanor',               members: 14000,    at: '2026-12-15T14:00', week: 6 },
  w615:    { post: 'First company photo',                 group: 'Mastic Beach, NY: Support Your Neighbors!',                             content: 'p6-crew',                     term: 'g-masticbeachnysuppo',               members: 3000,    at: '2026-12-15T06:00', week: 6, batch: 'b-261215-p6-crew', via: 'r1214107'},
  w616:    { post: 'Four generations in Suffolk',         group: 'Mount Sinai Community',                                content: 'p7-generations',              term: 'g-mountsinaicommunit',               members: 2000,    at: '2026-12-15T08:00', week: 6, batch: 'b-261215-p7-generations', via: 'r121462'},
  w617:    { post: 'As a father',                         group: 'Commack Moms',                                        content: 'p8-asafather',                term: 'g-commackmoms',               members: 15000,   at: '2026-12-15T13:00', week: 6, batch: 'b-261215-p8-asafather', via: 'r121497'},
  w618:    { post: 'The socks photo',                     group: 'Long Island Moms and dads group',                                        content: 'p9-socks',                    term: 'b-261215-p9-socks',               members: 40000,    at: '2026-12-15T10:00', week: 6, batch: 'b-261215-p9-socks'},
  w619:    { post: 'Just finished - full roof',           group: 'Babylon Village Community Discussion',  content: 'p1-justfinished',             term: 'g-babylonvillagecomm',               members: 7000,    at: '2026-12-16T07:00', week: 6, batch: 'b-261216-p1-justfinished', via: 'r121413'},
  w620:    { post: 'Once the crew leaves',                group: 'The Deer Park We all remember',             content: 'p2-aftercare',                term: 'g-deerpark',               members: 12000,    at: '2026-12-16T09:00', week: 6, batch: 'b-261216-p2-aftercare', via: 'r121443'},
  w621:    { post: 'Ready for another LI winter',         group: 'SHIRLEY - MASTIC’S - MORICHES - SMITH POINT',                content: 'p3-winterready',              term: 'g-shirleymasticsmori',               members: 7000,    at: '2026-12-16T12:00', week: 6, batch: 'b-261216-p3-winterready', via: 'r121493'},
  w622:    { post: 'Most roofers say replace',            group: 'Montauk Village',                 content: 'p4-replacerepair',            term: 'g-montaukvillage',               members: 6000,   at: '2026-12-16T14:00', week: 6, batch: 'b-261216-p4-replacerepair', via: 'r121488'},
  w623:    { post: 'Family / pumpkins',                   group: 'Sayville Happenings & History',                                        content: 'p5-family',                   term: 'g-x-x102',               members: 9000,    at: '2026-12-16T06:00', week: 6 },
  w624:    { post: 'First company photo',                 group: 'Kings Park Moms and Dads',                                  content: 'p6-crew',                     term: 'g-kingsparkmomsandda',               members: 2000,    at: '2026-12-16T08:00', week: 6, batch: 'b-261216-p6-crew', via: 'r121463'},
  w625:    { post: 'Most roofers say replace',           group: 'Let\'s Talk Village Of Greenport',             content: 'p4-replacerepair',            term: 'g-letstalkvillageofg',               members: 7000,       at: '2026-12-16T13:00', week: 6, batch: 'b-261216-p4-replacerepair', via: 'r121488'},
  w626:    { post: 'As a father',                         group: 'The People Of Lindenhurst',                           content: 'p8-asafather',                term: 'g-thepeopleoflindenh',               members: 9000,   at: '2026-12-16T10:00', week: 6, batch: 'b-261216-p8-asafather', via: 'r121453'},
  w627:    { post: 'The socks photo',                     group: 'The Other Deer Park NY Community Group!',                                  content: 'p9-socks',                    term: 'b-261217-p9-socks',               members: 5000,    at: '2026-12-17T07:00', week: 6, batch: 'b-261217-p9-socks'},
  w628:    { post: 'Just finished - full roof',           group: 'Sachem Moms',                         content: 'p1-justfinished',             term: 'g-sachemmoms',               members: 5000,   at: '2026-12-17T09:00', week: 6, batch: 'b-261217-p1-justfinished', via: 'r121491'},
  w629:    { post: 'Once the crew leaves',                group: 'Smithtown , St. James , Nesconset and Hauppauge - United We Stand',                             content: 'p2-aftercare',                term: 'g-smithtownstjamesne',               members: 3000,   at: '2026-12-17T12:00', week: 6, batch: 'b-261217-p2-aftercare', via: 'r121454'},
  w630:    { post: 'Ready for another LI winter',         group: 'Eastport Community Bulletin Board',                                         content: 'p3-winterready',              term: 'g-eastportcommunityb',               members: 3000,    at: '2026-12-17T14:00', week: 6, batch: 'b-261217-p3-winterready', via: 'r121449'},
  w631:    { post: 'Most roofers say replace',            group: 'The OFFICIAL Patchogue-Medford Mom’s & Dad’s Group',                              content: 'p4-replacerepair',            term: 'b-261217-p4-replacerepair',               members: 6000,    at: '2026-12-17T06:00', week: 6, batch: 'b-261217-p4-replacerepair'},
  w632:    { post: 'Family / pumpkins',                   group: 'All things Port Jeff Village by the people in the Neighborhood', content: 'p5-family',                   term: 'g-allthingsportjeffv',               members: 5000,   at: '2026-12-17T08:00', week: 6 },
  w633:    { post: 'First company photo',                 group: 'Growing up Copiague',                             content: 'p6-crew',                     term: 'g-growingupcopiague',               members: 3000,   at: '2026-12-17T13:00', week: 6, batch: 'b-261217-p6-crew', via: 'r121419'},
  w634:    { post: 'Four generations in Suffolk',         group: 'Unofficial Port Jefferson Village Hot Topics',                 content: 'p7-generations',              term: 'g-unofficialportjeff',               members: 4000,   at: '2026-12-17T10:00', week: 6, batch: 'b-261217-p7-generations', via: 'r121484'},
  w635:    { post: 'Between Christmas and New Year',                         group: 'Smithtown Moms and Dads Uncensored',                                          content: 'p11-newyear',                term: 'g-smithtownmoms',                 members: 12000,   at: '2026-12-18T07:00', week: 6 },
  w636:    { post: 'The socks photo',                     group: 'Huntington Station Community Forum', content: 'p9-socks',                    term: 'g-huntingtonstationc',               members: 2000,    at: '2026-12-18T09:00', week: 6, batch: 'b-261218-p9-socks', via: 'r1214105'},
  w637:    { post: 'Just finished - full roof',           group: 'South Shore Long Island Locals',                                      content: 'p1-justfinished',             term: 'g-southshorelongisla',               members: 2000,   at: '2026-12-18T12:00', week: 6, batch: 'b-261218-p1-justfinished', via: 'r1214100'},
  w638:    { post: 'Once the crew leaves',                group: 'Bayport-Blue Point Parents, Friends & Family',                                   content: 'p2-aftercare',                term: 'g-bayportbluepointpa',               members: 1000,   at: '2026-12-18T14:00', week: 6, batch: 'b-261218-p2-aftercare', via: 'r121410'},
  w639:    { post: 'Ready for another LI winter',         group: 'Amityville Families & Community Group',                       content: 'p3-winterready',              term: 'g-amityvillefamilies',               members: 5000,   at: '2026-12-18T06:00', week: 6, batch: 'b-261218-p3-winterready', via: 'r121405'},
  w640:    { post: 'Most roofers say replace',            group: 'North Babylon Parents',                              content: 'p4-replacerepair',            term: 'g-northbabylonparent',               members: 2000,    at: '2026-12-18T08:00', week: 6, batch: 'b-261218-p4-replacerepair', via: 'r121455'},
  w641:    { post: 'As a father',                   group: 'Mastic Beach Uncensored', content: 'p8-asafather',                   term: 'g-masticbeachuncenso',               members: 2000,   at: '2026-12-18T13:00', week: 6, batch: 'b-261218-p8-asafather', via: 'r121420'},
  w642:    { post: 'First company photo',                 group: 'You know you grew up in Greenport when...',                                content: 'p6-crew',                     term: 'g-youknowyougrewupin',               members: 2000,   at: '2026-12-18T10:00', week: 6, batch: 'b-261218-p6-crew', via: 'r121452'},
  w701:    { post: 'Between Christmas and New Year',           group: 'Kings Park Community',                                          content: 'p11-newyear',             term: 'g-kingsparkcommu4',                members: 28000,   at: '2026-12-21T07:00', week: 7 },
  w702:    { post: 'Once the crew leaves',                group: 'Eastport, Manorville, Speonk, Center.East.Moriches  Community',                                      content: 'p2-aftercare',                term: 'g-eastportmanorv3',               members: 35000,   at: '2026-12-21T09:00', week: 7 },
  w703:    { post: 'Ready for another LI winter',         group: 'LONG ISLAND MOMS',                                    content: 'p3-winterready',              term: 'g-longislandmoms4',               members: 86000,   at: '2026-12-21T06:00', week: 7 },
  w704:    { post: 'Most roofers say replace',            group: 'Best of Hampton Bays, NY',                                         content: 'p4-replacerepair',            term: 'g-bestofhamptonb2',               members: 7000,   at: '2026-12-21T13:00', week: 7 },
  w705:    { post: 'Family / pumpkins',                   group: 'East Moriches Community Posts',                          content: 'p5-family',                   term: 'g-eastmorichesco4',               members: 20000,    at: '2026-12-21T10:00', week: 7 },
  w706:    { post: 'First company photo',                 group: 'Mastic, Shirley, Mastic beach our community page!',                             content: 'p6-crew',                     term: 'g-masticshirleym7',               members: 12000,   at: '2026-12-22T07:00', week: 7 },
  w707:    { post: 'Four generations in Suffolk',         group: 'Center Moriches Community Posts',                                content: 'p7-generations',              term: 'g-centermoriches',               members: 10000,   at: '2026-12-22T09:00', week: 7 },
  w708:    { post: 'As a father',                         group: 'Center Moriches Community News', content: 'p8-asafather',                term: 'g-centermorichescomm',               members: 9000,   at: '2026-12-22T06:00', week: 7 },
  w709:    { post: 'The socks photo',                     group: 'Centereach , NY Community Group, Post Your Ad Here, Post Your Business Here', content: 'p9-socks',                    term: 'g-centereachnyco4',               members: 21000,   at: '2026-12-22T13:00', week: 7 },
  w710:    { post: 'Just finished - full roof',           group: 'Long Island Locals',                                 content: 'p1-justfinished',             term: 'g-longislandlocals',               members: 57000,    at: '2026-12-22T10:00', week: 7 },
  w801:    { post: 'Between Christmas and New Year',      group: 'LONG ISLAND MOMS',                                        content: 'p11-newyear',                 term: 'b-270101-p11-newyear',               members: 86000,    at: '2027-01-01T07:00', week: 8, batch: 'b-270101-p11-newyear'},
  w802:    { post: 'Between Christmas and New Year',      group: 'East Moriches Community Posts',                                            content: 'p11-newyear',                 term: 'g-eastmorichesco4',                  members: 20000,    at: '2026-12-28T09:00', week: 8},
  w803:    { post: 'Between Christmas and New Year',      group: 'East Patchogue Community',                                      content: 'p11-newyear',                 term: 'g-eastpatchoguec8',               members: 29000,   at: '2027-01-01T14:00', week: 8, batch: 'b-270101-p11-newyear', via: 'w801'},
  w804:    { post: 'Just finished - full roof',           group: 'Bayport Blue Point Community',                    content: 'p1-justfinished',             term: 'g-bayportbluepointco',               members: 8000,   at: '2026-12-28T06:00', week: 8 },
  w805:    { post: 'Once the crew leaves',                group: 'Best of Hampton Bays, NY',                                          content: 'p2-aftercare',                term: 'g-bestofhamptonb2',                members: 7000,    at: '2026-12-28T13:00', week: 8 },
  w806:    { post: 'Ready for another LI winter',         group: 'Kings Park Community',                            content: 'p3-winterready',              term: 'g-kingsparkcommu4',               members: 28000,   at: '2026-12-28T10:00', week: 8 },
  w807:    { post: 'Most roofers say replace',            group: 'Mastic, Shirley, Mastic beach our community page!',                                content: 'p4-replacerepair',            term: 'g-masticshirleym7',               members: 12000,   at: '2026-12-29T07:00', week: 8 },
  w808:    { post: 'Family / pumpkins',                   group: 'Eastport, Manorville, Speonk, Center.East.Moriches  Community',              content: 'p5-family',                   term: 'g-eastportmanorv3',               members: 35000,    at: '2027-01-01T09:00', week: 8 },
  w809:    { post: 'First company photo',                 group: 'Centereach | Lake Grove Community',                          content: 'p6-crew',                     term: 'g-centereachlakegrov',               members: 3000,   at: '2026-12-29T14:00', week: 8 },
  w810:    { post: 'Four generations in Suffolk',         group: 'Wake Up Lake!',                                    content: 'p7-generations',              term: 'g-wakeuplake',               members: 6000,   at: '2026-12-29T06:00', week: 8 },
  w811:    { post: 'As a father',                         group: 'Center Moriches Community Posts',                                content: 'p8-asafather',                term: 'g-centermoriches',               members: 10000,   at: '2026-12-29T13:00', week: 8 },
  w812:    { post: 'The socks photo',                     group: 'Center Moriches Community News',                                content: 'p9-socks',                    term: 'g-centermorichescomm',               members: 9000,    at: '2026-12-29T10:00', week: 8 },
  w813:    { post: 'Between Christmas and New Year',      group: 'Centereach , NY Community Group, Post Your Ad Here, Post Your Business Here',                                    content: 'p11-newyear',                 term: 'b-261230-p11-newyear',               members: 21000,    at: '2026-12-30T07:00', week: 8, batch: 'b-261230-p11-newyear'},
  w814:    { post: 'Between Christmas and New Year',      group: 'Three Village and Port Jefferson Families',                                    content: 'p11-newyear',                 term: 'g-threevillageandpor',               members: 3000,    at: '2026-12-30T09:00', week: 8, batch: 'b-261230-p11-newyear', via: 'w813'},
  w815:    { post: 'Between Christmas and New Year',      group: 'Lindenhurst Moms',       content: 'p11-newyear',                 term: 'g-lindenhurstmoms',               members: 3000,   at: '2026-12-30T14:00', week: 8, batch: 'b-261230-p11-newyear', via: 'w813'},
  w816:    { post: 'Just finished - full roof',           group: 'Long Island Mom’s and Dad’s',                   content: 'p1-justfinished',             term: 'g-longislandmomsandd',               members: 48000,   at: '2027-01-01T06:00', week: 8 },
  w817:    { post: 'Once the crew leaves',                group: 'Sayville Community NY',                                    content: 'p2-aftercare',                term: 'g-sayvillecommunityn',               members: 15000,    at: '2026-12-30T13:00', week: 8 },
  w818:    { post: 'Ready for another LI winter',         group: 'Sayville Happenings & History',                           content: 'p3-winterready',              term: 'g-x-x102',               members: 9000,   at: '2026-12-30T10:00', week: 8 },
  w819:    { post: 'Most roofers say replace',            group: 'Suffolk County Mom\'s',                             content: 'p4-replacerepair',            term: 'g-suffolkcountymoms',               members: 21000,    at: '2026-12-31T07:00', week: 8 },
  w820:    { post: 'Family / pumpkins',                   group: 'Islip That & This',                                        content: 'p5-family',                   term: 'g-islipthatthis',               members: 6000,    at: '2026-12-31T06:00', week: 8 },
  w821:    { post: 'First company photo',                 group: 'Long Island Homes and Apartments',                          content: 'p6-crew',                     term: 'g-longislandhomesand',               members: 108000,    at: '2026-12-31T13:00', week: 8 },
  w822:    { post: 'Four generations in Suffolk',         group: 'Long Island Marketplace',             content: 'p7-generations',              term: 'g-longislandmarketpl',               members: 121000,    at: '2026-12-31T10:00', week: 8 },

  // Experiment: short, photo-led, no link, ends on a question. Measured in
  // comments rather than clicks, because these carry no link at all.
  x101:    { post: 'Old roof / Southampton',    group: 'Five Towns Area History. (our corner of Long Island, NY)',               content: 'x1-oldroof',      term: 'g-x-x101',          members: 14000,   at: '2026-11-10T07:30', week: 1, experiment: true, photo: 21 },
  x102:    { post: 'Old house / dormers',       group: 'Sayville Happenings & History',     content: 'x2-oldhouse',     term: 'g-x-x102',          members: 9900,    at: '2026-11-11T07:30', week: 1, experiment: true, photo: 22 },
  x103:    { post: 'How long does a roof last', group: 'Huntington Long Island Past and Present', content: 'x4-howlong',  term: 'g-huntingtonpastpresent',          members: 2000,   at: '2026-11-12T07:30', week: 1, experiment: true, photo: 24 },
  x104:    { post: 'Metal roof',                group: 'North Babylon Times & Memories',    content: 'x5-metal',        term: 'g-x-x104',          members: 3900,    at: '2026-11-13T07:30', week: 1, experiment: true, photo: 25 },
  r111601:  { post: 'Thanksgiving table', group: 'Three Village and Port Jefferson Families', content: 'p10-thanksgiving', term: 'g-threevillageandpor', members: 3000, at: '2026-11-16T07:00', week: 0, batch: 'b-261116-p10-thanksgiving', via: 'r1116106'},
  r111602:  { post: 'Four generations in Suffolk', group: 'Long Island Mom’s and Dad’s', content: 'p7-generations', term: 'b-261118-p7-generations', members: 48000, at: '2026-11-18T07:00', week: 0, batch: 'b-261118-p7-generations'},
  r111603:  { post: 'Four generations in Suffolk', group: 'Rocky Point Friends & Rentals', content: 'p7-generations', term: 'b-261118-p7-generations', members: 10000, at: '2026-11-18T07:00', week: 0, batch: 'b-261118-p7-generations', via: 'r111602'},
  r111604:  { post: 'Four generations in Suffolk', group: 'Eastport, Manorville, Speonk, Center.East.Moriches  Community', content: 'p7-generations', term: 'b-261119-p7-generations', members: 35000, at: '2026-11-19T07:00', week: 0, batch: 'b-261119-p7-generations'},
  r111605:  { post: 'As a father', group: 'Mastic, Shirley, Mastic beach our community page!', content: 'p8-asafather', term: 'b-261120-p8-asafather', members: 12000, at: '2026-11-20T07:00', week: 0, batch: 'b-261120-p8-asafather'},
  r111606:  { post: 'First company photo', group: 'Suffolk County Mom\'s', content: 'p6-crew', term: 'g-suffolkcountymoms', members: 21000, at: '2026-11-16T08:00', week: 0, batch: 'b-261116-p6-crew', via: 'r1116141'},
  r111607:  { post: 'Once the crew leaves', group: 'Long Island Chatter buy/sell/trade/barter/ads/less rules Nassau Suffolk', content: 'p2-aftercare', term: 'b-261117-p2-aftercare', members: 22000, at: '2026-11-17T08:00', week: 0, batch: 'b-261117-p2-aftercare'},
  r111608:  { post: 'Ready for another LI winter', group: 'Copiague Mom\'s & Dad\'s group', content: 'p3-winterready', term: 'g-copiaguemomsdadsgr', members: 1000, at: '2026-11-18T08:00', week: 0, batch: 'b-261118-p3-winterready', via: 'w221'},
  r111611:  { post: 'Just finished - full roof', group: 'Hampton Bays Bulletin Board (NOT buy and sell)', content: 'p1-justfinished', term: 'b-261116-p1-justfinished', members: 11000, at: '2026-11-19T09:00', week: 0, batch: 'b-261119-p1-justfinished', via: 'w228'},
  r111612:  { post: 'Thanksgiving table', group: 'Shirley/Mastic/Mastic Beach/Manorville/Moriches Community Group', content: 'p10-thanksgiving', term: 'b-261118-p10-thanksgiving', members: 14000, at: '2026-11-18T09:00', week: 0, batch: 'b-261118-p10-thanksgiving'},
  r111616:  { post: 'As a father', group: 'Brightwaters/Bay Shore Community Uncensored', content: 'p8-asafather', term: 'b-261118-p8-asafather', members: 6000, at: '2026-11-18T10:00', week: 0, batch: 'b-261118-p8-asafather'},
  r111617:  { post: 'First company photo', group: 'Long Island Moms | Things To Do, Events & Local Businesses', content: 'p6-crew', term: 'g-longislandmomsthin', members: 9000, at: '2026-11-17T10:00', week: 0, batch: 'b-261117-p6-crew', via: 'w215'},
  r111621:  { post: 'Most roofers say replace', group: 'Wading River Shoreham Local Businesses', content: 'p4-replacerepair', term: 'b-261116-p4-replacerepair', members: 4000, at: '2026-11-16T12:00', week: 0, batch: 'b-261116-p4-replacerepair'},
  r111622:  { post: 'Just finished - full roof', group: 'SHIRLEY - MASTIC’S - MORICHES - SMITH POINT', content: 'p1-justfinished', term: 'b-261120-p1-justfinished', members: 7000, at: '2026-11-20T12:00', week: 0, batch: 'b-261120-p1-justfinished'},
  r111626:  { post: 'Four generations in Suffolk', group: 'Happy Days In Hampton Bays', content: 'p7-generations', term: 'g-happydaysinhampton', members: 4000, at: '2026-11-16T13:00', week: 0, batch: 'b-261116-p7-generations', via: 'r1116116'},
  r111627:  { post: 'As a father', group: 'Montauk Village', content: 'p8-asafather', term: 'g-montaukvillage', members: 6000, at: '2026-11-17T13:00', week: 0, batch: 'b-261117-p8-asafather', via: 'r111683'},
  r111630:  { post: 'Ready for another LI winter', group: 'Brentwood Cares', content: 'p3-winterready', term: 'g-brentwoodcares', members: 1000, at: '2026-11-20T13:00', week: 0, batch: 'b-261120-p3-winterready', via: 'w239'},
  r111631:  { post: 'The socks photo', group: 'Centerport & Greenlawn Businesses Residents News & Events', content: 'p9-socks', term: 'g-centerportgreenlaw', members: 3000, at: '2026-11-16T14:00', week: 0, batch: 'b-261116-p9-socks', via: 'w209'},
  r111632:  { post: 'Most roofers say replace', group: 'The Other Deer Park NY Community Group!', content: 'p4-replacerepair', term: 'g-theotherdeerparkny', members: 5000, at: '2026-11-17T14:00', week: 0, batch: 'b-261117-p4-replacerepair', via: 'r111678'},
  r111635:  { post: 'Four generations in Suffolk', group: 'EAST YAPHANK/NORTH SHIRLEY COMMUNITY', content: 'p7-generations', term: 'g-eastyaphanknorthsh', members: 1000, at: '2026-11-20T14:00', week: 0, batch: 'b-261120-p7-generations', via: 'w243'},
  r111636:  { post: 'Four generations in Suffolk', group: 'EAST MORICHES / EMO COMMUNITY….UNCENSORED', content: 'p7-generations', term: 'g-eastmorichesemocom', members: 1000, at: '2026-11-16T15:00', week: 0, batch: 'b-261116-p7-generations', via: 'r1116116'},
  r111637:  { post: 'Thanksgiving table', group: 'Centereach | Lake Grove Community', content: 'p10-thanksgiving', term: 'g-centereachlakegrov', members: 3000, at: '2026-11-16T07:00', week: 0, batch: 'b-261116-p10-thanksgiving', via: 'r1116106'},
  r111638:  { post: 'Thanksgiving table', group: 'Long Island Moms and dads group', content: 'p10-thanksgiving', term: 'b-261117-p10-thanksgiving', members: 40000, at: '2026-11-17T07:00', week: 0, batch: 'b-261117-p10-thanksgiving'},
  r111639:  { post: 'As a father', group: 'Miller Place / Sound Beach Community', content: 'p8-asafather', term: 'g-millerplacesoundbe', members: 3000, at: '2026-11-18T07:00', week: 0, batch: 'b-261118-p8-asafather', via: 'r111616'},
  r111640:  { post: 'As a father', group: 'Lindenhurst Moms', content: 'p8-asafather', term: 'b-261119-p8-asafather', members: 3000, at: '2026-11-19T07:00', week: 0, batch: 'b-261119-p8-asafather'},
  r111641:  { post: 'First company photo', group: 'Amityville Families & Community Group', content: 'p6-crew', term: 'g-amityvillefamilies', members: 5000, at: '2026-11-20T07:00', week: 0, batch: 'b-261120-p6-crew', via: 'w242'},
  r111642:  { post: 'Once the crew leaves', group: 'Bayport Blue Point Community', content: 'p2-aftercare', term: 'b-261116-p2-aftercare', members: 8000, at: '2026-11-16T08:00', week: 0, batch: 'b-261116-p2-aftercare'},
  r111643:  { post: 'Ready for another LI winter', group: 'Long Island Community & Neighbors', content: 'p3-winterready', term: 'b-261117-p3-winterready', members: 18000, at: '2026-11-17T08:00', week: 0, batch: 'b-261117-p3-winterready'},
  r111644:  { post: 'The socks photo', group: 'Eastport Peninsula Community Bulletin Board', content: 'p9-socks', term: 'b-261118-p9-socks', members: 5000, at: '2026-11-18T08:00', week: 0, batch: 'b-261118-p9-socks', via: 'r111688'},
  r111647:  { post: 'Four generations in Suffolk', group: 'Commack Community Group', content: 'p7-generations', term: 'b-261116-p7-generations', members: 11000, at: '2026-11-19T09:00', week: 0, batch: 'b-261119-p7-generations', via: 'r111604'},
  r111648:  { post: 'Thanksgiving table', group: 'East Northport mom’s group', content: 'p10-thanksgiving', term: 'g-eastnorthportmomsg', members: 13000, at: '2026-11-17T09:00', week: 0, batch: 'b-261117-p10-thanksgiving', via: 'r111638'},
  r111652:  { post: 'First company photo', group: 'Everything Babylon', content: 'p6-crew', term: 'g-everythingbabylon', members: 6000, at: '2026-11-16T10:00', week: 0, batch: 'b-261116-p6-crew', via: 'r1116141'},
  r111653:  { post: 'Once the crew leaves', group: 'Rocky Point & Local Surrounding Businesses/Organizations', content: 'p2-aftercare', term: 'g-rockypointlocalsur', members: 8000, at: '2026-11-17T10:00', week: 0, batch: 'b-261117-p2-aftercare', via: 'r111607'},
  r111657:  { post: 'Just finished - full roof', group: 'East Islip NY Uncensored', content: 'p1-justfinished', term: 'g-eastislipnyuncenso', members: 4000, at: '2026-11-16T12:00', week: 0, batch: 'b-261116-p1-justfinished', via: 'w201'},
  r111658:  { post: 'Four generations in Suffolk', group: 'North Babylon Community Group', content: 'p7-generations', term: 'g-northbabyloncommun', members: 7000, at: '2026-11-17T12:00', week: 0, batch: 'b-261117-p7-generations', via: 'r1116127'},
  r111661:  { post: 'As a father', group: 'Three Village Dads', content: 'p8-asafather', term: 'g-threevillagedads', members: 2000, at: '2026-11-20T12:00', week: 0, batch: 'b-261120-p8-asafather', via: 'r111605'},
  r111662:  { post: 'As a father', group: 'Three Village Local', content: 'p8-asafather', term: 'g-threevillagelocal', members: 4000, at: '2026-11-16T13:00', week: 0, batch: 'b-261116-p8-asafather', via: 'r1116126'},
  r111663:  { post: 'First company photo', group: 'Port Jefferson, Setauket, Stony Brook & Mount Sinai Recommendations', content: 'p6-crew', term: 'g-portjeffersonsetau', members: 6000, at: '2026-11-17T13:00', week: 0, batch: 'b-261117-p6-crew', via: 'w215'},
  r111666:  { post: 'The socks photo', group: 'Huntington NY', content: 'p9-socks', term: 'g-huntingtonny', members: 1000, at: '2026-11-20T13:00', week: 0, batch: 'b-261120-p9-socks', via: 'w245'},
  r111667:  { post: 'Most roofers say replace', group: 'Mount Sinai Community', content: 'p4-replacerepair', term: 'g-mountsinaicommunit', members: 2000, at: '2026-11-16T14:00', week: 0, batch: 'b-261116-p4-replacerepair', via: 'r111621'},
  r111668:  { post: 'Just finished - full roof', group: 'Shirley, Mastic, Manorville, Middle Island, and Other Suffolk County Moms', content: 'p1-justfinished', term: 'g-shirleymasticmanor', members: 5000, at: '2026-11-17T14:00', week: 0, batch: 'b-261117-p1-justfinished', via: 'w210'},
  r111671:  { post: 'Thanksgiving table', group: 'Northport villagers, NY', content: 'p10-thanksgiving', term: 'g-northportvillagers', members: 1000, at: '2026-11-20T14:00', week: 0, batch: 'b-261120-p10-thanksgiving', via: 'r111681'},
  r111672:  { post: 'As a father', group: 'Babylon Village uncensored', content: 'p8-asafather', term: 'g-babylonvillageunce', members: 1000, at: '2026-11-16T15:00', week: 0, batch: 'b-261116-p8-asafather', via: 'r1116126'},
  r111673:  { post: 'As a father', group: 'All things Port Jeff Village by the people in the Neighborhood', content: 'p8-asafather', term: 'g-allthingsportjeffv', members: 5000, at: '2026-11-17T15:00', week: 0, batch: 'b-261117-p8-asafather', via: 'r111683'},
  r111676:  { post: 'Ready for another LI winter', group: 'Bayport-Blue Point Uncensored', content: 'p3-winterready', term: 'g-bayportbluepointun', members: 1000, at: '2026-11-20T15:00', week: 0, batch: 'b-261120-p3-winterready', via: 'w239'},
  r111677:  { post: 'The socks photo', group: 'Wake Up Lake!', content: 'p9-socks', term: 'g-wakeuplake', members: 6000, at: '2026-11-16T07:00', week: 0, batch: 'b-261116-p9-socks', via: 'w209'},
  r111678:  { post: 'Most roofers say replace', group: 'Seniors on Long Island', content: 'p4-replacerepair', term: 'b-261117-p4-replacerepair', members: 32000, at: '2026-11-17T07:00', week: 0, batch: 'b-261117-p4-replacerepair'},
  r111679:  { post: 'Just finished - full roof', group: 'Kings Park Moms and Dads', content: 'p1-justfinished', term: 'g-kingsparkmomsandda', members: 2000, at: '2026-11-18T07:00', week: 0, batch: 'b-261118-p1-justfinished', via: 'w219'},
  r111680:  { post: 'Four generations in Suffolk', group: 'The OFFICIAL Patchogue-Medford Mom’s & Dad’s Group', content: 'p7-generations', term: 'g-theofficialpatchog', members: 6000, at: '2026-11-19T07:00', week: 0, batch: 'b-261119-p7-generations', via: 'r111604'},
  r111681:  { post: 'Thanksgiving table', group: 'Deer Park NY Community Page', content: 'p10-thanksgiving', term: 'b-261120-p10-thanksgiving', members: 13000, at: '2026-11-20T07:00', week: 0, batch: 'b-261120-p10-thanksgiving'},
  r111682:  { post: 'Thanksgiving table', group: 'Long Island Locals', content: 'p10-thanksgiving', term: 'b-261119-p10-thanksgiving', members: 57000, at: '2026-11-19T08:00', week: 0, batch: 'b-261119-p10-thanksgiving'},
  r111683:  { post: 'As a father', group: 'Patchogue Long Island NY', content: 'p8-asafather', term: 'b-261117-p8-asafather', members: 17000, at: '2026-11-17T08:00', week: 0, batch: 'b-261117-p8-asafather'},
  r111684:  { post: 'As a father', group: 'Patchogue-Medford Community Uncensored', content: 'p8-asafather', term: 'b-261118-p8-asafather', members: 5000, at: '2026-11-18T08:00', week: 0, batch: 'b-261118-p8-asafather', via: 'r111616'},
  r111687:  { post: 'Ready for another LI winter', group: 'Lindenhurst, NY - Events around town', content: 'p3-winterready', term: 'g-lindenhurstnyevent', members: 8000, at: '2026-11-19T09:00', week: 0, batch: 'b-261119-p3-winterready', via: 'r1116111'},
  r111688:  { post: 'The socks photo', group: 'Brentwood', content: 'p9-socks', term: 'b-261118-p9-socks', members: 12000, at: '2026-11-18T09:00', week: 0, batch: 'b-261118-p9-socks'},
  r111692:  { post: 'Thanksgiving table', group: 'Suffolk County Local Business/Service', content: 'p10-thanksgiving', term: 'g-suffolkcountylocal', members: 6000, at: '2026-11-20T10:00', week: 0, batch: 'b-261120-p10-thanksgiving', via: 'r111681'},
  r111693:  { post: 'Thanksgiving table', group: 'Babylon Village Connection', content: 'p10-thanksgiving', term: 'g-babylonvillageconn', members: 8000, at: '2026-11-17T10:00', week: 0, batch: 'b-261117-p10-thanksgiving', via: 'r111638'},
  r111697:  { post: 'Once the crew leaves', group: 'West Babylon NY Moms & Dads', content: 'p2-aftercare', term: 'g-westbabylonnymomsd', members: 4000, at: '2026-11-16T12:00', week: 0, batch: 'b-261116-p2-aftercare', via: 'r111642'},
  r111698:  { post: 'Ready for another LI winter', group: 'Let\'s Talk Village Of Greenport', content: 'p3-winterready', term: 'g-letstalkvillageofg', members: 7000, at: '2026-11-17T12:00', week: 0, batch: 'b-261117-p3-winterready', via: 'r111643'},
  r1116100:  { post: 'Most roofers say replace', group: 'Bonac - East Hampton - Southampton NY', content: 'p4-replacerepair', term: 'b-261119-p4-replacerepair', members: 2000, at: '2026-11-19T12:00', week: 0, batch: 'b-261119-p4-replacerepair', via: 'w213'},
  r1116101:  { post: 'Just finished - full roof', group: 'Holbrook Moms NY', content: 'p1-justfinished', term: 'g-holbrookmomsny', members: 1000, at: '2026-11-20T12:00', week: 0, batch: 'b-261120-p1-justfinished', via: 'r111622'},
  r1116102:  { post: 'Four generations in Suffolk', group: 'Mastic Beach, NY: Support Your Neighbors!', content: 'p7-generations', term: 'g-masticbeachnysuppo', members: 3000, at: '2026-11-16T13:00', week: 0, batch: 'b-261116-p7-generations', via: 'r1116116'},
  r1116103:  { post: 'Thanksgiving table', group: 'Mastics/shirley Moriches Community Group', content: 'p10-thanksgiving', term: 'g-masticsshirley3', members: 5000, at: '2026-11-17T13:00', week: 0, batch: 'b-261117-p10-thanksgiving', via: 'r111638'},
  r1116104:  { post: 'Thanksgiving table', group: 'Patchogue Village Neighbors', content: 'p10-thanksgiving', term: 'g-patchoguevillagene', members: 3000, at: '2026-11-18T13:00', week: 0, batch: 'b-261118-p10-thanksgiving', via: 'r111612'},
  r1116105:  { post: 'As a father', group: 'Huntington Station Community Forum', content: 'p8-asafather', term: 'g-huntingtonstationc', members: 2000, at: '2026-11-19T13:00', week: 0, batch: 'b-261119-p8-asafather', via: 'r111640'},
  r1116106:  { post: 'Thanksgiving table', group: 'Sayville Community NY', content: 'p10-thanksgiving', term: 'b-261116-p10-thanksgiving', members: 15000, at: '2026-11-16T07:00', week: 0, batch: 'b-261116-p10-thanksgiving'},
  r1116107:  { post: 'Thanksgiving table', group: 'Long Island Sell/advertise ANYTHING Legal Only!!', content: 'p10-thanksgiving', term: 'g-longislandselladve', members: 31000, at: '2026-11-17T07:00', week: 0, batch: 'b-261117-p10-thanksgiving', via: 'r111638'},
  r1116108:  { post: 'First company photo', group: 'Lake Grove (NY) & Surrounding Areas Parents', content: 'p6-crew', term: 'g-lakegrovenysurroun', members: 2000, at: '2026-11-18T07:00', week: 0, batch: 'b-261118-p6-crew', via: 'w224'},
  r1116109:  { post: 'First company photo', group: 'Only In Copiague...', content: 'p6-crew', term: 'g-onlyincopiague', members: 3000, at: '2026-11-19T07:00', week: 0, batch: 'b-261119-p6-crew', via: 'w233'},
  r1116110:  { post: 'Once the crew leaves', group: 'Coram Community News', content: 'p2-aftercare', term: 'b-261120-p2-aftercare', members: 8000, at: '2026-11-20T07:00', week: 0, batch: 'b-261120-p2-aftercare'},
  r1116111:  { post: 'Ready for another LI winter', group: 'SAINT JAMES / SMITHTOWN INFORMATIVE GROUP', content: 'p3-winterready', term: 'b-261119-p3-winterready', members: 13000, at: '2026-11-19T08:00', week: 0, batch: 'b-261119-p3-winterready'},
  r1116112:  { post: 'The socks photo', group: 'Commack Moms', content: 'p9-socks', term: 'b-261117-p9-socks', members: 15000, at: '2026-11-17T08:00', week: 0, batch: 'b-261117-p9-socks'},
  r1116113:  { post: 'Most roofers say replace', group: 'Sachem Moms', content: 'p4-replacerepair', term: 'b-261118-p4-replacerepair', members: 5000, at: '2026-11-18T08:00', week: 0, batch: 'b-261118-p4-replacerepair'},
  r1116114:  { post: 'Just finished - full roof', group: 'Lake Ronkonkoma neighborhood & town watch', content: 'p1-justfinished', term: 'g-lakeronkonkomaneig', members: 3000, at: '2026-11-19T08:00', week: 0, batch: 'b-261119-p1-justfinished', via: 'w228'},
  r1116115:  { post: 'As a father', group: 'You know you grew up in Babylon, New York if you remember.........', content: 'p8-asafather', term: 'g-youknowyougrewupin', members: 2000, at: '2026-11-20T08:00', week: 0, batch: 'b-261120-p8-asafather', via: 'r111605'},
  r1116116:  { post: 'Four generations in Suffolk', group: 'Copiague Friends and Neighbors', content: 'p7-generations', term: 'b-261116-p7-generations', members: 7000, at: '2026-11-16T09:00', week: 0, batch: 'b-261116-p7-generations'},
  r1116117:  { post: 'Thanksgiving table', group: 'Hampton Bays community', content: 'p10-thanksgiving', term: 'g-hamptonbayscommuni', members: 10000, at: '2026-11-18T09:00', week: 0, batch: 'b-261118-p10-thanksgiving', via: 'r111612'},
  r1116118:  { post: 'Thanksgiving table', group: 'Wyandanch Stand Up', content: 'p10-thanksgiving', term: 'b-261118-p10-thanksgiving', members: 4000, at: '2026-11-18T09:00', week: 0, batch: 'b-261118-p10-thanksgiving', via: 'r111612'},
  r1116119:  { post: 'First company photo', group: 'West Islip Dads', content: 'p6-crew', term: 'g-westislipdads', members: 2000, at: '2026-11-19T09:00', week: 0, batch: 'b-261119-p6-crew', via: 'w233'},
  r1116120:  { post: 'First company photo', group: 'Riverhead Group', content: 'p6-crew', term: 'g-riverheadgroup', members: 2000, at: '2026-11-20T09:00', week: 0, batch: 'b-261120-p6-crew', via: 'w242'},
  r1116121:  { post: 'Once the crew leaves', group: 'Sayville Community', content: 'p2-aftercare', term: 'g-sayvillecommunity', members: 5000, at: '2026-11-16T10:00', week: 0, batch: 'b-261116-p2-aftercare', via: 'r111642'},
  r1116122:  { post: 'Ready for another LI winter', group: 'Deer Park Community', content: 'p3-winterready', term: 'g-deerparkcommunity', members: 8000, at: '2026-11-17T10:00', week: 0, batch: 'b-261117-p3-winterready', via: 'r111643'},
  r1116123:  { post: 'The socks photo', group: 'What’s Happening in Hampton Bays', content: 'p9-socks', term: 'g-whatshappeninginha', members: 4000, at: '2026-11-18T10:00', week: 0, batch: 'b-261118-p9-socks', via: 'r111688'},
  r1116124:  { post: 'Most roofers say replace', group: 'Smithtown Dads', content: 'p4-replacerepair', term: 'g-smithtowndads', members: 2000, at: '2026-11-19T10:00', week: 0, batch: 'b-261119-p4-replacerepair', via: 'w213'},
  r1116125:  { post: 'Just finished - full roof', group: 'Islip Community', content: 'p1-justfinished', term: 'g-islipcommunity', members: 2000, at: '2026-11-20T10:00', week: 0, batch: 'b-261120-p1-justfinished', via: 'r111622'},
  r1116126:  { post: 'As a father', group: 'Port Jefferson Community NY', content: 'p8-asafather', term: 'b-261116-p8-asafather', members: 4000, at: '2026-11-16T12:00', week: 0, batch: 'b-261116-p8-asafather'},
  r1116127:  { post: 'Four generations in Suffolk', group: 'THREE VILLAGE', content: 'p7-generations', term: 'b-261117-p7-generations', members: 7000, at: '2026-11-17T12:00', week: 0, batch: 'b-261117-p7-generations'},
  r1116128:  { post: 'Thanksgiving table', group: 'Suffolk/Nassau Community', content: 'p10-thanksgiving', term: 'g-suffolknassaucommu', members: 4000, at: '2026-11-18T12:00', week: 0, batch: 'b-261118-p10-thanksgiving', via: 'r111612'},
  r1116129:  { post: 'Thanksgiving table', group: 'Yaphank News', content: 'p10-thanksgiving', term: 'b-261119-p10-thanksgiving', members: 2000, at: '2026-11-19T12:00', week: 0, batch: 'b-261119-p10-thanksgiving', via: 'r111682'},
  r1116130:  { post: 'First company photo', group: 'Bayport-Blue Point Parents, Friends & Family', content: 'p6-crew', term: 'g-bayportbluepointpa', members: 1000, at: '2026-11-20T12:00', week: 0, batch: 'b-261120-p6-crew', via: 'w242'},
  r1116131:  { post: 'First company photo', group: 'Kings Park Downtown', content: 'p6-crew', term: 'g-kingsparkdowntown', members: 3000, at: '2026-11-16T13:00', week: 0, batch: 'b-261116-p6-crew', via: 'r1116141'},
  r1116132:  { post: 'Once the crew leaves', group: 'Mount Sinai-miller place community no rules', content: 'p2-aftercare', term: 'g-mountsinaimillerpl', members: 5000, at: '2026-11-17T13:00', week: 0, batch: 'b-261117-p2-aftercare', via: 'r111607'},
  r1116133:  { post: 'Ready for another LI winter', group: 'Smithtown , St. James , Nesconset and Hauppauge - United We Stand', content: 'p3-winterready', term: 'g-smithtownstjamesne', members: 3000, at: '2026-11-18T13:00', week: 0, batch: 'b-261118-p3-winterready', via: 'w221'},
  r1116134:  { post: 'The socks photo', group: 'Miller Place Community - The Towne Square', content: 'p9-socks', term: 'b-261119-p9-socks', members: 2000, at: '2026-11-19T13:00', week: 0, batch: 'b-261119-p9-socks'},
  r1116135:  { post: 'Most roofers say replace', group: 'Im So Bellport', content: 'p4-replacerepair', term: 'b-261120-p4-replacerepair', members: 1000, at: '2026-11-20T13:00', week: 0, batch: 'b-261120-p4-replacerepair'},
  r1116136:  { post: 'Just finished - full roof', group: 'Miller Place Parents & Communities', content: 'p1-justfinished', term: 'g-millerplaceparents', members: 2000, at: '2026-11-16T14:00', week: 0, batch: 'b-261116-p1-justfinished', via: 'w201'},
  r1116137:  { post: 'As a father', group: 'Babylon Advertising - Town of Babylon - Babylon, NY', content: 'p8-asafather', term: 'g-babylonadvertising', members: 5000, at: '2026-11-17T14:00', week: 0, batch: 'b-261117-p8-asafather', via: 'r111683'},
  r1116138:  { post: 'Four generations in Suffolk', group: 'Growing up Copiague', content: 'p7-generations', term: 'g-growingupcopiague', members: 3000, at: '2026-11-18T14:00', week: 0, batch: 'b-261118-p7-generations', via: 'r111602'},
  r1116139:  { post: 'Thanksgiving table', group: 'Brentwood Neighborhood', content: 'p10-thanksgiving', term: 'g-brentwoodneighborh', members: 2000, at: '2026-11-19T14:00', week: 0, batch: 'b-261119-p10-thanksgiving', via: 'r111682'},
  r1116140:  { post: 'Thanksgiving table', group: 'North Amityville', content: 'p10-thanksgiving', term: 'g-northamityville', members: 1000, at: '2026-11-20T14:00', week: 0, batch: 'b-261120-p10-thanksgiving', via: 'r111681'},
  r1116141:  { post: 'First company photo', group: 'Long Island Marketplace', content: 'p6-crew', term: 'b-261116-p6-crew', members: 121000, at: '2026-11-16T15:00', week: 0, batch: 'b-261116-p6-crew'},
  r1116142:  { post: 'First company photo', group: 'Selden Community-Post your Ads here', content: 'p6-crew', term: 'g-seldencommunitypos', members: 5000, at: '2026-11-20T15:00', week: 0, batch: 'b-261120-p6-crew', via: 'w242'},
  r1116143:  { post: 'Once the crew leaves', group: 'West islip mom’s uncensored', content: 'p2-aftercare', term: 'g-westislipmomsuncen', members: 3000, at: '2026-11-18T15:00', week: 0, batch: 'b-261118-p2-aftercare', via: 'w220'},
  r1116144:  { post: 'Ready for another LI winter', group: 'You Know You Grew Up in Bayport-Blue Point When...', content: 'p3-winterready', term: 'b-261119-p3-winterready', members: 2000, at: '2026-11-19T15:00', week: 0, batch: 'b-261119-p3-winterready', via: 'r1116111'},
  r1116145:  { post: 'The socks photo', group: 'Westhampton Beach Community', content: 'p9-socks', term: 'g-westhamptonbeachco', members: 1000, at: '2026-11-20T15:00', week: 0, batch: 'b-261120-p9-socks', via: 'w245'},
  r113001:  { post: 'Once the crew leaves', group: 'Kings Park Community', content: 'p2-aftercare', term: 'g-kingsparkcommu4', members: 28000, at: '2026-11-30T07:00', week: 0, batch: 'b-261130-p2-aftercare', via: 'r113056'},
  r113002:  { post: 'Once the crew leaves', group: 'Westhampton Beach Area Community LOCAL', content: 'p2-aftercare', term: 'g-westhamptonbeach', members: 4000, at: '2026-12-01T07:00', week: 0, batch: 'b-261201-p2-aftercare', via: 'r113092'},
  r113003:  { post: 'Once the crew leaves', group: 'Rocky Point Friends & Rentals', content: 'p2-aftercare', term: 'g-rockypointfriendsr', members: 10000, at: '2026-12-02T07:00', week: 0, batch: 'b-261202-p2-aftercare', via: 'w420'},
  r113004:  { post: 'Once the crew leaves', group: 'lindenhurst dads and moms', content: 'p2-aftercare', term: 'b-261203-p2-aftercare', members: 5000, at: '2026-12-03T07:00', week: 0, batch: 'b-261203-p2-aftercare'},
  r113005:  { post: 'Most roofers say replace', group: 'Coram Community News', content: 'p4-replacerepair', term: 'b-261204-p4-replacerepair', members: 8000, at: '2026-12-04T07:00', week: 0, batch: 'b-261204-p4-replacerepair'},
  r113006:  { post: 'The socks photo', group: 'Center Moriches Community Posts', content: 'p9-socks', term: 'g-centermoriches', members: 10000, at: '2026-11-30T08:00', week: 0, batch: 'b-261130-p9-socks', via: 'w409'},
  r113007:  { post: 'Ready for another LI winter', group: 'Northport-East Northport Community Forum', content: 'p3-winterready', term: 'g-northporteastnorth', members: 3000, at: '2026-12-01T08:00', week: 0, batch: 'b-261201-p3-winterready', via: 'w412'},
  r113008:  { post: 'Just finished - full roof', group: 'Bay Shore Community Group', content: 'p1-justfinished', term: 'g-bayshorecommunityg', members: 2000, at: '2026-12-02T08:00', week: 0, batch: 'b-261202-p1-justfinished', via: 'w419'},
  r113009:  { post: 'Four generations in Suffolk', group: 'Patchogue-Medford Community Uncensored', content: 'p7-generations', term: 'b-261203-p7-generations', members: 5000, at: '2026-12-03T08:00', week: 0, batch: 'b-261203-p7-generations'},
  r113010:  { post: 'First company photo', group: 'Huntington Station Community Forum', content: 'p6-crew', term: 'g-huntingtonstationc', members: 2000, at: '2026-12-04T08:00', week: 0, batch: 'b-261204-p6-crew', via: 'w442'},
  r113011:  { post: 'As a father', group: 'Wake Up Lake!', content: 'p8-asafather', term: 'g-wakeuplake', members: 6000, at: '2026-11-30T09:00', week: 0, batch: 'b-261130-p8-asafather', via: 'w408'},
  r113012:  { post: 'Once the crew leaves', group: 'EAST MORICHES / EMO COMMUNITY….UNCENSORED', content: 'p2-aftercare', term: 'g-eastmorichesemocom', members: 1000, at: '2026-12-01T09:00', week: 0, batch: 'b-261201-p2-aftercare', via: 'r113092'},
  r113013:  { post: 'Once the crew leaves', group: 'Hampton Bays community', content: 'p2-aftercare', term: 'g-hamptonbayscommuni', members: 10000, at: '2026-12-02T09:00', week: 0, batch: 'b-261202-p2-aftercare', via: 'w420'},
  r113014:  { post: 'Once the crew leaves', group: 'Unofficial Port Jefferson Village Hot Topics', content: 'p2-aftercare', term: 'g-unofficialportjeff', members: 4000, at: '2026-12-03T09:00', week: 0, batch: 'b-261203-p2-aftercare', via: 'r113004'},
  r113015:  { post: 'Once the crew leaves', group: 'You know you grew up in Greenport when...', content: 'p2-aftercare', term: 'g-youknowyougrewupin', members: 2000, at: '2026-12-04T09:00', week: 0, batch: 'b-261204-p2-aftercare', via: 'r1130100'},
  r113016:  { post: 'Most roofers say replace', group: 'Bayport Blue Point Community', content: 'p4-replacerepair', term: 'b-261130-p4-replacerepair', members: 8000, at: '2026-11-30T10:00', week: 0, batch: 'b-261130-p4-replacerepair'},
  r113017:  { post: 'The socks photo', group: 'Long Island Mom’s and Dad’s', content: 'p9-socks', term: 'g-longislandmomsandd', members: 48000, at: '2026-12-01T10:00', week: 0, batch: 'b-261201-p9-socks', via: 'w418'},
  r113018:  { post: 'Ready for another LI winter', group: 'Babylon Village Connection', content: 'p3-winterready', term: 'b-261202-p3-winterready', members: 8000, at: '2026-12-02T10:00', week: 0, batch: 'b-261202-p3-winterready'},
  r113019:  { post: 'Just finished - full roof', group: 'Huntington Nightlife, Long Island NY', content: 'p1-justfinished', term: 'g-huntingtonnightlif', members: 3000, at: '2026-12-03T10:00', week: 0, batch: 'b-261203-p1-justfinished', via: 'w428'},
  r113020:  { post: 'Four generations in Suffolk', group: 'South Shore Long Island Locals', content: 'p7-generations', term: 'b-261204-p7-generations', members: 2000, at: '2026-12-04T10:00', week: 0, batch: 'b-261204-p7-generations'},
  r113021:  { post: 'First company photo', group: 'Commack Community Group', content: 'p6-crew', term: 'g-commackcommunitygr', members: 11000, at: '2026-11-30T12:00', week: 0, batch: 'b-261130-p6-crew', via: 'w406'},
  r113022:  { post: 'As a father', group: 'Bohemia. Ronkonkoma,Sayville, Oakdale And Surrounding Suffolk Communities', content: 'p8-asafather', term: 'b-261201-p8-asafather', members: 24000, at: '2026-12-01T12:00', week: 0, batch: 'b-261201-p8-asafather'},
  r113023:  { post: 'Once the crew leaves', group: 'North Babylon Community Group', content: 'p2-aftercare', term: 'g-northbabyloncommun', members: 7000, at: '2026-12-02T12:00', week: 0, batch: 'b-261202-p2-aftercare', via: 'w420'},
  r113024:  { post: 'Once the crew leaves', group: 'Mastic Beach Community Group', content: 'p2-aftercare', term: 'g-masticbeachcommuni', members: 3000, at: '2026-12-03T12:00', week: 0, batch: 'b-261203-p2-aftercare', via: 'r113004'},
  r113025:  { post: 'Once the crew leaves', group: 'Bay Shore Moms', content: 'p2-aftercare', term: 'g-bayshoremoms', members: 2000, at: '2026-12-04T12:00', week: 0, batch: 'b-261204-p2-aftercare', via: 'r1130100'},
  r113026:  { post: 'Once the crew leaves', group: 'Brightwaters/Bay Shore Community Uncensored', content: 'p2-aftercare', term: 'g-brightwatersbaysho', members: 6000, at: '2026-11-30T13:00', week: 0, batch: 'b-261130-p2-aftercare', via: 'r113056'},
  r113027:  { post: 'Most roofers say replace', group: 'Long Island Community & Neighbors', content: 'p4-replacerepair', term: 'b-261201-p4-replacerepair', members: 18000, at: '2026-12-01T13:00', week: 0, batch: 'b-261201-p4-replacerepair'},
  r113028:  { post: 'The socks photo', group: 'West Islip Community', content: 'p9-socks', term: 'g-westislipcommu4', members: 6000, at: '2026-12-02T13:00', week: 0, batch: 'b-261202-p9-socks', via: 'w427'},
  r113029:  { post: 'Ready for another LI winter', group: 'Only In Copiague...', content: 'p3-winterready', term: 'g-onlyincopiague', members: 3000, at: '2026-12-03T13:00', week: 0, batch: 'b-261203-p3-winterready', via: 'r113084'},
  r113030:  { post: 'Just finished - full roof', group: 'You really know you\'re from Huntington if', content: 'p1-justfinished', term: 'g-youreallyknowyoure', members: 1000, at: '2026-12-04T13:00', week: 0, batch: 'b-261204-p1-justfinished', via: 'w437'},
  r113031:  { post: 'Four generations in Suffolk', group: 'Sayville Community', content: 'p7-generations', term: 'g-sayvillecommunity', members: 5000, at: '2026-11-30T14:00', week: 0, batch: 'b-261130-p7-generations', via: 'w407'},
  r113032:  { post: 'First company photo', group: 'Lake Grove/Centereach Long Island NY', content: 'p6-crew', term: 'g-lakegrovecentereac', members: 14000, at: '2026-12-01T14:00', week: 0, batch: 'b-261201-p6-crew', via: 'w415'},
  r113033:  { post: 'As a father', group: 'Mastics/shirley Moriches Community Group', content: 'p8-asafather', term: 'g-masticsshirley3', members: 5000, at: '2026-12-02T14:00', week: 0, batch: 'b-261202-p8-asafather', via: 'r113088'},
  r113034:  { post: 'Once the crew leaves', group: 'West Islip Dads', content: 'p2-aftercare', term: 'g-westislipdads', members: 2000, at: '2026-12-03T14:00', week: 0, batch: 'b-261203-p2-aftercare', via: 'r113004'},
  r113035:  { post: 'Once the crew leaves', group: 'Im So Bellport', content: 'p2-aftercare', term: 'g-imsobellport', members: 1000, at: '2026-12-04T14:00', week: 0, batch: 'b-261204-p2-aftercare', via: 'r1130100'},
  r113036:  { post: 'Once the crew leaves', group: 'Wading River Shoreham Local Businesses', content: 'p2-aftercare', term: 'g-wadingrivershoreha', members: 4000, at: '2026-11-30T15:00', week: 0, batch: 'b-261130-p2-aftercare', via: 'r113056'},
  r113037:  { post: 'Once the crew leaves', group: 'Deer Park NY Community Page', content: 'p2-aftercare', term: 'g-deerparknycomm5', members: 13000, at: '2026-12-01T15:00', week: 0, batch: 'b-261201-p2-aftercare', via: 'r113092'},
  r113038:  { post: 'Most roofers say replace', group: 'Shirley, Mastic, Manorville, Middle Island, and Other Suffolk County Moms', content: 'p4-replacerepair', term: 'g-shirleymasticmanor', members: 5000, at: '2026-12-02T15:00', week: 0, batch: 'b-261202-p4-replacerepair', via: 'r113093'},
  r113039:  { post: 'The socks photo', group: 'Smithtown Dads', content: 'p9-socks', term: 'g-smithtowndads', members: 2000, at: '2026-12-03T15:00', week: 0, batch: 'b-261203-p9-socks', via: 'r113094'},
  r113040:  { post: 'Ready for another LI winter', group: 'Northport villagers, NY', content: 'p3-winterready', term: 'g-northportvillagers', members: 1000, at: '2026-12-04T15:00', week: 0, batch: 'b-261204-p3-winterready', via: 'r113095'},
  r113041:  { post: 'Just finished - full roof', group: 'Eastport, Manorville, Speonk, Center.East.Moriches  Community', content: 'p1-justfinished', term: 'g-eastportmanorv3', members: 35000, at: '2026-11-30T07:00', week: 0, batch: 'b-261130-p1-justfinished', via: 'w401'},
  r113042:  { post: 'Four generations in Suffolk', group: 'Three Village Local', content: 'p7-generations', term: 'g-threevillagelocal', members: 4000, at: '2026-12-01T07:00', week: 0, batch: 'b-261201-p7-generations', via: 'r113097'},
  r113043:  { post: 'First company photo', group: 'Miller Place / Sound Beach Community', content: 'p6-crew', term: 'g-millerplacesoundbe', members: 3000, at: '2026-12-02T07:00', week: 0, batch: 'b-261202-p6-crew', via: 'w424'},
  r113044:  { post: 'As a father', group: 'Selden Community-Post your Ads here', content: 'p8-asafather', term: 'b-261203-p8-asafather', members: 5000, at: '2026-12-03T07:00', week: 0, batch: 'b-261203-p8-asafather'},
  r113045:  { post: 'Once the crew leaves', group: 'Bonac - East Hampton - Southampton NY', content: 'p2-aftercare', term: 'g-bonaceasthamptonso', members: 2000, at: '2026-12-04T07:00', week: 0, batch: 'b-261204-p2-aftercare', via: 'r1130100'},
  r113046:  { post: 'Once the crew leaves', group: 'Mastic, Shirley, Mastic beach our community page!', content: 'p2-aftercare', term: 'g-masticshirleym7', members: 12000, at: '2026-11-30T08:00', week: 0, batch: 'b-261130-p2-aftercare', via: 'r113056'},
  r113047:  { post: 'Once the crew leaves', group: 'Centerport & Greenlawn Businesses Residents News & Events', content: 'p2-aftercare', term: 'g-centerportgreenlaw', members: 3000, at: '2026-12-01T08:00', week: 0, batch: 'b-261201-p2-aftercare', via: 'r113092'},
  r113048:  { post: 'Once the crew leaves', group: 'Copiague Mom\'s & Dad\'s group', content: 'p2-aftercare', term: 'g-copiaguemomsdadsgr', members: 1000, at: '2026-12-02T08:00', week: 0, batch: 'b-261202-p2-aftercare', via: 'w420'},
  r113049:  { post: 'Most roofers say replace', group: 'Sayville Moms and Dads', content: 'p4-replacerepair', term: 'b-261203-p4-replacerepair', members: 4000, at: '2026-12-03T08:00', week: 0, batch: 'b-261203-p4-replacerepair'},
  r113050:  { post: 'The socks photo', group: 'Dix Hills Moms', content: 'p9-socks', term: 'b-261204-p9-socks', members: 2000, at: '2026-12-04T08:00', week: 0, batch: 'b-261204-p9-socks'},
  r113051:  { post: 'Ready for another LI winter', group: 'Lindenhurst Moms', content: 'p3-winterready', term: 'g-lindenhurstmoms', members: 3000, at: '2026-11-30T09:00', week: 0, batch: 'b-261130-p3-winterready', via: 'w403'},
  r113052:  { post: 'Just finished - full roof', group: 'Babylon Village uncensored', content: 'p1-justfinished', term: 'g-babylonvillageunce', members: 1000, at: '2026-12-01T09:00', week: 0, batch: 'b-261201-p1-justfinished', via: 'w410'},
  r113053:  { post: 'Four generations in Suffolk', group: 'The People Of Lindenhurst', content: 'p7-generations', term: 'b-261202-p7-generations', members: 9000, at: '2026-12-02T09:00', week: 0, batch: 'b-261202-p7-generations'},
  r113054:  { post: 'First company photo', group: 'What’s Happening in Hampton Bays', content: 'p6-crew', term: 'g-whatshappeninginha', members: 4000, at: '2026-12-03T09:00', week: 0, batch: 'b-261203-p6-crew', via: 'w433'},
  r113055:  { post: 'As a father', group: 'You Know You Grew Up in Bayport-Blue Point When...', content: 'p8-asafather', term: 'b-261204-p8-asafather', members: 2000, at: '2026-12-04T09:00', week: 0, batch: 'b-261204-p8-asafather'},
  r113056:  { post: 'Once the crew leaves', group: 'Long Island Locals', content: 'p2-aftercare', term: 'b-261130-p2-aftercare', members: 57000, at: '2026-11-30T10:00', week: 0, batch: 'b-261130-p2-aftercare'},
  r113057:  { post: 'Once the crew leaves', group: 'Long Island Moms and dads group', content: 'p2-aftercare', term: 'g-longislandmomsandd', members: 40000, at: '2026-12-01T10:00', week: 0, batch: 'b-261201-p2-aftercare', via: 'r113092'},
  r113058:  { post: 'Once the crew leaves', group: 'Deer Park Community', content: 'p2-aftercare', term: 'g-deerparkcommunity', members: 8000, at: '2026-12-02T10:00', week: 0, batch: 'b-261202-p2-aftercare', via: 'w420'},
  r113059:  { post: 'Once the crew leaves', group: 'Patchogue Village Neighbors', content: 'p2-aftercare', term: 'g-patchoguevillagene', members: 3000, at: '2026-12-03T10:00', week: 0, batch: 'b-261203-p2-aftercare', via: 'r113004'},
  r113060:  { post: 'Most roofers say replace', group: 'Riverhead Group', content: 'p4-replacerepair', term: 'g-riverheadgroup', members: 2000, at: '2026-12-04T10:00', week: 0, batch: 'b-261204-p4-replacerepair', via: 'r113005'},
  r113061:  { post: 'The socks photo', group: 'Hampton Bays Bulletin Board (NOT buy and sell)', content: 'p9-socks', term: 'g-hamptonbaysbulleti', members: 11000, at: '2026-11-30T12:00', week: 0, batch: 'b-261130-p9-socks', via: 'w409'},
  r113062:  { post: 'Ready for another LI winter', group: 'Long Island, NY Business Owners', content: 'p3-winterready', term: 'g-longislandnybu3', members: 27000, at: '2026-12-01T12:00', week: 0, batch: 'b-261201-p3-winterready', via: 'w412'},
  r113063:  { post: 'Just finished - full roof', group: 'Let\'s Talk Village Of Greenport', content: 'p1-justfinished', term: 'g-letstalkvillageofg', members: 7000, at: '2026-12-02T12:00', week: 0, batch: 'b-261202-p1-justfinished', via: 'w419'},
  r113064:  { post: 'Four generations in Suffolk', group: 'You\'re probably from Sayville if', content: 'p7-generations', term: 'g-youreprobablyfroms', members: 3000, at: '2026-12-03T12:00', week: 0, batch: 'b-261203-p7-generations', via: 'r113009'},
  r113065:  { post: 'First company photo', group: 'Three Village Dads', content: 'p6-crew', term: 'g-threevillagedads', members: 2000, at: '2026-12-04T12:00', week: 0, batch: 'b-261204-p6-crew', via: 'w442'},
  r113066:  { post: 'As a father', group: 'Everything Babylon', content: 'p8-asafather', term: 'g-everythingbabylon', members: 6000, at: '2026-11-30T13:00', week: 0, batch: 'b-261130-p8-asafather', via: 'w408'},
  r113067:  { post: 'Once the crew leaves', group: 'Patchogue Long Island NY', content: 'p2-aftercare', term: 'g-patchoguelongislan', members: 17000, at: '2026-12-01T13:00', week: 0, batch: 'b-261201-p2-aftercare', via: 'r113092'},
  r113068:  { post: 'Once the crew leaves', group: 'Montauk Village', content: 'p2-aftercare', term: 'g-montaukvillage', members: 6000, at: '2026-12-02T13:00', week: 0, batch: 'b-261202-p2-aftercare', via: 'w420'},
  r113069:  { post: 'Once the crew leaves', group: 'Eastport Community Bulletin Board', content: 'p2-aftercare', term: 'g-eastportcommunityb', members: 3000, at: '2026-12-03T13:00', week: 0, batch: 'b-261203-p2-aftercare', via: 'r113004'},
  r113070:  { post: 'Once the crew leaves', group: 'Brentwood Cares', content: 'p2-aftercare', term: 'g-brentwoodcares', members: 1000, at: '2026-12-04T13:00', week: 0, batch: 'b-261204-p2-aftercare', via: 'r1130100'},
  r113071:  { post: 'Most roofers say replace', group: 'Islip Town New York Community', content: 'p4-replacerepair', term: 'g-isliptownnewyorkco', members: 5000, at: '2026-11-30T14:00', week: 0, batch: 'b-261130-p4-replacerepair', via: 'r113016'},
  r113072:  { post: 'The socks photo', group: 'Neighbors of Quogue Westhampton Speonk Remsenburg Eastport Manorville', content: 'p9-socks', term: 'g-neighborsofquoguew', members: 14000, at: '2026-12-01T14:00', week: 0, batch: 'b-261201-p9-socks', via: 'w418'},
  r113073:  { post: 'Ready for another LI winter', group: 'Mount Sinai-miller place community no rules', content: 'p3-winterready', term: 'g-mountsinaimillerpl', members: 5000, at: '2026-12-02T14:00', week: 0, batch: 'b-261202-p3-winterready', via: 'r113018'},
  r113074:  { post: 'Just finished - full roof', group: 'Brentwood Parents & Alumni (Brentwood, New York)', content: 'p1-justfinished', term: 'g-brentwoodparentsal', members: 3000, at: '2026-12-03T14:00', week: 0, batch: 'b-261203-p1-justfinished', via: 'w428'},
  r113075:  { post: 'Four generations in Suffolk', group: 'COMMACK MOMS & DADS', content: 'p7-generations', term: 'g-commackmomsdads', members: 1000, at: '2026-12-04T14:00', week: 0, batch: 'b-261204-p7-generations', via: 'r113020'},
  r113076:  { post: 'First company photo', group: 'West Babylon NY Moms & Dads', content: 'p6-crew', term: 'g-westbabylonnymomsd', members: 4000, at: '2026-11-30T15:00', week: 0, batch: 'b-261130-p6-crew', via: 'w406'},
  r113077:  { post: 'As a father', group: 'East Northport mom’s group', content: 'p8-asafather', term: 'g-eastnorthportmomsg', members: 13000, at: '2026-12-01T15:00', week: 0, batch: 'b-261201-p8-asafather', via: 'r113022'},
  r113078:  { post: 'Once the crew leaves', group: 'The Other Deer Park NY Community Group!', content: 'p2-aftercare', term: 'g-theotherdeerparkny', members: 5000, at: '2026-12-02T15:00', week: 0, batch: 'b-261202-p2-aftercare', via: 'w420'},
  r113079:  { post: 'Once the crew leaves', group: 'North Babylon Parents', content: 'p2-aftercare', term: 'g-northbabylonparent', members: 2000, at: '2026-12-03T15:00', week: 0, batch: 'b-261203-p2-aftercare', via: 'r113004'},
  r113080:  { post: 'Once the crew leaves', group: 'North Amityville', content: 'p2-aftercare', term: 'g-northamityville', members: 1000, at: '2026-12-04T15:00', week: 0, batch: 'b-261204-p2-aftercare', via: 'r1130100'},
  r113081:  { post: 'Once the crew leaves', group: 'Center Moriches Community News', content: 'p2-aftercare', term: 'g-centermorichescomm', members: 9000, at: '2026-11-30T07:00', week: 0, batch: 'b-261130-p2-aftercare', via: 'r113056'},
  r113082:  { post: 'Most roofers say replace', group: 'Mastic Beach, NY: Support Your Neighbors!', content: 'p4-replacerepair', term: 'g-masticbeachnysuppo', members: 3000, at: '2026-12-01T07:00', week: 0, batch: 'b-261201-p4-replacerepair', via: 'r113027'},
  r113083:  { post: 'The socks photo', group: 'Kings Park Moms and Dads', content: 'p9-socks', term: 'g-kingsparkmomsandda', members: 2000, at: '2026-12-02T07:00', week: 0, batch: 'b-261202-p9-socks', via: 'w427'},
  r113084:  { post: 'Ready for another LI winter', group: 'All things Port Jeff Village by the people in the Neighborhood', content: 'p3-winterready', term: 'b-261203-p3-winterready', members: 5000, at: '2026-12-03T07:00', week: 0, batch: 'b-261203-p3-winterready'},
  r113085:  { post: 'Just finished - full roof', group: 'Yaphank News', content: 'p1-justfinished', term: 'g-yaphanknews', members: 2000, at: '2026-12-04T07:00', week: 0, batch: 'b-261204-p1-justfinished', via: 'w437'},
  r113086:  { post: 'Four generations in Suffolk', group: 'Three Village and Port Jefferson Families', content: 'p7-generations', term: 'g-threevillageandpor', members: 3000, at: '2026-11-30T08:00', week: 0, batch: 'b-261130-p7-generations', via: 'w407'},
  r113087:  { post: 'First company photo', group: 'Mount Sinai Community', content: 'p6-crew', term: 'g-mountsinaicommunit', members: 2000, at: '2026-12-01T08:00', week: 0, batch: 'b-261201-p6-crew', via: 'w415'},
  r113088:  { post: 'As a father', group: 'The Deer Park We all remember', content: 'p8-asafather', term: 'b-261202-p8-asafather', members: 12000, at: '2026-12-02T08:00', week: 0, batch: 'b-261202-p8-asafather'},
  r113089:  { post: 'Once the crew leaves', group: 'Sachem Moms', content: 'p2-aftercare', term: 'g-sachemmoms', members: 5000, at: '2026-12-03T08:00', week: 0, batch: 'b-261203-p2-aftercare', via: 'r113004'},
  r113090:  { post: 'Once the crew leaves', group: 'Miller Place Community - The Towne Square', content: 'p2-aftercare', term: 'g-millerplacecommuni', members: 2000, at: '2026-12-04T08:00', week: 0, batch: 'b-261204-p2-aftercare', via: 'r1130100'},
  r113091:  { post: 'Once the crew leaves', group: 'Islip That & This', content: 'p2-aftercare', term: 'g-islipthatthis', members: 6000, at: '2026-11-30T09:00', week: 0, batch: 'b-261130-p2-aftercare', via: 'r113056'},
  r113092:  { post: 'Once the crew leaves', group: 'Long Island Marketplace', content: 'p2-aftercare', term: 'b-261201-p2-aftercare', members: 121000, at: '2026-12-01T09:00', week: 0, batch: 'b-261201-p2-aftercare'},
  r113093:  { post: 'Most roofers say replace', group: 'Huntington, New York', content: 'p4-replacerepair', term: 'b-261202-p4-replacerepair', members: 8000, at: '2026-12-02T09:00', week: 0, batch: 'b-261202-p4-replacerepair'},
  r113094:  { post: 'The socks photo', group: 'Smithtown NY community page', content: 'p9-socks', term: 'b-261203-p9-socks', members: 4000, at: '2026-12-03T09:00', week: 0, batch: 'b-261203-p9-socks'},
  r113095:  { post: 'Ready for another LI winter', group: 'Huntington Long Island Past and Present', content: 'p3-winterready', term: 'b-261204-p3-winterready', members: 2000, at: '2026-12-04T09:00', week: 0, batch: 'b-261204-p3-winterready'},
  r113096:  { post: 'Just finished - full roof', group: 'SAINT JAMES / SMITHTOWN INFORMATIVE GROUP', content: 'p1-justfinished', term: 'g-saintjamessmithtow', members: 13000, at: '2026-11-30T10:00', week: 0, batch: 'b-261130-p1-justfinished', via: 'w401'},
  r113097:  { post: 'Four generations in Suffolk', group: 'Seniors on Long Island', content: 'p7-generations', term: 'b-261201-p7-generations', members: 32000, at: '2026-12-01T10:00', week: 0, batch: 'b-261201-p7-generations'},
  r113098:  { post: 'First company photo', group: 'SHIRLEY - MASTIC’S - MORICHES - SMITH POINT', content: 'p6-crew', term: 'g-shirleymasticsmori', members: 7000, at: '2026-12-02T10:00', week: 0, batch: 'b-261202-p6-crew', via: 'w424'},
  r113099:  { post: 'As a father', group: 'Smithtown , St. James , Nesconset and Hauppauge - United We Stand', content: 'p8-asafather', term: 'g-smithtownstjamesne', members: 3000, at: '2026-12-03T10:00', week: 0, batch: 'b-261203-p8-asafather', via: 'r113044'},
  r1130100:  { post: 'Once the crew leaves', group: 'Mastic Beach Uncensored', content: 'p2-aftercare', term: 'b-261204-p2-aftercare', members: 2000, at: '2026-12-04T10:00', week: 0, batch: 'b-261204-p2-aftercare'},
  r1130101:  { post: 'Once the crew leaves', group: 'Lindenhurst, NY - Events around town', content: 'p2-aftercare', term: 'g-lindenhurstnyevent', members: 8000, at: '2026-11-30T12:00', week: 0, batch: 'b-261130-p2-aftercare', via: 'r113056'},
  r1130102:  { post: 'Once the crew leaves', group: 'WHAT\'S UP MONTAUK', content: 'p2-aftercare', term: 'g-whatsupmontauk3', members: 22000, at: '2026-12-01T12:00', week: 0, batch: 'b-261201-p2-aftercare', via: 'r113092'},
  r1130103:  { post: 'Once the crew leaves', group: 'THREE VILLAGE', content: 'p2-aftercare', term: 'g-threevillage', members: 7000, at: '2026-12-02T12:00', week: 0, batch: 'b-261202-p2-aftercare', via: 'w420'},
  r1130104:  { post: 'Most roofers say replace', group: 'Growing up Copiague', content: 'p4-replacerepair', term: 'g-growingupcopiague', members: 3000, at: '2026-12-03T12:00', week: 0, batch: 'b-261203-p4-replacerepair', via: 'r113049'},
  r1130105:  { post: 'The socks photo', group: 'Holbrook Moms NY', content: 'p9-socks', term: 'g-holbrookmomsny', members: 1000, at: '2026-12-04T12:00', week: 0, batch: 'b-261204-p9-socks', via: 'r113050'},
  r120701:  { post: 'Most roofers say replace', group: 'LONG ISLAND MOMS', content: 'p4-replacerepair', term: 'b-261207-p4-replacerepair', members: 86000, at: '2026-12-07T07:00', week: 0, batch: 'b-261207-p4-replacerepair'},
  r120702:  { post: 'Most roofers say replace', group: 'Centereach , NY Community Group, Post Your Ad Here, Post Your Business Here', content: 'p4-replacerepair', term: 'g-centereachnyco4', members: 21000, at: '2026-12-08T07:00', week: 0, batch: 'b-261208-p4-replacerepair', via: 'r120792'},
  r120703:  { post: 'Most roofers say replace', group: 'East Patchogue Community', content: 'p4-replacerepair', term: 'b-261209-p4-replacerepair', members: 29000, at: '2026-12-09T07:00', week: 0, batch: 'b-261209-p4-replacerepair'},
  r120704:  { post: 'Most roofers say replace', group: 'bayport Neighborhood community', content: 'p4-replacerepair', term: 'g-bayportneighborhoo', members: 979, at: '2026-12-10T07:00', week: 0 },
  r120706:  { post: 'The socks photo', group: 'Best of Hampton Bays, NY', content: 'p9-socks', term: 'b-261207-p9-socks', members: 7000, at: '2026-12-07T08:00', week: 0, batch: 'b-261207-p9-socks'},
  r120707:  { post: 'Just finished - full roof', group: 'Kings Park Downtown', content: 'p1-justfinished', term: 'g-kingsparkdowntown', members: 3000, at: '2026-12-08T08:00', week: 0, batch: 'b-261208-p1-justfinished', via: 'w510'},
  r120708:  { post: 'Four generations in Suffolk', group: 'Copiague Mom\'s & Dad\'s group', content: 'p7-generations', term: 'g-copiaguemomsdadsgr', members: 1000, at: '2026-12-09T08:00', week: 0, batch: 'b-261209-p7-generations', via: 'w525'},
  r120711:  { post: 'Once the crew leaves', group: 'SAINT JAMES / SMITHTOWN INFORMATIVE GROUP', content: 'p2-aftercare', term: 'b-261207-p2-aftercare', members: 13000, at: '2026-12-11T09:00', week: 0},
  r120712:  { post: 'Most roofers say replace', group: 'EAST MORICHES / EMO COMMUNITY….UNCENSORED', content: 'p4-replacerepair', term: 'g-eastmorichesemocom', members: 1000, at: '2026-12-08T09:00', week: 0, batch: 'b-261208-p4-replacerepair', via: 'r120792'},
  r120716:  { post: 'Ready for another LI winter', group: 'Long Island Locals', content: 'p3-winterready', term: 'b-261211-p3-winterready', members: 57000, at: '2026-12-11T10:00', week: 0, batch: 'b-261211-p3-winterready'},
  r120721:  { post: 'As a father', group: 'Lindenhurst, NY - Events around town', content: 'p8-asafather', term: 'b-261211-p8-asafather', members: 8000, at: '2026-12-11T12:00', week: 0, batch: 'b-261211-p8-asafather'},
  r120726:  { post: 'Most roofers say replace', group: 'Everything Babylon', content: 'p4-replacerepair', term: 'g-everythingbabylon', members: 6000, at: '2026-12-07T13:00', week: 0, batch: 'b-261207-p4-replacerepair', via: 'r120701'},
  r120731:  { post: 'First company photo', group: 'Wading River Shoreham Local Businesses', content: 'p6-crew', term: 'g-wadingrivershoreha', members: 4000, at: '2026-12-11T14:00', week: 0, batch: 'b-261211-p6-crew', via: 'w542'},
  r120736:  { post: 'Most roofers say replace', group: 'Port Jefferson Community NY', content: 'p4-replacerepair', term: 'g-portjeffersoncommu', members: 4000, at: '2026-12-07T15:00', week: 0, batch: 'b-261207-p4-replacerepair', via: 'r120701'},
  r120741:  { post: 'Four generations in Suffolk', group: 'Kings Park Community', content: 'p7-generations', term: 'b-261207-p7-generations', members: 28000, at: '2026-12-07T07:00', week: 0, batch: 'b-261207-p7-generations'},
  r120742:  { post: 'First company photo', group: 'Three Village Local', content: 'p6-crew', term: 'b-261208-p6-crew', members: 4000, at: '2026-12-08T07:00', week: 0, batch: 'b-261208-p6-crew'},
  r120743:  { post: 'As a father', group: 'Sayville Happenings & History', content: 'p8-asafather', term: 'b-261209-p8-asafather', members: 9000, at: '2026-12-09T07:00', week: 0, batch: 'b-261209-p8-asafather'},
  r120746:  { post: 'Most roofers say replace', group: 'Center Moriches Community Posts', content: 'p4-replacerepair', term: 'g-centermoriches', members: 10000, at: '2026-12-07T08:00', week: 0, batch: 'b-261207-p4-replacerepair', via: 'r120701'},
  r120747:  { post: 'Most roofers say replace', group: 'Centerport & Greenlawn Businesses Residents News & Events', content: 'p4-replacerepair', term: 'g-centerportgreenlaw', members: 3000, at: '2026-12-08T08:00', week: 0, batch: 'b-261208-p4-replacerepair', via: 'r120792'},
  r120748:  { post: 'Most roofers say replace', group: 'Bay Shore Community Group', content: 'p4-replacerepair', term: 'g-bayshorecommunityg', members: 2000, at: '2026-12-09T08:00', week: 0, batch: 'b-261209-p4-replacerepair', via: 'r120703'},
  r120751:  { post: 'Just finished - full roof', group: 'Centereach | Lake Grove Community', content: 'p1-justfinished', term: 'g-centereachlakegrov', members: 3000, at: '2026-12-07T09:00', week: 0, batch: 'b-261207-p1-justfinished', via: 'w501'},
  r120752:  { post: 'Four generations in Suffolk', group: 'Commack Connected', content: 'p7-generations', term: 'g-commackconnected', members: 1000, at: '2026-12-08T09:00', week: 0, batch: 'b-261208-p7-generations', via: 'w516'},
  r120756:  { post: 'Most roofers say replace', group: 'Eyes on Lindy', content: 'p4-replacerepair', term: 'g-eyesonlindy', members: 12000, at: '2026-12-11T10:00', week: 0},
  r120761:  { post: 'The socks photo', group: 'Copiague Friends and Neighbors', content: 'p9-socks', term: 'g-copiaguefriendsand', members: 7000, at: '2026-12-07T12:00', week: 0, batch: 'b-261207-p9-socks', via: 'r120706'},
  r120766:  { post: 'Once the crew leaves', group: 'Islip Town New York Community', content: 'p2-aftercare', term: 'b-261210-p2-aftercare', members: 5000, at: '2026-12-10T13:00', week: 0, batch: 'b-261210-p2-aftercare'},
  r120771:  { post: 'Ready for another LI winter', group: 'East Islip NY Uncensored', content: 'p3-winterready', term: 'g-eastislipnyuncenso', members: 4000, at: '2026-12-07T14:00', week: 0},
  r120776:  { post: 'As a father', group: 'Happy Days In Hampton Bays', content: 'p8-asafather', term: 'g-happydaysinhampton', members: 4000, at: '2026-12-07T15:00', week: 0},
  r120781:  { post: 'Most roofers say replace', group: 'East Moriches Community Posts', content: 'p4-replacerepair', term: 'g-eastmorichesco4', members: 20000, at: '2026-12-07T07:00', week: 0, batch: 'b-261207-p4-replacerepair', via: 'r120701'},
  r120782:  { post: 'Ready for another LI winter', group: 'Mastic Beach, NY: Support Your Neighbors!', content: 'p3-winterready', term: 'g-masticbeachnysuppo', members: 3000, at: '2026-12-08T07:00', week: 0, batch: 'b-261208-p3-winterready', via: 'w512'},
  r120783:  { post: 'The socks photo', group: 'Lake Grove (NY) & Surrounding Areas Parents', content: 'p9-socks', term: 'g-lakegrovenysurroun', members: 2000, at: '2026-12-09T07:00', week: 0, batch: 'b-261209-p9-socks', via: 'w527'},
  r120786:  { post: 'First company photo', group: 'Three Village and Port Jefferson Families', content: 'p6-crew', term: 'g-threevillageandpor', members: 3000, at: '2026-12-07T08:00', week: 0, batch: 'b-261207-p6-crew', via: 'w506'},
  r120787:  { post: 'As a father', group: 'Mount Sinai Community', content: 'p8-asafather', term: 'g-mountsinaicommunit', members: 2000, at: '2026-12-08T08:00', week: 0, batch: 'b-261208-p8-asafather', via: 'w517'},
  r120788:  { post: 'Once the crew leaves', group: 'Selden Community-Post your Ads here', content: 'p2-aftercare', term: 'b-261209-p2-aftercare', members: 5000, at: '2026-12-09T08:00', week: 0, batch: 'b-261209-p2-aftercare'},
  r120791:  { post: 'Most roofers say replace', group: 'Wake Up Lake!', content: 'p4-replacerepair', term: 'g-wakeuplake', members: 6000, at: '2026-12-07T09:00', week: 0, batch: 'b-261207-p4-replacerepair', via: 'r120701'},
  r120792:  { post: 'Most roofers say replace', group: 'Long Island Mom’s and Dad’s', content: 'p4-replacerepair', term: 'b-261208-p4-replacerepair', members: 48000, at: '2026-12-08T09:00', week: 0, batch: 'b-261208-p4-replacerepair'},
  r120796:  { post: 'Four generations in Suffolk', group: 'Hampton Bays Bulletin Board (NOT buy and sell)', content: 'p7-generations', term: 'b-261211-p7-generations', members: 11000, at: '2026-12-11T10:00', week: 0, batch: 'b-261211-p7-generations'},
  r1207101:  { post: 'Most roofers say replace', group: 'Brightwaters/Bay Shore Community Uncensored', content: 'p4-replacerepair', term: 'g-brightwatersbaysho', members: 6000, at: '2026-12-07T12:00', week: 0, batch: 'b-261207-p4-replacerepair', via: 'r120701'},
  r1207102:  { post: 'Most roofers say replace', group: 'Deer Park NY Community Page', content: 'p4-replacerepair', term: 'g-deerparknycomm5', members: 13000, at: '2026-12-08T12:00', week: 0, batch: 'b-261208-p4-replacerepair', via: 'r120792'},
  r1207103:  { post: 'Most roofers say replace', group: 'Bayport-Blue Point Uncensored', content: 'p4-replacerepair', term: 'g-bayportbluepointun', members: 1000, at: '2026-12-09T12:00', week: 0, batch: 'b-261209-p4-replacerepair', via: 'r120703'},
  r1207104:  { post: 'Ready for another LI winter', group: 'Shoreham/Wading River Friends', content: 'p3-winterready', term: 'g-shorehamwadingrive', members: 543, at: '2026-12-10T12:00', week: 0 },
  r121401:  { post: 'Just finished - full roof', group: 'Wake Up Lake!', content: 'p1-justfinished', term: 'g-wakeuplake', members: 6000, at: '2026-12-14T07:00', week: 0, batch: 'b-261214-p1-justfinished', via: 'w601'},
  r121402:  { post: 'Just finished - full roof', group: 'Centerport & Greenlawn Businesses Residents News & Events', content: 'p1-justfinished', term: 'g-centerportgreenlaw', members: 3000, at: '2026-12-15T07:00', week: 0, batch: 'b-261215-p1-justfinished', via: 'r121492'},
  r121403:  { post: 'Just finished - full roof', group: 'Lake Grove (NY) & Surrounding Areas Parents', content: 'p1-justfinished', term: 'g-lakegrovenysurroun', members: 2000, at: '2026-12-16T07:00', week: 0, batch: 'b-261216-p1-justfinished', via: 'r121413'},
  r121404:  { post: 'Just finished - full roof', group: 'lindenhurst dads and moms', content: 'p1-justfinished', term: 'b-261217-p1-justfinished', members: 5000, at: '2026-12-17T07:00', week: 0, batch: 'b-261217-p1-justfinished', via: 'r121491'},
  r121405:  { post: 'Ready for another LI winter', group: 'Coram Community News', content: 'p3-winterready', term: 'b-261218-p3-winterready', members: 8000, at: '2026-12-18T07:00', week: 0, batch: 'b-261218-p3-winterready'},
  r121406:  { post: 'The socks photo', group: 'Kings Park Community', content: 'p9-socks', term: 'b-261214-p9-socks', members: 28000, at: '2026-12-14T08:00', week: 0, batch: 'b-261214-p9-socks'},
  r121407:  { post: 'Four generations in Suffolk', group: 'Babylon Village uncensored', content: 'p7-generations', term: 'g-babylonvillageunce', members: 1000, at: '2026-12-15T08:00', week: 0, batch: 'b-261215-p7-generations', via: 'r121462'},
  r121408:  { post: 'First company photo', group: 'Bay Shore Community Group', content: 'p6-crew', term: 'g-bayshorecommunityg', members: 2000, at: '2026-12-16T08:00', week: 0, batch: 'b-261216-p6-crew', via: 'r121463'},
  r121409:  { post: 'As a father', group: 'Eastport Peninsula Community Bulletin Board', content: 'p8-asafather', term: 'b-261217-p8-asafather', members: 5000, at: '2026-12-17T08:00', week: 0, batch: 'b-261217-p8-asafather'},
  r121410:  { post: 'Once the crew leaves', group: 'Yaphank News', content: 'p2-aftercare', term: 'b-261218-p2-aftercare', members: 2000, at: '2026-12-18T08:00', week: 0, batch: 'b-261218-p2-aftercare'},
  r121411:  { post: 'Most roofers say replace', group: 'Center Moriches Community News', content: 'p4-replacerepair', term: 'b-261214-p4-replacerepair', members: 9000, at: '2026-12-14T09:00', week: 0, batch: 'b-261214-p4-replacerepair'},
  r121412:  { post: 'Just finished - full roof', group: 'EAST MORICHES / EMO COMMUNITY….UNCENSORED', content: 'p1-justfinished', term: 'g-eastmorichesemocom', members: 1000, at: '2026-12-15T09:00', week: 0, batch: 'b-261215-p1-justfinished', via: 'r121492'},
  r121413:  { post: 'Just finished - full roof', group: 'Hampton Bays community', content: 'p1-justfinished', term: 'b-261216-p1-justfinished', members: 10000, at: '2026-12-16T09:00', week: 0, batch: 'b-261216-p1-justfinished'},
  r121414:  { post: 'Just finished - full roof', group: 'Sayville Moms and Dads', content: 'p1-justfinished', term: 'g-sayvillemomsanddad', members: 4000, at: '2026-12-17T09:00', week: 0, batch: 'b-261217-p1-justfinished', via: 'r121491'},
  r121415:  { post: 'Just finished - full roof', group: 'Miller Place Community - The Towne Square', content: 'p1-justfinished', term: 'g-millerplacecommuni', members: 2000, at: '2026-12-18T09:00', week: 0, batch: 'b-261218-p1-justfinished', via: 'r1214100'},
  r121416:  { post: 'Ready for another LI winter', group: 'Bayport Blue Point Community', content: 'p3-winterready', term: 'b-261214-p3-winterready', members: 8000, at: '2026-12-14T10:00', week: 0, batch: 'b-261214-p3-winterready'},
  r121417:  { post: 'The socks photo', group: 'Seniors on Long Island', content: 'p9-socks', term: 'g-seniorsonlongislan', members: 32000, at: '2026-12-15T10:00', week: 0, batch: 'b-261215-p9-socks', via: 'w618'},
  r121418:  { post: 'Four generations in Suffolk', group: 'Huntington, New York', content: 'p7-generations', term: 'b-261216-p7-generations', members: 8000, at: '2026-12-16T10:00', week: 0, batch: 'b-261216-p7-generations'},
  r121419:  { post: 'First company photo', group: 'Smithtown NY community page', content: 'p6-crew', term: 'b-261217-p6-crew', members: 4000, at: '2026-12-17T10:00', week: 0, batch: 'b-261217-p6-crew'},
  r121420:  { post: 'As a father', group: 'Huntington Long Island Past and Present', content: 'p8-asafather', term: 'b-261218-p8-asafather', members: 2000, at: '2026-12-18T10:00', week: 0, batch: 'b-261218-p8-asafather'},
  r121421:  { post: 'Once the crew leaves', group: 'Everything Babylon', content: 'p2-aftercare', term: 'g-everythingbabylon', members: 6000, at: '2026-12-14T12:00', week: 0, batch: 'b-261214-p2-aftercare', via: 'w602'},
  r121422:  { post: 'Most roofers say replace', group: 'Long Island, NY Business Owners', content: 'p4-replacerepair', term: 'b-261215-p4-replacerepair', members: 27000, at: '2026-12-15T12:00', week: 0, batch: 'b-261215-p4-replacerepair'},
  r121423:  { post: 'Just finished - full roof', group: 'Deer Park Community', content: 'p1-justfinished', term: 'g-deerparkcommunity', members: 8000, at: '2026-12-16T12:00', week: 0, batch: 'b-261216-p1-justfinished', via: 'r121413'},
  r121424:  { post: 'Just finished - full roof', group: 'Patchogue Village Neighbors', content: 'p1-justfinished', term: 'g-patchoguevillagene', members: 3000, at: '2026-12-17T12:00', week: 0, batch: 'b-261217-p1-justfinished', via: 'r121491'},
  r121425:  { post: 'Just finished - full roof', group: 'Riverhead Group', content: 'p1-justfinished', term: 'g-riverheadgroup', members: 2000, at: '2026-12-18T12:00', week: 0, batch: 'b-261218-p1-justfinished', via: 'r1214100'},
  r121426:  { post: 'Just finished - full roof', group: 'Wading River Shoreham Local Businesses', content: 'p1-justfinished', term: 'g-wadingrivershoreha', members: 4000, at: '2026-12-14T13:00', week: 0, batch: 'b-261214-p1-justfinished', via: 'w601'},
  r121427:  { post: 'Ready for another LI winter', group: 'Patchogue Long Island NY', content: 'p3-winterready', term: 'g-patchoguelongislan', members: 17000, at: '2026-12-15T13:00', week: 0, batch: 'b-261215-p3-winterready', via: 'w612'},
  r121428:  { post: 'The socks photo', group: 'THREE VILLAGE', content: 'p9-socks', term: 'b-261216-p9-socks', members: 7000, at: '2026-12-16T13:00', week: 0, batch: 'b-261216-p9-socks'},
  r121429:  { post: 'Four generations in Suffolk', group: 'West islip mom’s uncensored', content: 'p7-generations', term: 'g-westislipmomsuncen', members: 3000, at: '2026-12-17T13:00', week: 0, batch: 'b-261217-p7-generations', via: 'r121484'},
  r121430:  { post: 'First company photo', group: 'Holbrook Moms NY', content: 'p6-crew', term: 'g-holbrookmomsny', members: 1000, at: '2026-12-18T13:00', week: 0, batch: 'b-261218-p6-crew', via: 'r121452'},
  r121431:  { post: 'As a father', group: 'Kings Park Downtown', content: 'p8-asafather', term: 'g-kingsparkdowntown', members: 3000, at: '2026-12-14T14:00', week: 0, batch: 'b-261214-p8-asafather', via: 'r121486'},
  r121432:  { post: 'Once the crew leaves', group: 'East Northport mom’s group', content: 'p2-aftercare', term: 'g-eastnorthportmomsg', members: 13000, at: '2026-12-15T14:00', week: 0, batch: 'b-261215-p2-aftercare', via: 'r121487'},
  r121433:  { post: 'Most roofers say replace', group: 'Port Jefferson, Setauket, Stony Brook & Mount Sinai Recommendations', content: 'p4-replacerepair', term: 'g-portjeffersonsetau', members: 6000, at: '2026-12-16T14:00', week: 0, batch: 'b-261216-p4-replacerepair', via: 'r121488'},
  r121434:  { post: 'Just finished - full roof', group: 'Only In Copiague...', content: 'p1-justfinished', term: 'g-onlyincopiague', members: 3000, at: '2026-12-17T14:00', week: 0, batch: 'b-261217-p1-justfinished', via: 'r121491'},
  r121435:  { post: 'Just finished - full roof', group: 'Brentwood Cares', content: 'p1-justfinished', term: 'g-brentwoodcares', members: 1000, at: '2026-12-18T14:00', week: 0, batch: 'b-261218-p1-justfinished', via: 'r1214100'},
  r121436:  { post: 'Just finished - full roof', group: 'Three Village Local', content: 'p1-justfinished', term: 'g-threevillagelocal', members: 4000, at: '2026-12-14T15:00', week: 0, batch: 'b-261214-p1-justfinished', via: 'w601'},
  r121437:  { post: 'Just finished - full roof', group: 'Deer Park NY Community Page', content: 'p1-justfinished', term: 'g-deerparknycomm5', members: 13000, at: '2026-12-15T15:00', week: 0, batch: 'b-261215-p1-justfinished', via: 'r121492'},
  r121438:  { post: 'Ready for another LI winter', group: 'West Islip Moms AND Dads', content: 'p3-winterready', term: 'g-westislipmomsandda', members: 5000, at: '2026-12-16T15:00', week: 0, batch: 'b-261216-p3-winterready', via: 'r121493'},
  r121439:  { post: 'First company photo', group: 'Brentwood Parents & Alumni (Brentwood, New York)', content: 'p6-crew', term: 'g-brentwoodparentsal', members: 3000, at: '2026-12-17T15:00', week: 0, batch: 'b-261217-p6-crew', via: 'r121419'},
  r121440:  { post: 'Four generations in Suffolk', group: 'You really know you\'re from Huntington if', content: 'p7-generations', term: 'g-youreallyknowyoure', members: 1000, at: '2026-12-18T15:00', week: 0, batch: 'b-261218-p7-generations', via: 'r121495'},
  r121441:  { post: 'First company photo', group: 'Center Moriches Community Posts', content: 'p6-crew', term: 'b-261214-p6-crew', members: 10000, at: '2026-12-14T07:00', week: 0, batch: 'b-261214-p6-crew'},
  r121442:  { post: 'As a father', group: 'Centereach , NY Community Group, Post Your Ad Here, Post Your Business Here', content: 'p8-asafather', term: 'g-centereachnyco4', members: 21000, at: '2026-12-15T07:00', week: 0, batch: 'b-261215-p8-asafather', via: 'r121497'},
  r121443:  { post: 'Once the crew leaves', group: 'East Patchogue Community', content: 'p2-aftercare', term: 'b-261216-p2-aftercare', members: 29000, at: '2026-12-16T07:00', week: 0, batch: 'b-261216-p2-aftercare'},
  r121444:  { post: 'Most roofers say replace', group: 'Babylon Advertising - Town of Babylon - Babylon, NY', content: 'p4-replacerepair', term: 'g-babylonadvertising', members: 5000, at: '2026-12-17T07:00', week: 0, batch: 'b-261217-p4-replacerepair', via: 'w631'},
  r121445:  { post: 'Just finished - full roof', group: 'Center Moriches, NY', content: 'p1-justfinished', term: 'g-centermorichesny', members: 2000, at: '2026-12-18T07:00', week: 0, batch: 'b-261218-p1-justfinished', via: 'r1214100'},
  r121446:  { post: 'Just finished - full roof', group: 'Islip That & This', content: 'p1-justfinished', term: 'g-islipthatthis', members: 6000, at: '2026-12-14T08:00', week: 0, batch: 'b-261214-p1-justfinished', via: 'w601'},
  r121447:  { post: 'Just finished - full roof', group: 'Commack Connected', content: 'p1-justfinished', term: 'g-commackconnected', members: 1000, at: '2026-12-15T08:00', week: 0, batch: 'b-261215-p1-justfinished', via: 'r121492'},
  r121448:  { post: 'Just finished - full roof', group: 'Copiague Mom\'s & Dad\'s group', content: 'p1-justfinished', term: 'g-copiaguemomsdadsgr', members: 1000, at: '2026-12-16T08:00', week: 0, batch: 'b-261216-p1-justfinished', via: 'r121413'},
  r121449:  { post: 'Ready for another LI winter', group: 'Selden Community-Post your Ads here', content: 'p3-winterready', term: 'b-261217-p3-winterready', members: 5000, at: '2026-12-17T08:00', week: 0, batch: 'b-261217-p3-winterready'},
  r121450:  { post: 'The socks photo', group: 'Bonac - East Hampton - Southampton NY', content: 'p9-socks', term: 'g-bonaceasthamptonso', members: 2000, at: '2026-12-18T08:00', week: 0, batch: 'b-261218-p9-socks', via: 'r1214105'},
  r121451:  { post: 'Four generations in Suffolk', group: 'Centereach | Lake Grove Community', content: 'p7-generations', term: 'g-centereachlakegrov', members: 3000, at: '2026-12-14T09:00', week: 0, batch: 'b-261214-p7-generations', via: 'w607'},
  r121452:  { post: 'First company photo', group: 'Long Island Locals', content: 'p6-crew', term: 'b-261218-p6-crew', members: 57000, at: '2026-12-18T09:00', week: 0, batch: 'b-261218-p6-crew'},
  r121453:  { post: 'As a father', group: 'Commack Community Group', content: 'p8-asafather', term: 'b-261216-p8-asafather', members: 11000, at: '2026-12-16T09:00', week: 0, batch: 'b-261216-p8-asafather'},
  r121454:  { post: 'Once the crew leaves', group: 'Wyandanch Stand Up', content: 'p2-aftercare', term: 'b-261217-p2-aftercare', members: 4000, at: '2026-12-17T09:00', week: 0, batch: 'b-261217-p2-aftercare'},
  r121455:  { post: 'Most roofers say replace', group: 'Dix Hills Moms', content: 'p4-replacerepair', term: 'b-261218-p4-replacerepair', members: 2000, at: '2026-12-18T09:00', week: 0, batch: 'b-261218-p4-replacerepair'},
  r121456:  { post: 'Just finished - full roof', group: 'Lindenhurst, NY - Events around town', content: 'p1-justfinished', term: 'g-lindenhurstnyevent', members: 8000, at: '2026-12-14T10:00', week: 0, batch: 'b-261214-p1-justfinished', via: 'w601'},
  r121457:  { post: 'Just finished - full roof', group: 'Long Island Sell/advertise ANYTHING Legal Only!!', content: 'p1-justfinished', term: 'g-longislandselladve', members: 31000, at: '2026-12-15T10:00', week: 0, batch: 'b-261215-p1-justfinished', via: 'r121492'},
  r121458:  { post: 'Just finished - full roof', group: 'Rocky Point & Local Surrounding Businesses/Organizations', content: 'p1-justfinished', term: 'g-rockypointlocalsur', members: 8000, at: '2026-12-16T10:00', week: 0, batch: 'b-261216-p1-justfinished', via: 'r121413'},
  r121459:  { post: 'Just finished - full roof', group: 'What’s Happening in Hampton Bays', content: 'p1-justfinished', term: 'g-whatshappeninginha', members: 4000, at: '2026-12-17T10:00', week: 0, batch: 'b-261217-p1-justfinished', via: 'r121491'},
  r121460:  { post: 'Ready for another LI winter', group: 'You know you grew up in Babylon, New York if you remember.........', content: 'p3-winterready', term: 'g-youknowyougrewupin', members: 2000, at: '2026-12-18T10:00', week: 0, batch: 'b-261218-p3-winterready', via: 'r121405'},
  r121461:  { post: 'The socks photo', group: 'Suffolk County Local Business/Service', content: 'p9-socks', term: 'g-suffolkcountylocal', members: 6000, at: '2026-12-14T12:00', week: 0, batch: 'b-261214-p9-socks', via: 'r121406'},
  r121462:  { post: 'Four generations in Suffolk', group: 'Long Island Chatter buy/sell/trade/barter/ads/less rules Nassau Suffolk', content: 'p7-generations', term: 'b-261215-p7-generations', members: 22000, at: '2026-12-15T12:00', week: 0, batch: 'b-261215-p7-generations'},
  r121463:  { post: 'First company photo', group: 'Holbrook Happenings', content: 'p6-crew', term: 'b-261216-p6-crew', members: 7000, at: '2026-12-16T12:00', week: 0, batch: 'b-261216-p6-crew'},
  r121464:  { post: 'As a father', group: 'North Babylon Times & Memories', content: 'p8-asafather', term: 'g-x-x104', members: 3000, at: '2026-12-17T12:00', week: 0, batch: 'b-261217-p8-asafather', via: 'r121409'},
  r121465:  { post: 'Once the crew leaves', group: 'Islip Community', content: 'p2-aftercare', term: 'g-islipcommunity', members: 2000, at: '2026-12-18T12:00', week: 0, batch: 'b-261218-p2-aftercare', via: 'r121410'},
  r121466:  { post: 'Most roofers say replace', group: 'Westhampton Beach Area Community LOCAL', content: 'p4-replacerepair', term: 'g-westhamptonbeach', members: 4000, at: '2026-12-14T13:00', week: 0, batch: 'b-261214-p4-replacerepair', via: 'r121411'},
  r121467:  { post: 'Just finished - full roof', group: 'Lake Grove/Centereach Long Island NY', content: 'p1-justfinished', term: 'g-lakegrovecentereac', members: 14000, at: '2026-12-15T13:00', week: 0, batch: 'b-261215-p1-justfinished', via: 'r121492'},
  r121468:  { post: 'Just finished - full roof', group: 'West Islip Community', content: 'p1-justfinished', term: 'g-westislipcommu4', members: 6000, at: '2026-12-16T13:00', week: 0, batch: 'b-261216-p1-justfinished', via: 'r121413'},
  r121469:  { post: 'Just finished - full roof', group: 'You\'re probably from Sayville if', content: 'p1-justfinished', term: 'g-youreprobablyfroms', members: 3000, at: '2026-12-17T13:00', week: 0, batch: 'b-261217-p1-justfinished', via: 'r121491'},
  r121470:  { post: 'Just finished - full roof', group: 'Three Village Dads', content: 'p1-justfinished', term: 'g-threevillagedads', members: 2000, at: '2026-12-18T13:00', week: 0, batch: 'b-261218-p1-justfinished', via: 'r1214100'},
  r121471:  { post: 'Ready for another LI winter', group: 'Port Jefferson Community NY', content: 'p3-winterready', term: 'g-portjeffersoncommu', members: 4000, at: '2026-12-14T14:00', week: 0, batch: 'b-261214-p3-winterready', via: 'r121416'},
  r121472:  { post: 'The socks photo', group: 'Eyes on Lindy', content: 'p9-socks', term: 'g-eyesonlindy', members: 12000, at: '2026-12-15T14:00', week: 0, batch: 'b-261215-p9-socks', via: 'w618'},
  r121473:  { post: 'Four generations in Suffolk', group: 'Mastics/shirley Moriches Community Group', content: 'p7-generations', term: 'g-masticsshirley3', members: 5000, at: '2026-12-16T14:00', week: 0, batch: 'b-261216-p7-generations', via: 'r121418'},
  r121474:  { post: 'First company photo', group: 'Lake Ronkonkoma neighborhood & town watch', content: 'p6-crew', term: 'g-lakeronkonkomaneig', members: 3000, at: '2026-12-17T14:00', week: 0, batch: 'b-261217-p6-crew', via: 'r121419'},
  r121475:  { post: 'As a father', group: 'Huntington NY', content: 'p8-asafather', term: 'g-huntingtonny', members: 1000, at: '2026-12-18T14:00', week: 0, batch: 'b-261218-p8-asafather', via: 'r121420'},
  r121476:  { post: 'Once the crew leaves', group: 'Miller Place Parents & Communities', content: 'p2-aftercare', term: 'g-millerplaceparents', members: 2000, at: '2026-12-14T15:00', week: 0, batch: 'b-261214-p2-aftercare', via: 'w602'},
  r121477:  { post: 'Most roofers say replace', group: 'Hampton Bays Bulletin Board (NOT buy and sell)', content: 'p4-replacerepair', term: 'g-hamptonbaysbulleti', members: 11000, at: '2026-12-15T15:00', week: 0, batch: 'b-261215-p4-replacerepair', via: 'r121422'},
  r121478:  { post: 'Just finished - full roof', group: 'Mount Sinai-miller place community no rules', content: 'p1-justfinished', term: 'g-mountsinaimillerpl', members: 5000, at: '2026-12-16T15:00', week: 0, batch: 'b-261216-p1-justfinished', via: 'r121413'},
  r121479:  { post: 'Just finished - full roof', group: 'West Islip Dads', content: 'p1-justfinished', term: 'g-westislipdads', members: 2000, at: '2026-12-17T15:00', week: 0, batch: 'b-261217-p1-justfinished', via: 'r121491'},
  r121480:  { post: 'Just finished - full roof', group: 'Im So Bellport', content: 'p1-justfinished', term: 'g-imsobellport', members: 1000, at: '2026-12-18T15:00', week: 0, batch: 'b-261218-p1-justfinished', via: 'r1214100'},
  r121481:  { post: 'Just finished - full roof', group: 'Lindenhurst Moms', content: 'p1-justfinished', term: 'g-lindenhurstmoms', members: 3000, at: '2026-12-14T07:00', week: 0, batch: 'b-261214-p1-justfinished', via: 'w601'},
  r121482:  { post: 'Ready for another LI winter', group: 'Sayville Community NY', content: 'p3-winterready', term: 'g-sayvillecommunityn', members: 15000, at: '2026-12-15T07:00', week: 0, batch: 'b-261215-p3-winterready', via: 'w612'},
  r121483:  { post: 'The socks photo', group: 'Miller Place / Sound Beach Community', content: 'p9-socks', term: 'g-millerplacesoundbe', members: 3000, at: '2026-12-16T07:00', week: 0, batch: 'b-261216-p9-socks', via: 'r121428'},
  r121484:  { post: 'Four generations in Suffolk', group: 'Shirley, Mastic, Manorville, Middle Island, and Other Suffolk County Moms', content: 'p7-generations', term: 'b-261217-p7-generations', members: 5000, at: '2026-12-17T07:00', week: 0, batch: 'b-261217-p7-generations'},
  r121485:  { post: 'First company photo', group: 'Smithtown Dads', content: 'p6-crew', term: 'b-261218-p6-crew', members: 2000, at: '2026-12-18T07:00', week: 0, batch: 'b-261218-p6-crew', via: 'r121452'},
  r121486:  { post: 'As a father', group: 'Eastport, Manorville, Speonk, Center.East.Moriches  Community', content: 'p8-asafather', term: 'b-261214-p8-asafather', members: 35000, at: '2026-12-14T08:00', week: 0, batch: 'b-261214-p8-asafather'},
  r121487:  { post: 'Once the crew leaves', group: 'Long Island Homes and Apartments', content: 'p2-aftercare', term: 'b-261215-p2-aftercare', members: 108000, at: '2026-12-15T08:00', week: 0, batch: 'b-261215-p2-aftercare'},
  r121488:  { post: 'Most roofers say replace', group: 'Brentwood', content: 'p4-replacerepair', term: 'b-261216-p4-replacerepair', members: 12000, at: '2026-12-16T08:00', week: 0, batch: 'b-261216-p4-replacerepair'},
  r121489:  { post: 'Just finished - full roof', group: 'Patchogue-Medford Community Uncensored', content: 'p1-justfinished', term: 'g-patchoguemedfordco', members: 5000, at: '2026-12-17T08:00', week: 0, batch: 'b-261217-p1-justfinished', via: 'r121491'},
  r121490:  { post: 'Just finished - full roof', group: 'Sayville Moms and Dads Uncensored', content: 'p1-justfinished', term: 'g-sayvillemomsanddad', members: 2000, at: '2026-12-18T08:00', week: 0, batch: 'b-261218-p1-justfinished', via: 'r1214100'},
  r121491:  { post: 'Just finished - full roof', group: 'Suffolk County Mom\'s', content: 'p1-justfinished', term: 'b-261217-p1-justfinished', members: 21000, at: '2026-12-17T09:00', week: 0, batch: 'b-261217-p1-justfinished'},
  r121492:  { post: 'Just finished - full roof', group: 'Long Island Marketplace', content: 'p1-justfinished', term: 'b-261215-p1-justfinished', members: 121000, at: '2026-12-15T09:00', week: 0, batch: 'b-261215-p1-justfinished'},
  r121493:  { post: 'Ready for another LI winter', group: 'Rocky Point Friends & Rentals', content: 'p3-winterready', term: 'b-261216-p3-winterready', members: 10000, at: '2026-12-16T09:00', week: 0, batch: 'b-261216-p3-winterready'},
  r121494:  { post: 'The socks photo', group: 'Huntington Nightlife, Long Island NY', content: 'p9-socks', term: 'g-huntingtonnightlif', members: 3000, at: '2026-12-17T09:00', week: 0, batch: 'b-261217-p9-socks', via: 'w627'},
  r121495:  { post: 'Four generations in Suffolk', group: 'Brentwood Neighborhood', content: 'p7-generations', term: 'b-261218-p7-generations', members: 2000, at: '2026-12-18T09:00', week: 0, batch: 'b-261218-p7-generations'},
  r121496:  { post: 'First company photo', group: 'Copiague Friends and Neighbors', content: 'p6-crew', term: 'g-copiaguefriendsand', members: 7000, at: '2026-12-14T10:00', week: 0, batch: 'b-261214-p6-crew', via: 'r121441'},
  r121497:  { post: 'As a father', group: 'WHAT\'S UP MONTAUK', content: 'p8-asafather', term: 'b-261215-p8-asafather', members: 22000, at: '2026-12-15T10:00', week: 0, batch: 'b-261215-p8-asafather'},
  r121498:  { post: 'Once the crew leaves', group: 'Babylon Village Connection', content: 'p2-aftercare', term: 'g-babylonvillageconn', members: 8000, at: '2026-12-16T10:00', week: 0, batch: 'b-261216-p2-aftercare', via: 'r121443'},
  r121499:  { post: 'Most roofers say replace', group: 'Suffolk/Nassau Community', content: 'p4-replacerepair', term: 'g-suffolknassaucommu', members: 4000, at: '2026-12-17T10:00', week: 0, batch: 'b-261217-p4-replacerepair', via: 'w631'},
  r1214100:  { post: 'Just finished - full roof', group: 'You Know You Grew Up in Bayport-Blue Point When...', content: 'p1-justfinished', term: 'b-261218-p1-justfinished', members: 2000, at: '2026-12-18T10:00', week: 0, batch: 'b-261218-p1-justfinished'},
  r1214101:  { post: 'Just finished - full roof', group: 'Sayville Community', content: 'p1-justfinished', term: 'g-sayvillecommunity', members: 5000, at: '2026-12-14T12:00', week: 0, batch: 'b-261214-p1-justfinished', via: 'w601'},
  r1214102:  { post: 'Just finished - full roof', group: 'Long Island Community & Neighbors', content: 'p1-justfinished', term: 'g-longislandcommunit', members: 18000, at: '2026-12-15T12:00', week: 0, batch: 'b-261215-p1-justfinished', via: 'r121492'},
  r1214103:  { post: 'Just finished - full roof', group: 'North Babylon Community Group', content: 'p1-justfinished', term: 'g-northbabyloncommun', members: 7000, at: '2026-12-16T12:00', week: 0, batch: 'b-261216-p1-justfinished', via: 'r121413'},
  r1214104:  { post: 'Ready for another LI winter', group: 'Mastic Beach Community Group', content: 'p3-winterready', term: 'g-masticbeachcommuni', members: 3000, at: '2026-12-17T12:00', week: 0, batch: 'b-261217-p3-winterready', via: 'r121449'},
  r1214105:  { post: 'The socks photo', group: 'Bay Shore Moms', content: 'p9-socks', term: 'b-261218-p9-socks', members: 2000, at: '2026-12-18T12:00', week: 0, batch: 'b-261218-p9-socks'},
  r1214106:  { post: 'Four generations in Suffolk', group: 'East Islip NY Uncensored', content: 'p7-generations', term: 'g-eastislipnyuncenso', members: 4000, at: '2026-12-14T13:00', week: 0, batch: 'b-261214-p7-generations', via: 'w607'},
  r1214107:  { post: 'First company photo', group: 'Neighbors of Quogue Westhampton Speonk Remsenburg Eastport Manorville', content: 'p6-crew', term: 'b-261215-p6-crew', members: 14000, at: '2026-12-15T13:00', week: 0, batch: 'b-261215-p6-crew'},
  r1214108:  { post: 'As a father', group: 'Commack Community Forum', content: 'p8-asafather', term: 'g-commackcommunityfo', members: 6000, at: '2026-12-16T13:00', week: 0, batch: 'b-261216-p8-asafather', via: 'r121453'},
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
/**
 * Records how far a visit got through the quote form.
 *
 * Writes a step number and nothing else. The body is read defensively and
 * every field is clamped, because this endpoint is public and unauthenticated
 * -- it has to be, the form is public -- so the only safe assumption is that
 * anything can arrive. A bad body is dropped silently rather than erroring,
 * since a visitor should never see a tracking failure.
 */
async function handleFunnel(request, env, ctx) {
  if (request.method !== 'POST') return json({ ok: false }, 405);
  if (!env.DB) return json({ ok: true });

  let b;
  try { b = await request.json(); } catch { return json({ ok: true }); }

  const sid = String(b.sid || '').slice(0, 40);
  const step = Number(b.step);
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(sid)) return json({ ok: true });
  if (!Number.isInteger(step) || step < 0 || (step > 10 && step !== 99)) return json({ ok: true });

  const slug = /^[A-Za-z0-9_-]{1,24}$/.test(String(b.slug || '')) ? String(b.slug) : null;
  const ua = request.headers.get('user-agent') || '';
  // Same bot filter as the click handler, or preview fetchers would show up as
  // visitors who landed and bounced, and the top of the funnel would be fiction.
  if (/bot|crawler|spider|facebookexternalhit|preview|slackbot|whatsapp|headless|curl|wget|python-|go-http|okhttp|java\/|scrapy|axios|node-fetch|httpie|postman|monitor|scan|probe/i.test(ua)
      || ua === '') return json({ ok: true });

  const now = new Date();
  ctx.waitUntil(env.DB.prepare(
    `INSERT INTO funnel (sid, step, slug, mobile, ts, day) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(sid, step) DO NOTHING`)
    .bind(sid, step, slug, b.mobile ? 1 : 0, now.toISOString(), localDay(now))
    .run().catch((e) => console.error('funnel insert failed', e && e.message)));

  return json({ ok: true });
}

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
  // 'left' and 'keeping' belong to the Leave list -- groups already joined that
  // turned out to be in Brooklyn, Syracuse, Dorset or Western Australia. Same
  // table, same shared marks; the board decides which verbs a row offers.
  if (!['requested', 'joined', 'declined', 'left', 'keeping'].includes(status)) {
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
