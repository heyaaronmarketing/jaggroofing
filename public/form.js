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

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    formErr.classList.remove('show');
    if (!validate()) return;

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
