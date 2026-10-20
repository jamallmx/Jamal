import { SLOTS, LANGS } from './i18n.js';
import { shortCode } from './seal.js';

export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

const csrfField = (c) => `<input type="hidden" name="_csrf" value="${esc(c.csrf)}">`;
const errorBox = (c, error) => (error ? `<p class="error" role="alert">${esc(c.t(error))}</p>` : '');
const fmtTime = (c, iso) =>
  new Date(iso).toLocaleString(c.lang === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }) + ' UTC';

export function layout(c, title, body) {
  const langLinks = LANGS.filter((l) => l !== c.lang)
    .map((l) => `<a href="/lang/${l}?next=${encodeURIComponent(c.path)}">${l === 'ar' ? 'العربية' : 'English'}</a>`)
    .join('');
  const account = c.shop
    ? `<form method="post" action="/logout" class="inline">${csrfField(c)}<button class="link">${esc(c.t('logout'))}</button></form>`
    : '';
  return `<!doctype html>
<html lang="${c.lang}" dir="${c.lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(c.t('brand'))}</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="top">
  <a class="brand" href="/">${esc(c.t('brand'))}</a>
  <nav>${langLinks}${account}</nav>
</header>
<main>${body}</main>
<script src="/static/app.js" defer></script>
</body>
</html>`;
}

export function landing(c) {
  return layout(
    c,
    c.t('tagline'),
    `<section class="hero">
  <h1>${esc(c.t('tagline'))}</h1>
  <p class="lead">${esc(c.t('landing_lead'))}</p>
  <ul class="points">
    <li>${esc(c.t('landing_point1'))}</li>
    <li>${esc(c.t('landing_point2'))}</li>
    <li>${esc(c.t('landing_point3'))}</li>
  </ul>
  <p><a class="button" href="/register">${esc(c.t('get_started'))}</a> <a class="button secondary" href="/login">${esc(c.t('login'))}</a></p>
</section>`
  );
}

export function register(c, { error, values = {} } = {}) {
  return layout(
    c,
    c.t('register'),
    `<section class="card narrow">
  <h1>${esc(c.t('register'))}</h1>
  ${errorBox(c, error)}
  <form method="post" action="/register">
    <label>${esc(c.t('shop_name'))}<input name="shop_name" required maxlength="100" value="${esc(values.shop_name)}"></label>
    <label>${esc(c.t('email'))}<input name="email" type="email" required maxlength="200" value="${esc(values.email)}"></label>
    <label>${esc(c.t('password'))}<input name="password" type="password" required minlength="8"></label>
    <button>${esc(c.t('register'))}</button>
  </form>
  <p>${esc(c.t('have_account'))} <a href="/login">${esc(c.t('login'))}</a></p>
</section>`
  );
}

export function login(c, { error, values = {} } = {}) {
  return layout(
    c,
    c.t('login'),
    `<section class="card narrow">
  <h1>${esc(c.t('login'))}</h1>
  ${errorBox(c, error)}
  <form method="post" action="/login">
    <label>${esc(c.t('email'))}<input name="email" type="email" required value="${esc(values.email)}"></label>
    <label>${esc(c.t('password'))}<input name="password" type="password" required></label>
    <button>${esc(c.t('login'))}</button>
  </form>
  <p>${esc(c.t('no_account'))} <a href="/register">${esc(c.t('register'))}</a></p>
</section>`
  );
}

const statusBadge = (c, status) => `<span class="badge ${esc(status)}">${esc(c.t(`status_${status}`))}</span>`;

export function dashboard(c, { rentals, error, values = {} }) {
  const rows = rentals.length
    ? rentals
        .map(
          (r) => `<li><a href="/rentals/${r.id}"><strong>${esc(r.asset)}</strong><span>${esc(r.customer_name)}</span></a>${statusBadge(c, r.status)}</li>`
        )
        .join('')
    : `<li class="empty">${esc(c.t('no_rentals'))}</li>`;
  return layout(
    c,
    c.t('dashboard'),
    `<h1>${esc(c.shop.name)}</h1>
<section class="card">
  <h2>${esc(c.t('new_rental'))}</h2>
  ${errorBox(c, error)}
  <form method="post" action="/rentals" class="grid">
    ${csrfField(c)}
    <label>${esc(c.t('asset'))}<input name="asset" required maxlength="120" value="${esc(values.asset)}"></label>
    <label>${esc(c.t('customer_name'))}<input name="customer_name" required maxlength="120" value="${esc(values.customer_name)}"></label>
    <label>${esc(c.t('customer_phone'))}<input name="customer_phone" type="tel" inputmode="tel" maxlength="30" placeholder="+20 100 000 0000" value="${esc(values.customer_phone)}"></label>
    <button>${esc(c.t('create'))}</button>
  </form>
</section>
<section>
  <h2>${esc(c.t('dashboard'))}</h2>
  <ul class="rentals">${rows}</ul>
</section>`
  );
}

function whatsappLink(c, rental, inspection, url) {
  const text = `${c.t('wa_message', {
    kind: c.t(`kind_${inspection.kind}`),
    asset: rental.asset,
    code: shortCode(inspection.seal_hash),
  })} ${url}`;
  const phone = rental.customer_phone.replace(/\D/g, '');
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

export function rental(c, { rental, inspections, publicUrl }) {
  const byKind = Object.fromEntries(inspections.map((i) => [i.kind, i]));
  const block = (kind) => {
    const ins = byKind[kind];
    if (ins) {
      return `<div class="card sealed">
  <h2>${esc(c.t(`kind_${kind}`))} ✓</h2>
  <p>${esc(c.t('sealed_at'))}: ${esc(fmtTime(c, ins.sealed_at))}</p>
  <p>${esc(c.t('seal_code'))}: <code class="seal">${esc(shortCode(ins.seal_hash))}</code></p>
  <p><a class="button whatsapp" href="${esc(whatsappLink(c, rental, ins, publicUrl))}" target="_blank" rel="noopener">${esc(c.t('share_customer'))}</a></p>
</div>`;
    }
    const allowed = (kind === 'pickup' && rental.status === 'new') || (kind === 'return' && rental.status === 'out');
    return allowed
      ? `<p><a class="button big" href="/rentals/${rental.id}/inspect/${kind}">${esc(c.t(`start_${kind}`))}</a></p>`
      : '';
  };
  return layout(
    c,
    rental.asset,
    `<p><a href="/dashboard">← ${esc(c.t('back'))}</a></p>
<h1>${esc(rental.asset)} ${statusBadge(c, rental.status)}</h1>
<p>${esc(c.t('customer'))}: ${esc(rental.customer_name)} ${rental.customer_phone ? `· <bdi>${esc(rental.customer_phone)}</bdi>` : ''}</p>
${block('pickup')}
${block('return')}
<p>${esc(c.t('customer_link'))}: <a href="${esc(publicUrl)}">${esc(c.t('open_report'))}</a></p>`
  );
}

function signaturePad(c, name) {
  return `<div class="sig">
  <span>${esc(c.t(name))}</span>
  <canvas data-signature="${name}" width="600" height="200"></canvas>
  <input type="hidden" name="${name}">
  <button type="button" class="link" data-clear="${name}">${esc(c.t('clear'))}</button>
</div>`;
}

export function inspectForm(c, { rental, kind, error }) {
  const slots = SLOTS.map(
    (slot) => `<label class="slot">
  <span>${esc(c.t(`slot_${slot}`))}</span>
  <input type="file" name="photo_${slot}" accept="image/*" capture="environment">
  <img alt="" hidden>
</label>`
  ).join('');
  return layout(
    c,
    c.t(`kind_${kind}`),
    `<p><a href="/rentals/${rental.id}">← ${esc(c.t('back'))}</a></p>
<h1>${esc(c.t(`kind_${kind}`))}: ${esc(rental.asset)}</h1>
<p>${esc(c.t('customer'))}: ${esc(rental.customer_name)}</p>
${errorBox(c, error)}
<form method="post" action="/rentals/${rental.id}/inspect/${kind}" enctype="multipart/form-data" class="inspect"
      data-err-photos="${esc(c.t('err_photos'))}" data-err-signatures="${esc(c.t('err_signatures'))}">
  ${csrfField(c)}
  <h2>${esc(c.t('photos'))}</h2>
  <div class="slots">${slots}</div>
  <label>${esc(c.t('slot_extra'))}<input type="file" name="photo_extra" accept="image/*" multiple></label>
  <label>${esc(c.t('reading'))}<input name="reading" maxlength="100"></label>
  <label>${esc(c.t('notes'))}<textarea name="notes" rows="3" maxlength="2000"></textarea></label>
  <div class="sigs">
    ${signaturePad(c, 'staff_signature')}
    ${signaturePad(c, 'customer_signature')}
  </div>
  <p class="hint">${esc(c.t(`customer_confirm_${kind}`))}</p>
  <button class="big">${esc(c.t('seal_submit'))}</button>
</form>`
  );
}

function photoImg(token, photo, label) {
  return `<a href="/r/${esc(token)}/photo/${photo.id}" target="_blank"><img loading="lazy" src="/r/${esc(token)}/photo/${photo.id}" alt="${esc(label)}"></a>`;
}

export function report(c, { rental, shopName, inspections, photosByInspection }) {
  const token = rental.public_token;
  const byKind = Object.fromEntries(inspections.map((i) => [i.kind, i]));

  const sections = inspections
    .map((ins) => {
      const photos = photosByInspection[ins.id];
      return `<section class="card">
  <h2>${esc(c.t(`kind_${ins.kind}`))}</h2>
  <p>${esc(c.t('sealed_at'))}: ${esc(fmtTime(c, ins.sealed_at))}</p>
  <p>${esc(c.t('seal_code'))}: <code class="seal">${esc(shortCode(ins.seal_hash))}</code></p>
  ${ins.reading ? `<p>${esc(c.t('reading'))}: ${esc(ins.reading)}</p>` : ''}
  ${ins.notes ? `<p class="notes">${esc(ins.notes)}</p>` : ''}
  <div class="gallery">${photos
    .map((p) => `<figure>${photoImg(token, p, c.t(`slot_${p.slot}`))}<figcaption>${esc(c.t(`slot_${p.slot}`))}</figcaption></figure>`)
    .join('')}</div>
  <div class="sig-view">
    <figure><img src="/r/${esc(token)}/sig/${ins.id}/staff" alt=""><figcaption>${esc(c.t('staff_signature'))}</figcaption></figure>
    <figure><img src="/r/${esc(token)}/sig/${ins.id}/customer" alt=""><figcaption>${esc(c.t('customer_signature'))} · ${esc(rental.customer_name)}</figcaption></figure>
  </div>
</section>`;
    })
    .join('');

  let comparison = '';
  if (byKind.pickup && byKind.return) {
    const before = photosByInspection[byKind.pickup.id];
    const after = photosByInspection[byKind.return.id];
    const slots = [...new Set([...before, ...after].map((p) => p.slot))].sort(
      (a, b) => (SLOTS.indexOf(a) + 1 || 99) - (SLOTS.indexOf(b) + 1 || 99)
    );
    const cell = (list, slot) =>
      list
        .filter((p) => p.slot === slot)
        .map((p) => photoImg(token, p, c.t(`slot_${slot}`)))
        .join('') || '—';
    comparison = `<section class="card">
  <h2>${esc(c.t('compare'))}</h2>
  <table class="compare">
    <thead><tr><th></th><th>${esc(c.t('before'))}</th><th>${esc(c.t('after'))}</th></tr></thead>
    <tbody>${slots
      .map((slot) => `<tr><th>${esc(c.t(`slot_${slot}`))}</th><td>${cell(before, slot)}</td><td>${cell(after, slot)}</td></tr>`)
      .join('')}</tbody>
  </table>
</section>`;
  }

  return layout(
    c,
    rental.asset,
    `<h1>${esc(rental.asset)}</h1>
<p>${esc(c.t('shop'))}: ${esc(shopName)} · ${esc(c.t('customer'))}: ${esc(rental.customer_name)}</p>
<p class="actions">
  <a class="button" href="/r/${esc(token)}/verify">${esc(c.t('verify'))}</a>
  <a class="button secondary" href="/r/${esc(token)}/evidence.json" download>${esc(c.t('evidence'))}</a>
  <button type="button" class="secondary" data-print>${esc(c.t('print'))}</button>
</p>
${comparison}
${sections || `<p>${esc(c.t('verify_none'))}</p>`}`
  );
}

export function verify(c, { rental, result }) {
  const status = !result.inspections.length ? 'verify_none' : result.ok ? 'verify_ok' : 'verify_fail';
  const list = result.checks
    .map((ch) => `<li class="${ch.ok ? 'ok' : 'bad'}">${ch.ok ? '✓' : '✗'} ${esc(c.t(`kind_${ch.kind}`))}: ${esc(c.t(ch.key))}</li>`)
    .join('');
  const seals = result.inspections
    .map((ins) => `<p>${esc(c.t(`kind_${ins.kind}`))} · ${esc(c.t('seal_code'))}: <code class="seal">${esc(shortCode(ins.seal_hash))}</code><br><code class="hash">${esc(ins.seal_hash)}</code></p>`)
    .join('');
  return layout(
    c,
    c.t('verify'),
    `<p><a href="/r/${esc(rental.public_token)}">← ${esc(c.t('back'))}</a></p>
<h1>${esc(c.t('verify'))}</h1>
<p class="verdict ${result.ok ? 'ok' : 'bad'}" data-verdict="${result.ok ? 'ok' : 'fail'}">${esc(c.t(status))}</p>
<ul class="checks">${list}</ul>
${seals}
<p class="hint">${esc(c.t('verify_hint'))}</p>`
  );
}

export function message(c, title, text) {
  return layout(c, title, `<section class="card narrow"><p>${esc(text)}</p><p><a href="/">${esc(c.t('back'))}</a></p></section>`);
}
