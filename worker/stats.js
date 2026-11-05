/**
 * The progress dashboard for Aaron and Jacob.
 *
 * Everything is computed from two D1 tables — clicks written by the short-link
 * redirect, and leads written by the quote form — joined in memory against the
 * posting schedule. Volumes are in the hundreds, so one scan of each table per
 * page load is cheaper and simpler than maintaining rollups.
 */

const TZ = 'America/New_York';
const CAMPAIGN_START = '2026-11-05';

// Ride the Wave's own numbers, from their 258-post export. This is the bar.
const BENCH = { leadsPerMonth: 10, postsPerLead: 6 };

function dayIn(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** Local wall-clock parts in New York, so "today" means Jacob's today. */
function partsIn(d) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d);
  const o = {};
  for (const p of f) o[p.type] = p.value;
  return o;
}

function shiftDay(dayStr, delta) {
  const d = new Date(dayStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const UNTRACED = 'No tracking link \u2014 direct or shared';

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function periods(now) {
  const today = dayIn(now);
  const dow = WD[partsIn(now).weekday];
  const weekStart = shiftDay(today, -((dow + 6) % 7));       // Monday
  const monthStart = today.slice(0, 8) + '01';
  return [
    { key: 'day',   label: 'Today',            from: today,      to: today },
    { key: 'week',  label: 'This week',        from: weekStart,  to: today },
    { key: 'month', label: 'This month',       from: monthStart, to: today },
    { key: 'all',   label: 'Campaign to date', from: CAMPAIGN_START, to: today },
  ];
}

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const one = (n) => (Math.round(n * 10) / 10).toFixed(1);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function prettyDay(dayStr) {
  return new Date(dayStr + 'T12:00:00Z').toLocaleDateString('en-US',
    { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

/* ------------------------------------------------------------- the handler */

export async function handleStats(url, env, LINKS) {
  if (!env.DB) {
    return new Response('The dashboard database is not bound to this Worker yet.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  const [clickRes, leadRes] = await Promise.all([
    env.DB.prepare(
      `SELECT day, slug,
              SUM(CASE WHEN bot = 0 THEN 1 ELSE 0 END) AS humans,
              SUM(bot) AS bots
         FROM clicks GROUP BY day, slug`).all(),
    env.DB.prepare(
      `SELECT day, slug, COUNT(*) AS n FROM leads GROUP BY day, slug`).all(),
  ]);

  const clicks = clickRes.results || [];
  const leads = leadRes.results || [];
  const now = new Date();
  const nowLocal = partsIn(now);
  const nowStamp = `${nowLocal.year}-${nowLocal.month}-${nowLocal.day}T${nowLocal.hour}:${nowLocal.minute}`;

  const slugs = Object.keys(LINKS);
  const isLive = (s) => LINKS[s].at <= nowStamp;

  /** Everything the page needs for one date window. */
  function roll(p) {
    const inRange = (d) => d >= p.from && d <= p.to;
    const bySlug = {};
    const byDay = {};
    const touch = (s) => (bySlug[s] = bySlug[s] || { clicks: 0, bots: 0, leads: 0 });
    const day = (d) => (byDay[d] = byDay[d] || { clicks: 0, leads: 0 });

    let totalClicks = 0, totalBots = 0, totalLeads = 0;
    for (const r of clicks) {
      if (!inRange(r.day)) continue;
      const t = touch(r.slug);
      t.clicks += r.humans; t.bots += r.bots;
      day(r.day).clicks += r.humans;
      totalClicks += r.humans; totalBots += r.bots;
    }
    for (const r of leads) {
      if (!inRange(r.day)) continue;
      touch(r.slug || '(no post)').leads += r.n;
      day(r.day).leads += r.n;
      totalLeads += r.n;
    }

    // Posts count toward a window when they were scheduled in it and that time
    // has passed. Clicks are counted on the day they happened, not the day the
    // post went up, so late traffic on an old post still shows.
    const live = slugs.filter((s) => LINKS[s].at.slice(0, 10) >= p.from
                                  && LINKS[s].at.slice(0, 10) <= p.to && isLive(s));
    const reach = live.reduce((a, s) => a + LINKS[s].members, 0);

    return { ...p, bySlug, byDay, totalClicks, totalBots, totalLeads,
             live, postsLive: live.length, reach };
  }

  const rolls = periods(now).map(roll);
  const all = rolls[rolls.length - 1];
  const week = rolls[1];

  /* posts that should have gone out and show no sign of life */
  const sixHoursAgo = new Date(now.getTime() - 6 * 3600 * 1000);
  const sixStamp = (() => { const p = partsIn(sixHoursAgo);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; })();
  const silent = slugs.filter((s) => LINKS[s].at <= sixStamp
    && !(all.bySlug[s] && (all.bySlug[s].clicks > 0 || all.bySlug[s].bots > 0)));
  const upcoming = slugs.filter((s) => !isLive(s))
    .sort((a, b) => LINKS[a].at.localeCompare(LINKS[b].at)).slice(0, 4);

  return new Response(page({ rolls, all, week, silent, upcoming, LINKS, now, nowLocal }),
    { headers: { 'content-type': 'text/html; charset=utf-8',
                 'cache-control': 'no-store',
                 'x-robots-tag': 'noindex, nofollow' } });
}

/* ---------------------------------------------------------------- tiles */

function tiles(r) {
  const perPost = r.postsLive ? r.totalLeads / r.postsLive : 0;
  const cards = [
    ['Leads', fmt(r.totalLeads), r.totalLeads === 1 ? 'form submission' : 'form submissions'],
    ['Clicks', fmt(r.totalClicks), r.totalBots
      ? fmt(r.totalBots) + (r.totalBots === 1 ? ' preview fetch' : ' preview fetches') + ' excluded'
      : 'real people'],
    ['Posts live', fmt(r.postsLive), r.key === 'all' ? 'since launch' : 'in this window'],
    ['Reach', fmt(r.reach), 'members in those groups'],
    ['Clicks per post', one(r.postsLive ? r.totalClicks / r.postsLive : 0), 'average'],
    ['Leads per post', one(perPost), 'Ride the Wave did ' + one(1 / BENCH.postsPerLead)],
  ];
  return '<div class="tiles">' + cards.map(([k, v, s]) =>
    `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`
    + `<div class="s">${esc(s)}</div></div>`).join('') + '</div>';
}

/* ---------------------------------------------------------------- chart */

function chart(r) {
  const days = [];
  for (let d = r.from; d <= r.to; d = shiftDay(d, 1)) days.push(d);
  if (days.length < 2) return '';
  const max = Math.max(1, ...days.map((d) => (r.byDay[d] || {}).clicks || 0));
  const W = 700, H = 120, gap = 3;
  // Cap the width so a four-day week does not render as four giant slabs.
  const bw = Math.min(26, Math.max(2, (W - gap * (days.length - 1)) / days.length));
  const bars = days.map((d, i) => {
    const v = (r.byDay[d] || {}).clicks || 0;
    const l = (r.byDay[d] || {}).leads || 0;
    const h = v ? Math.max(2, (v / max) * (H - 22)) : 0;
    const x = i * (bw + gap);
    return `<g><title>${esc(prettyDay(d))} — ${v} clicks, ${l} leads</title>`
      + `<rect x="${one(x)}" y="${one(H - 18 - h)}" width="${one(bw)}" height="${one(h)}" rx="2" class="bar"></rect>`
      + (l ? `<circle cx="${one(x + bw / 2)}" cy="${one(H - 22 - h)}" r="3.5" class="dot"></circle>` : '')
      + `</g>`;
  }).join('');
  return `<section class="panel"><h2>Daily clicks<span class="legend">`
    + `<i class="sw-bar"></i>clicks<i class="sw-dot"></i>a lead that day</span></h2>`
    + `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Clicks per day">${bars}`
    + `<text x="0" y="${H - 4}" class="ax">${esc(prettyDay(days[0]))}</text>`
    + `<text x="${W}" y="${H - 4}" text-anchor="end" class="ax">${esc(prettyDay(days[days.length - 1]))}</text>`
    + `</svg></section>`;
}

/* --------------------------------------------------------------- tables */

function tableBy(r, LINKS, dim) {
  const agg = {};
  for (const [slug, v] of Object.entries(r.bySlug)) {
    const link = LINKS[slug];
    // A lead with no rtw_pid reached the quote page without a tracked link —
    // direct, a shared screenshot, or someone who typed the domain in.
    const name = link ? link[dim] : (slug === '(no post)' ? UNTRACED : slug);
    const a = agg[name] = agg[name] || { clicks: 0, leads: 0, members: 0, slugs: [] };
    a.clicks += v.clicks; a.leads += v.leads;
    if (link && dim === 'group') a.members += link.members;
    a.slugs.push(slug);
  }
  // A post with no clicks yet still belongs in the list — its zero is the point.
  for (const s of r.live) {
    const name = LINKS[s][dim];
    if (!agg[name]) agg[name] = { clicks: 0, leads: 0, members: dim === 'group' ? LINKS[s].members : 0, slugs: [s] };
  }
  const rows = Object.entries(agg).sort((a, b) =>
    (a[0] === UNTRACED) - (b[0] === UNTRACED)
    || b[1].leads - a[1].leads || b[1].clicks - a[1].clicks);
  if (!rows.length) return '';

  const head = dim === 'post'
    ? ['Post', 'Groups', 'Clicks', 'Leads', 'Lead rate']
    : ['Group', 'Members', 'Clicks', 'Leads', 'Clicks per 1k members'];

  const body = rows.map(([name, a]) => {
    const last = dim === 'post'
      ? (a.clicks ? one(a.leads / a.clicks * 100) + '%' : '—')
      : (a.members ? one(a.clicks / a.members * 1000) : '—');
    const mid = dim === 'post' ? fmt(a.slugs.length) : fmt(a.members);
    return `<tr><td class="nm">${esc(name)}</td><td>${mid}</td><td>${fmt(a.clicks)}</td>`
      + `<td class="${a.leads ? 'hit' : ''}">${fmt(a.leads)}</td><td>${last}</td></tr>`;
  }).join('');

  return `<section class="panel"><h2>${dim === 'post' ? 'Which post is working' : 'Which group is working'}</h2>`
    + `<div class="scroll"><table><thead><tr>`
    + head.map((h, i) => `<th${i ? '' : ' class="nm"'}>${esc(h)}</th>`).join('')
    + `</tr></thead><tbody>${body}</tbody></table></div>`
    + (dim === 'group'
      ? '<p class="fine">Clicks per 1,000 members is the number to judge a group on.'
        + ' Member count alone is a vanity metric \u2014 a big nostalgia group can send nobody.</p>'
      : '<p class="fine">Nine pieces of copy rotate across groups, so the same post appears more than once.'
        + ' This adds them up by copy, which is what tells you whether the writing is working.</p>')
    + `</section>`;
}

/* ---------------------------------------------------------- weekly email */

function emailText(week, all, LINKS) {
  const L = [];
  L.push(`JAGG — Facebook group campaign, week of ${prettyDay(week.from)}`);
  L.push('');
  L.push(`Leads this week: ${week.totalLeads}`);
  L.push(`Clicks this week: ${week.totalClicks}`);
  L.push(`Posts published: ${week.postsLive} into ${week.postsLive} group${week.postsLive === 1 ? '' : 's'}`
    + ` (${fmt(week.reach)} members)`);
  L.push('');
  const top = Object.entries(week.bySlug)
    .filter(([s]) => LINKS[s])
    .sort((a, b) => b[1].leads - a[1].leads || b[1].clicks - a[1].clicks)
    .slice(0, 3);
  if (top.length) {
    L.push('Best performing this week:');
    for (const [s, v] of top) {
      L.push(`  - ${LINKS[s].post} in ${LINKS[s].group} — `
        + `${v.clicks} click${v.clicks === 1 ? '' : 's'}, ${v.leads} lead${v.leads === 1 ? '' : 's'}`);
    }
    L.push('');
  }
  L.push(`Campaign to date: ${all.totalLeads} leads from ${all.postsLive} posts (${one(all.postsLive ? all.totalLeads / all.postsLive : 0)} per post).`);
  L.push(`For reference, the previous vendor averaged about ${BENCH.leadsPerMonth} leads a month, roughly 1 lead per ${BENCH.postsPerLead} posts.`);
  L.push('');
  L.push('Every lead above came in through the quote form and is already in AccuLynx under the Hey Aaron lead source.');
  return L.join('\n');
}

/* ------------------------------------------------------------------ page */

function page({ rolls, all, week, silent, upcoming, LINKS, nowLocal }) {
  const nav = rolls.map((r, i) =>
    `<button class="tab${i === 1 ? ' on' : ''}" data-p="${r.key}">${esc(r.label)}</button>`).join('');

  const panes = rolls.map((r, i) => {
    const range = r.from === r.to ? prettyDay(r.from)
      : prettyDay(r.from) + ' – ' + prettyDay(r.to);
    return `<div class="pane${i === 1 ? ' on' : ''}" data-p="${r.key}">`
      + `<div class="range">${esc(range)}</div>`
      + tiles(r) + chart(r) + tableBy(r, LINKS, 'post') + tableBy(r, LINKS, 'group')
      + `</div>`;
  }).join('');

  const flags = [];
  if (silent.length) {
    flags.push(`<div class="flag warn"><b>${silent.length} post${silent.length === 1 ? ' has' : 's have'} no clicks at all`
      + ` more than six hours after it was due.</b> Usually that means a group admin held or removed it, or it never`
      + ` went out of the queue. Worth checking: `
      + silent.map((s) => esc(LINKS[s].group)).join(', ') + '.</div>');
  }
  if (upcoming.length) {
    flags.push(`<div class="flag"><b>Next up:</b> `
      + upcoming.map((s) => `${esc(LINKS[s].post)} → ${esc(LINKS[s].group)}`
        + ` <span class="faint">${esc(prettyDay(LINKS[s].at.slice(0, 10)))}`
        + ` ${esc(LINKS[s].at.slice(11))}</span>`).join(' · ') + '</div>');
  }

  const email = emailText(week, all, LINKS);

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>JAGG campaign progress</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --ground:#EDEFF3; --surface:#FFFFFF; --sunk:#F2F4F7;
  --navy:#14213D; --ink:#14213D; --muted:#5A6678; --faint:#8C97A8;
  --line:#DCE1E9; --accent:#C2410C; --accent-wash:#FBEAE2; --good:#15803D;
  --shadow:0 1px 2px rgba(20,33,61,.09);
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --ground:#0E1218; --surface:#191E27; --sunk:#141922; --navy:#0A0E14;
  --ink:#E7ECF3; --muted:#9FAABB; --faint:#6B7789; --line:#293140;
  --accent:#E8703A; --accent-wash:#382016; --good:#4ADE80;
  --shadow:0 1px 2px rgba(0,0,0,.45);}}
:root[data-theme="dark"]{
  --ground:#0E1218; --surface:#191E27; --sunk:#141922; --navy:#0A0E14;
  --ink:#E7ECF3; --muted:#9FAABB; --faint:#6B7789; --line:#293140;
  --accent:#E8703A; --accent-wash:#382016; --good:#4ADE80;
  --shadow:0 1px 2px rgba(0,0,0,.45);}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);
  font-family:Inter,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
  font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
h1,h2{margin:0;text-wrap:balance}
p{margin:0}
.top{background:var(--navy);color:#fff;padding:28px 24px 22px}
.in{max-width:760px;margin:0 auto}
.eyebrow{font-size:11.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#9AA7BC}
.top h1{font-size:26px;font-weight:800;margin-top:8px}
.top p{color:#C3CCDA;font-size:14px;margin-top:7px}
.tabs{max-width:760px;margin:0 auto;padding:16px 24px 0;display:flex;gap:7px;flex-wrap:wrap}
.tab{font:inherit;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--line);
  background:var(--surface);color:var(--muted);padding:7px 14px;border-radius:999px}
.tab.on{background:var(--navy);border-color:var(--navy);color:#fff}
.tab:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.wrap{max-width:760px;margin:0 auto;padding:14px 24px 70px}
.range{font-size:12.5px;font-weight:600;color:var(--faint);margin-bottom:12px}
.pane{display:none}.pane.on{display:block}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}
@media (max-width:560px){.tiles{grid-template-columns:repeat(2,1fr)}}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:10px;
  padding:13px 14px;box-shadow:var(--shadow)}
.tile .k{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.tile .v{font-size:27px;font-weight:800;line-height:1.1;margin:5px 0 2px;font-variant-numeric:tabular-nums}
.tile .s{font-size:11.5px;color:var(--muted)}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:10px;
  padding:16px 17px;box-shadow:var(--shadow);margin-bottom:14px}
.panel h2{font-size:14.5px;font-weight:700;margin-bottom:12px;display:flex;
  justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.legend{font-size:11.5px;font-weight:600;color:var(--faint);display:flex;align-items:center;gap:6px}
.legend i{display:inline-block}
.sw-bar{width:9px;height:9px;border-radius:2px;background:var(--accent)}
.sw-dot{width:9px;height:9px;border-radius:50%;background:var(--good);margin-left:8px}
.chart{width:100%;height:auto;display:block;overflow:visible}
.bar{fill:var(--accent)}.dot{fill:var(--good)}
.ax{fill:var(--faint);font-size:10.5px;font-weight:600}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:13.5px;min-width:480px}
th,td{text-align:right;padding:8px 9px;border-bottom:1px solid var(--line);
  font-variant-numeric:tabular-nums;white-space:nowrap}
th{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
  color:var(--faint);border-bottom-width:1.5px}
th.nm,td.nm{text-align:left;white-space:normal;min-width:190px;font-weight:600}
tbody tr:last-child td{border-bottom:0}
td.hit{color:var(--good);font-weight:800}
.fine{font-size:11.5px;color:var(--faint);margin-top:10px;max-width:62ch}
.flag{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--line);
  border-radius:8px;padding:11px 14px;font-size:13.5px;color:var(--muted);margin-bottom:10px}
.flag.warn{border-left-color:var(--accent);background:var(--accent-wash);color:var(--ink)}
.flag b{color:var(--ink)}
.faint{color:var(--faint);font-weight:500}
.mail{background:var(--surface);border:1px solid var(--line);border-radius:10px;
  padding:16px 17px;box-shadow:var(--shadow);margin-top:26px}
.mail h2{font-size:14.5px;font-weight:700;margin-bottom:4px}
.mail .fine{margin:0 0 12px}
textarea{width:100%;min-height:270px;font:inherit;font-size:12.5px;line-height:1.55;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--sunk);
  color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:12px;resize:vertical}
.copy{margin-top:10px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;
  background:var(--accent);color:#fff;border:0;border-radius:8px;padding:9px 16px}
.copy:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.stamp{font-size:11.5px;color:var(--faint);max-width:760px;margin:16px auto 0;padding:0 24px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="top"><div class="in">
  <div class="eyebrow">JAGG Roofing, Siding &amp; Windows</div>
  <h1>Facebook group campaign</h1>
  <p>Every tracked link and every form submission, live. Nothing here is estimated.</p>
</div></div>

<div class="tabs">${nav}</div>
<div class="wrap">
  ${flags.join('')}
  ${panes}

  <div class="mail">
    <h2>Weekly email</h2>
    <p class="fine">Reviewed together, then sent as-is. Edit in place before you copy.</p>
    <textarea id="mail" spellcheck="false">${esc(email)}</textarea>
    <button class="copy" id="cp">Copy to clipboard</button>
  </div>
</div>
<p class="stamp">Updated ${esc(prettyDay(nowLocal.year + '-' + nowLocal.month + '-' + nowLocal.day))}
  at ${esc(nowLocal.hour + ':' + nowLocal.minute)} Eastern. Reload for current numbers.
  Preview fetches by Facebook are counted separately and never shown as clicks.</p>

<script>
document.querySelectorAll('.tab').forEach(function(b){
  b.addEventListener('click', function(){
    var k = b.dataset.p;
    document.querySelectorAll('.tab').forEach(function(x){ x.classList.toggle('on', x === b); });
    document.querySelectorAll('.pane').forEach(function(x){ x.classList.toggle('on', x.dataset.p === k); });
  });
});
document.getElementById('cp').addEventListener('click', function(){
  var t = document.getElementById('mail');
  t.select();
  navigator.clipboard.writeText(t.value).then(function(){
    var b = document.getElementById('cp'), was = b.textContent;
    b.textContent = 'Copied'; setTimeout(function(){ b.textContent = was; }, 1600);
  }).catch(function(){ document.execCommand('copy'); });
});
</script>`;
}
