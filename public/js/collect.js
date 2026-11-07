/* Collection pass: the QR a collector shows, and the handover confirmation page. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs, icon, escapeHtml, avatar, toast, confirmDialog, formatDate, formatTime } = LNF;

  const root = qs('#collect-page');
  const token = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] || '');
  let data = null;
  let timer = null;

  function clearTimer() {
    if (timer) window.clearInterval(timer);
    timer = null;
  }

  function expiryText(iso) {
    const left = Date.parse(iso) - Date.now();
    if (!Number.isFinite(left) || left <= 0) return 'Expired';
    const minutes = Math.floor(left / 60000);
    const seconds = Math.floor((left % 60000) / 1000);
    return 'Expires in ' + minutes + ':' + String(seconds).padStart(2, '0');
  }

  function shortWhen(iso) {
    return formatDate(iso) + ' · ' + formatTime(iso);
  }

  function listingMini(item) {
    const thumb = item.image
      ? '<img src="' + escapeHtml(item.image.url) + '" alt="" class="pass-thumb" />'
      : '<span class="pass-thumb pass-thumb-empty">' + icon('image') + '</span>';
    return (
      '<div class="pass-listing">' + thumb +
      '<div><span class="pass-listing-type">' + (item.type === 'found' ? 'I FOUND · Finder' : 'I LOST · Collector') + '</span>' +
      '<strong>' + escapeHtml(item.title) + '</strong>' +
      '<span class="hint">' + escapeHtml(item.city) + (item.area ? ' · ' + escapeHtml(item.area) : '') + '</span></div>' +
      '<a class="btn btn-ghost btn-sm" href="/item/' + encodeURIComponent(item.id) + '">Listing</a></div>'
    );
  }

  function identityCard(collector, options) {
    const opts = options || {};
    return (
      '<div class="pass-identity">' + avatar(collector, 'lg') +
      '<div class="pass-identity-text"><strong>' + escapeHtml(collector.fullName) + '</strong>' +
      '<span class="hint">@' + escapeHtml(collector.username) + ' · ' + escapeHtml(collector.city || 'Location private') + '</span>' +
      (collector.email
        ? '<span class="pass-email">' + icon('shield') + escapeHtml(collector.email) + '</span>'
        : '<span class="pass-email muted">' + icon('lock') + 'Email visible only to the person handing over</span>') +
      '</div>' +
      (collector.accountVerified
        ? '<span class="verified-pill">' + icon('check-circle') + 'Verified account</span>'
        : '<span class="verified-pill pending">' + icon('clock') + 'Awaiting verification</span>') +
      '</div>' +
      (opts.note ? '<p class="hint" style="margin-top:10px">' + escapeHtml(opts.note) + '</p>' : '')
    );
  }

  function shell(inner) {
    root.innerHTML = '<div class="pass-shell">' + inner + '</div>';
  }

  function renderError(message) {
    shell(
      '<section class="panel pass-card">' +
      '<div class="pass-icon muted">' + icon('alert') + '</div>' +
      '<h1>That code cannot be used</h1>' +
      '<p class="pass-lede">' + escapeHtml(message || 'This collection code is not valid. Ask the collector to show a fresh one.') + '</p>' +
      '<div class="row" style="justify-content:center;gap:10px"><a class="btn btn-primary" href="/explore">Browse listings</a>' +
      '<a class="btn btn-outline" href="/">Home</a></div></section>',
    );
  }

  function renderSignIn() {
    shell(
      '<section class="panel pass-card">' +
      '<div class="pass-icon">' + icon('qr') + '</div>' +
      '<span class="pass-eyebrow">Collection pass</span>' +
      '<h1>Sign in to verify this handover</h1>' +
      '<p class="pass-lede">' +
      (data.collector ? escapeHtml(data.collector.fullName) + ' is collecting ' : 'Someone is collecting ') +
      '“' + escapeHtml(data.listing.title) + '”. Sign in to see their verified account and confirm the handover.</p>' +
      '<div class="row" style="justify-content:center;gap:10px">' +
      '<a class="btn btn-primary" href="/login?next=' + encodeURIComponent('/collect/' + token) + '">Sign in to continue</a>' +
      '<a class="btn btn-outline" href="/item/' + encodeURIComponent(data.listing.id) + '">View listing</a></div></section>',
    );
  }

  function renderCollector() {
    const collector = data.collector || {};
    shell(
      '<div class="pass-layout">' +
      '<section class="panel pass-card">' +
      '<span class="pass-eyebrow">Collection pass</span>' +
      '<h1>Show this code at handover</h1>' +
      '<p class="pass-lede">The person handing over the item scans this once. They will see your name and verified email before they confirm.</p>' +
      '<div class="qr-frame"><img src="/api/collection/' + encodeURIComponent(token) + '/qr.svg" alt="Your collection QR code" width="320" height="320" /></div>' +
      '<p class="pass-expiry" id="pass-expiry">' + escapeHtml(expiryText(data.pass.expiresAt)) + '</p>' +
      '<div class="row" style="justify-content:center;gap:10px;flex-wrap:wrap">' +
      '<button class="btn btn-outline" type="button" id="copy-btn">' + icon('link') + 'Copy link</button>' +
      '<a class="btn btn-outline" href="/item/' + encodeURIComponent(data.listing.id) + '">View listing</a>' +
      '</div>' +
      '<p class="hint" style="margin-top:14px">Never share this code with anyone who is not handing you the item. It works once and expires in ten minutes.</p>' +
      '</section>' +
      '<aside class="pass-side">' +
      '<div class="panel"><div class="panel-head"><h3>' + icon('user') + ' Collector</h3></div>' +
      '<div class="panel-body">' + identityCard(collector, { note: 'This is what the person handing over will see.' }) + '</div></div>' +
      '<div class="panel"><div class="panel-head"><h3>' + icon('bag') + ' Item</h3></div>' +
      '<div class="panel-body">' + listingMini(data.listing) + '</div></div>' +
      '<div class="panel"><div class="panel-body"><h3 style="margin-bottom:8px">' + icon('shield') + ' How it works</h3>' +
      '<ol class="pass-steps"><li>They scan your code.</li><li>They check your name and email.</li><li>They hand over the item and confirm.</li><li>The listing closes and they earn 10 points.</li></ol>' +
      '</div></div>' +
      '</aside></div>',
    );

    const copy = qs('#copy-btn', root);
    if (copy) {
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(window.location.href);
          toast('Collection link copied.', 'success');
        } catch (error) {
          toast('Copy the address from the browser bar instead.', 'error');
        }
      });
    }

    clearTimer();
    timer = window.setInterval(() => {
      const label = qs('#pass-expiry', root);
      if (!label) return;
      label.textContent = expiryText(data.pass.expiresAt);
      if (Date.now() >= Date.parse(data.pass.expiresAt)) {
        clearTimer();
        label.textContent = 'This code has expired';
        load();
      }
    }, 1000);
  }

  function renderConfirm() {
    const collector = data.collector || {};
    shell(
      '<div class="pass-layout">' +
      '<section class="panel pass-card pass-confirm">' +
      '<span class="pass-eyebrow">Verify before handing over</span>' +
      '<h1>Confirm this handover</h1>' +
      '<p class="pass-lede">Check that the person in front of you matches this account. Confirm only after you have physically handed over the item.</p>' +
      identityCard(collector, { note: 'Email is shown so you can match it against their student account.' }) +
      listingMini(data.listing) +
      '<div class="safety-note" style="text-align:left;margin-top:16px">' + icon('alert') +
      '<span>Confirming closes the listing, records the handover and gives you 10 points. It cannot be undone.</span></div>' +
      '<button class="btn btn-success btn-block" type="button" id="confirm-btn" style="margin-top:16px">' + icon('check-circle') + 'Confirm handover</button>' +
      '<p class="hint" style="margin-top:10px">Only the person handing over the item sees this button.</p>' +
      '</section>' +
      '<aside class="pass-side">' +
      '<div class="panel"><div class="panel-head"><h3>' + icon('qr') + ' Pass details</h3></div>' +
      '<div class="panel-body"><dl class="pass-facts">' +
      '<div><dt>Issued</dt><dd>' + escapeHtml(shortWhen(data.pass.issuedAt)) + '</dd></div>' +
      '<div><dt>Expires</dt><dd>' + escapeHtml(shortWhen(data.pass.expiresAt)) + '</dd></div>' +
      '<div><dt>Uses</dt><dd>Single use</dd></div>' +
      '</dl></div></div>' +
      '<div class="panel"><div class="panel-head"><h3>' + icon('shield') + ' Safe handover</h3></div>' +
      '<div class="panel-body"><p class="hint">Meet in a public place on campus. Never share OTPs, bank details or your address, and never pay to return an item.</p></div></div>' +
      '</aside></div>',
    );

    const confirm = qs('#confirm-btn', root);
    if (confirm) {
      confirm.addEventListener('click', async () => {
        const name = (data.collector && data.collector.fullName) || 'this person';
        const ok = await confirmDialog({
          title: 'Confirm this handover?',
          message: 'Only confirm once you have given the item to ' + name + '. The listing will be marked collected and the pass cannot be reused.',
          confirmText: 'Yes, handover complete',
        });
        if (!ok) return;
        confirm.disabled = true;
        try {
          const result = await api('/api/collection/' + encodeURIComponent(token) + '/confirm', { method: 'POST', body: {} });
          toast('Handover confirmed. +' + (result.points || 10) + ' points.', 'success');
          await load();
        } catch (error) {
          toast(error.message, 'error');
          confirm.disabled = false;
        }
      });
    }
  }

  function renderBystander() {
    shell(
      '<section class="panel pass-card">' +
      '<div class="pass-icon">' + icon('lock') + '</div>' +
      '<h1>This pass is not yours to confirm</h1>' +
      '<p class="pass-lede">' +
      (data.collector ? escapeHtml(data.collector.fullName) + ' is collecting ' : 'Someone is collecting ') +
      '“' + escapeHtml(data.listing.title) + '”. Only the person handing over the item can confirm this handover.</p>' +
      '<div class="row" style="justify-content:center"><a class="btn btn-outline" href="/item/' + encodeURIComponent(data.listing.id) + '">View listing</a></div>' +
      '</section>',
    );
  }

  function renderExpired() {
    const replaced = data.pass.status === 'revoked';
    const own = data.viewer.isCollector;
    shell(
      '<section class="panel pass-card">' +
      '<div class="pass-icon muted">' + icon('clock') + '</div>' +
      '<h1>' + (replaced ? 'This code was replaced' : 'This code has expired') + '</h1>' +
      '<p class="pass-lede">' +
      (own
        ? 'Collection codes last ten minutes for safety. Generate a fresh one and show that instead.'
        : 'Ask the collector to generate a fresh code from the listing. Codes last ten minutes and work once.') +
      '</p>' +
      (own
        ? '<button class="btn btn-primary" type="button" id="refresh-btn">' + icon('refresh') + 'Generate a new code</button>'
        : '<a class="btn btn-outline" href="/item/' + encodeURIComponent(data.listing.id) + '">Open the listing</a>') +
      '</section>',
    );

    const refresh = qs('#refresh-btn', root);
    if (refresh) {
      refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        try {
          const result = await api('/api/listings/' + encodeURIComponent(data.listing.id) + '/collection-pass', {
            method: 'POST',
            body: {},
          });
          window.location.href = '/collect/' + result.pass.token;
        } catch (error) {
          toast(error.message, 'error');
          refresh.disabled = false;
        }
      });
    }
  }

  function renderConfirmed() {
    const record = data.record || {};
    shell(
      '<section class="panel pass-card pass-done">' +
      '<div class="pass-icon success">' + icon('check-circle') + '</div>' +
      '<span class="pass-eyebrow">Collected</span>' +
      '<h1>Handover confirmed</h1>' +
      '<p class="pass-lede">' +
      (record.collectorName ? escapeHtml(record.collectorName) + ' collected ' : 'This item was collected: ') +
      '“' + escapeHtml(data.listing.title) + '”.</p>' +
      '<div class="record-grid">' +
      '<div><span>Status</span><strong>Collected</strong></div>' +
      '<div><span>Confirmed</span><strong>' + escapeHtml(shortWhen(record.confirmedAt || data.pass.confirmedAt)) + '</strong></div>' +
      '<div><span>Points awarded</span><strong>' + (record.points || 10) + ' to the helper</strong></div>' +
      '<div><span>Pass</span><strong>Single use, now closed</strong></div>' +
      '</div>' +
      '<div class="row" style="justify-content:center;gap:10px;margin-top:18px">' +
      '<a class="btn btn-primary" href="/item/' + encodeURIComponent(data.listing.id) + '">View collection record</a>' +
      '<a class="btn btn-outline" href="/explore">Browse listings</a></div>' +
      '</section>',
    );
  }

  function render() {
    if (!root || !data) return;
    clearTimer();
    if (data.pass.status === 'confirmed' || data.record) return renderConfirmed();
    if (data.pass.status === 'expired' || data.pass.status === 'revoked') return renderExpired();
    if (!data.viewer.signedIn) return renderSignIn();
    if (data.viewer.isCollector) return renderCollector();
    if (data.viewer.canConfirm) return renderConfirm();
    return renderBystander();
  }

  async function load() {
    if (!root) return;
    clearTimer();
    if (!token) {
      renderError('This collection link is missing its code.');
      return;
    }
    root.innerHTML = '<div class="pass-shell"><section class="panel pass-card"><div class="skeleton-line" style="height:22px;width:40%;margin:0 auto 18px"></div><div class="skeleton-line" style="height:280px;width:280px;margin:0 auto"></div></section></div>';
    try {
      data = await api('/api/collection/' + encodeURIComponent(token));
      render();
    } catch (error) {
      renderError(error.message);
    }
  }

  (async function start() {
    await LNF.boot;
    await load();
  })().catch((error) => console.error(error));
})();
