(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- country selector ---------- */
  var countrySel = $('country');
  var flag = $('flag');
  window.JAGG_COUNTRIES.forEach(function (c) {
    var o = document.createElement('option');
    o.value = c[1];
    o.textContent = c[0];
    o.dataset.dial = c[2];
    countrySel.appendChild(o);
  });
  countrySel.value = 'US';

  function flagFor(iso2) {
    if (!iso2 || iso2.length !== 2) return '🌐';
    return String.fromCodePoint.apply(null, iso2.toUpperCase().split('').map(function (ch) {
      return 0x1f1a5 + ch.charCodeAt(0);
    }));
  }
  countrySel.addEventListener('change', function () {
    flag.textContent = flagFor(countrySel.value);
  });

  /* ---------- state selector ---------- */
  var stateSel = $('state');
  window.JAGG_STATES.forEach(function (s) {
    var o = document.createElement('option');
    o.value = s[0];
    o.textContent = s[1];
    stateSel.appendChild(o);
  });

  /* ---------- phone formatting (US/CA) ---------- */
  var phone = $('phone');
  phone.addEventListener('input', function () {
    var dial = countrySel.selectedOptions[0] && countrySel.selectedOptions[0].dataset.dial;
    if (dial !== '1') return;
    var d = phone.value.replace(/\D/g, '').slice(0, 10);
    if (d.length > 6) phone.value = d.slice(0, 3) + ' ' + d.slice(3, 6) + '-' + d.slice(6);
    else if (d.length > 3) phone.value = d.slice(0, 3) + ' ' + d.slice(3);
    else phone.value = d;
  });

  /* ---------- address autocomplete (Worker-proxied, keyless) ---------- */
  var street = $('street1');
  var box = $('suggest');
  var items = [];
  var cursor = -1;
  var timer = null;
  var lastQuery = '';

  function closeBox() {
    box.hidden = true;
    box.innerHTML = '';
    items = [];
    cursor = -1;
    street.setAttribute('aria-expanded', 'false');
  }

  function choose(it) {
    street.value = it.street || street.value;
    if (it.city) $('city').value = it.city;
    if (it.state) stateSel.value = it.state;
    if (it.zip) $('zip').value = it.zip;
    closeBox();
  }

  function render() {
    box.innerHTML = '';
    items.forEach(function (it, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.textContent = it.label;
      b.addEventListener('mousedown', function (e) { e.preventDefault(); choose(it); });
      box.appendChild(b);
      if (i === cursor) b.setAttribute('aria-selected', 'true');
    });
    box.hidden = items.length === 0;
    street.setAttribute('aria-expanded', items.length ? 'true' : 'false');
  }

  street.addEventListener('input', function () {
    var q = street.value.trim();
    clearTimeout(timer);
    if (q.length < 4) { closeBox(); return; }
    timer = setTimeout(function () {
      if (q === lastQuery) return;
      lastQuery = q;
      fetch('/api/geo?q=' + encodeURIComponent(q))
        .then(function (r) { return r.ok ? r.json() : { results: [] }; })
        .then(function (data) {
          items = (data.results || []).slice(0, 6);
          cursor = -1;
          render();
        })
        .catch(closeBox);
    }, 250);
  });

  street.addEventListener('keydown', function (e) {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, items.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(cursor - 1, 0); render(); }
    else if (e.key === 'Enter' && cursor >= 0) { e.preventDefault(); choose(items[cursor]); }
    else if (e.key === 'Escape') closeBox();
  });
  street.addEventListener('blur', function () { setTimeout(closeBox, 150); });

  /* ---------- "Other" service ---------- */
  var otherWrap = $('otherWrap');
  document.querySelectorAll('input[name=service]').forEach(function (r) {
    r.addEventListener('change', function () {
      var isOther = r.value === '__other__' && r.checked;
      otherWrap.hidden = !isOther;
      if (isOther) $('serviceOther').focus();
    });
  });

  /* ---------- validation + submit ---------- */
  var form = $('estimateForm');
  var btn = $('submitBtn');
  var formErr = $('formErr');

  function showErr(key, on) {
    var el = document.querySelector('.err[data-for="' + key + '"]');
    if (el) el.classList.toggle('show', !!on);
  }

  function validate() {
    var ok = true;
    var name = $('name').value.trim();
    showErr('name', !name); if (!name) ok = false;

    var digits = phone.value.replace(/\D/g, '');
    var badPhone = digits.length < 7;
    showErr('phone', badPhone); if (badPhone) ok = false;

    var email = $('email').value.trim();
    var badEmail = email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
    showErr('email', badEmail); if (badEmail) ok = false;

    var badAddr = !street.value.trim() || !$('city').value.trim() || !stateSel.value || !$('zip').value.trim();
    showErr('address', badAddr); if (badAddr) ok = false;

    return ok;
  }


  /* ---------- one question per screen -------------------------------------
     The form used to show all 13 fields at once, with name, phone AND full
     home address required before anything else. 51 people clicked through from
     Facebook and none of them submitted. A stranger on a phone will not hand
     over their address as the opening move, so the order is now: what they
     need (one tap), name, phone, email, address last. Same fields, same
     payload -- only the order and the pacing changed.
  ---------------------------------------------------------------------------*/
  var steps = [].slice.call(document.querySelectorAll('.step'));
  var barFill = $('barFill');
  var actions = $('actions');
  var at = 0;

  function show(i, focus) {
    at = Math.max(0, Math.min(steps.length - 1, i));
    if (typeof FUNNEL !== 'undefined') FUNNEL.reach(at);
    steps.forEach(function (s, n) { s.hidden = n !== at; });
    actions.hidden = at !== steps.length - 1;
    // Shrink the logo and offer band once they are past step 1, so the tallest
    // step still lands its submit button above the fold on a phone.
    document.querySelector('.card').toggleAttribute('data-past-first', at > 0);
    barFill.style.width = Math.round(((at + 1) / steps.length) * 100) + '%';
    formErr.classList.remove('show');
    if (focus !== false) {
      var f = steps[at].querySelector('input:not([type=radio]),select');
      if (f && window.matchMedia('(min-width:768px)').matches) f.focus();
    }
    steps[at].scrollIntoView({ block: 'nearest' });
  }

  // Validate only what is on screen, so an untouched later step cannot block.
  var CHECK = {
    2: function () { return !!$('name').value.trim() || (showErr('name', true), false); },
    3: function () {
      var bad = phone.value.replace(/\D/g, '').length < 7;
      showErr('phone', bad); return !bad;
    },
    4: function () {
      var v = $('email').value.trim();
      var bad = v !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
      showErr('email', bad); return !bad;
    }
  };
  function stepOk(n) { return CHECK[n] ? CHECK[n]() : true; }

  steps.forEach(function (sec) {
    var n = +sec.dataset.step;
    var next = sec.querySelector('.next');
    if (next) next.addEventListener('click', function () { if (stepOk(n)) show(at + 1); });
    var back = sec.querySelector('.back');
    if (back) back.addEventListener('click', function () { show(at - 1); });
    var skip = sec.querySelector('.skip');
    if (skip) skip.addEventListener('click', function () { show(at + 1); });
    sec.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'radio') {
        e.preventDefault();
        if (stepOk(n)) show(at + 1);
      }
    });
  });

  // Picking a service is the whole of step 1, so move on as soon as they pick
  // -- unless they chose Other, which needs the text box first.
  document.querySelectorAll('input[name=service]').forEach(function (r) {
    r.addEventListener('change', function () {
      if (r.value === '__other__') return;
      setTimeout(function () { show(1); }, 180);
    });
  });
  var otherBox = $('serviceOther');
  if (otherBox) otherBox.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); show(1); }
  });


  /* ---------- funnel tracking ----------------------------------------------
     76 people clicked through from Facebook and none of them submitted, and
     we could not say whether they bounced on sight or gave up at the address.
     That is the difference between a copy problem and a form problem, and we
     were guessing. This records HOW FAR each visit got, and nothing else.

     It never sends a field value. Not the name, not the phone, not the
     address, not a keystroke -- only which step number was reached, the link
     slug that brought them, and whether they were on a phone. A funnel that
     collects the answers would be a second copy of the customer's personal
     details sitting in a stats table, which is not a trade worth making to
     learn where people stop.
  ---------------------------------------------------------------------------*/
  var FUNNEL = (function () {
    var slug = (location.search.match(/[?&]rtw_pid=([A-Za-z0-9_-]{1,24})/) || [])[1] || '';
    var sid = '';
    try {
      sid = sessionStorage.getItem('jagg_sid') || '';
      if (!sid) {
        sid = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
        sessionStorage.setItem('jagg_sid', sid);
      }
    } catch (e) {
      // Private mode, or storage blocked. One beacon per step still lands; it
      // just cannot be stitched into a single visit. Better than no funnel.
      sid = 'nostore-' + Math.random().toString(36).slice(2, 10);
    }
    var furthest = -1;
    var sent = -1;

    function body(step, done) {
      return JSON.stringify({
        sid: sid, slug: slug, step: step, done: done ? 1 : 0,
        mobile: /mobile|android|iphone/i.test(navigator.userAgent) ? 1 : 0
      });
    }
    function send(step, done, beacon) {
      var payload = body(step, done);
      if (beacon && navigator.sendBeacon) {
        try { navigator.sendBeacon('/api/funnel', new Blob([payload], { type: 'application/json' })); return; }
        catch (e) { /* fall through to fetch */ }
      }
      try {
        fetch('/api/funnel', { method: 'POST', headers: { 'content-type': 'application/json' },
                               body: payload, keepalive: true }).catch(function () {});
      } catch (e) {}
    }
    return {
      reach: function (step) {
        if (step <= furthest) return;          // only ever moves forward
        furthest = step;
        if (furthest > sent) { sent = furthest; send(furthest, false, false); }
      },
      submitted: function () { send(99, true, false); },
      flush: function () { if (furthest >= 0) send(furthest, false, true); }
    };
  })();

  // A visit that never comes back is the one we most need to count, so the
  // furthest step goes out again on the way out. pagehide fires where unload
  // does not on mobile Safari.
  window.addEventListener('pagehide', FUNNEL.flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') FUNNEL.flush();
  });

  show(0, false);
  FUNNEL.reach(0);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    formErr.classList.remove('show');
    if (!validate()) {
      var firstBad = document.querySelector('.err.show');
      if (firstBad) {
        var sec = firstBad.closest('.step');
        if (sec) show(steps.indexOf(sec));
      }
      return;
    }

    var picked = document.querySelector('input[name=service]:checked');
    var service = '';
    if (picked) service = picked.value === '__other__' ? ($('serviceOther').value.trim() || 'Other') : picked.value;

    var dial = (countrySel.selectedOptions[0] && countrySel.selectedOptions[0].dataset.dial) || '';
    var payload = {
      name: $('name').value.trim(),
      phone: phone.value.trim(),
      phoneDigits: phone.value.replace(/\D/g, ''),
      countryCode: countrySel.value,
      dialCode: dial,
      email: $('email').value.trim(),
      street1: street.value.trim(),
      city: $('city').value.trim(),
      state: stateSel.value,
      zip: $('zip').value.trim(),
      service: service,
      pageUrl: location.href,
      referrer: document.referrer || '',
      utm: location.search || ''
    };

    btn.disabled = true;
    btn.textContent = 'Submitting…';

    fetch('/api/lead', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.body.ok) throw new Error(res.body && res.body.error || 'Submission failed');
        FUNNEL.submitted();
        $('estimateForm').hidden = true;
        var first = payload.name.split(/\s+/)[0];
        $('thanksTitle').textContent = 'Thank you ' + first + '!';
        $('thanks').hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Submit';
        formErr.textContent = 'Something went wrong sending your request. Please call us or try again.';
        formErr.classList.add('show');
        console.error(err);
      });
  });
})();
