/* Item detail: gallery, details, match panel, claim, message, owner actions. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const {
    api, qs, icon, escapeHtml, avatar, money, timeAgo, formatDate,
    listingCard, emptyState, openModal, confirmDialog, toast, requireAuth,
  } = LNF;

  const root = qs('#item-page');
  const id = window.location.pathname.split('/').filter(Boolean)[1];
  let meta = { reportReasons: [] };
  let data = null;
  let activeImage = 0;
  let sendingContact = false;

  function typeBadge(item) {
    return '<span class="badge ' + item.type + '">' + (item.type === 'found' ? 'Found item' : 'Lost item') + '</span>';
  }

  function gallery(item) {
    if (!item.images || !item.images.length) {
      return '<div class="gallery"><div class="gallery-main" style="aspect-ratio:1"><div style="height:100%;display:grid;place-items:center;color:#94a3b8">' + icon('image') + '</div></div></div>';
    }
    const image = item.images[Math.min(activeImage, item.images.length - 1)];
    const thumbs =
      item.images.length > 1
        ? '<div class="gallery-thumbs">' +
          item.images
            .map(
              (entry, index) =>
                '<button type="button" data-image="' + index + '" class="' + (index === activeImage ? 'is-active' : '') + '" aria-label="Photo ' + (index + 1) + '">' +
                '<img src="' + escapeHtml(entry.url) + '" alt="" loading="lazy" /></button>',
            )
            .join('') +
          '</div>'
        : '';
    return (
      '<div class="gallery"><div class="gallery-main" style="aspect-ratio:' + (image.aspect || 0.8) + '">' +
      '<img src="' + escapeHtml(image.url) + '" alt="' + escapeHtml(item.title) + '" id="gallery-img" /></div>' +
      thumbs + '</div>'
    );
  }

  function actionButtons(item) {
    if (item.isOwner) {
      return (
        '<div class="item-actions">' +
        '<a class="btn btn-outline" href="/post?edit=' + encodeURIComponent(item.id) + '">' + icon('edit') + 'Edit listing</a>' +
        (item.status === 'active' && !item.collected
          ? '<button class="btn btn-success" type="button" id="resolve-btn">' + icon('check-circle') + 'Mark as returned</button>'
          : '') +
        '<button class="btn btn-danger" type="button" id="remove-btn">' + icon('trash') + 'Remove</button>' +
        '</div>'
      );
    }
    const contact = item.collected
      ? '<button class="btn btn-outline" type="button" disabled>' + icon('check-circle') + 'Collected</button>'
      : '<button class="btn btn-primary" type="button" id="collect-btn">' +
        icon(item.type === 'found' ? 'check-circle' : 'send') +
        (item.type === 'found' ? 'Collect' : 'Return') + '</button>';
    const claim =
      item.type === 'found'
        ? '<button class="btn btn-outline" type="button" id="claim-btn">' + icon('shield') + 'Submit a claim</button>'
        : '';
    return (
      '<div class="item-actions">' + contact + claim +
      '<button class="btn btn-outline btn-icon" type="button" id="report-btn" aria-label="Report this listing" title="Report this listing">' + icon('alert') + '</button>' +
      '</div>'
    );
  }

  function collectionPanel(item) {
    if (item.collected) {
      const collector = item.collection && item.collection.collector;
      return (
        '<div class="collected-record">' +
        '<h3>' + icon('check-circle') + 'Collected</h3>' +
        '<p>Handover verified ' + escapeHtml(timeAgo(item.collection && item.collection.confirmedAt)) +
        (collector ? ' &middot; collected by <a href="/profile/' + encodeURIComponent(collector.username) + '">@' + escapeHtml(collector.username) + '</a>' : '') +
        '. The collection pass is closed.</p>' +
        '</div>'
      );
    }
    if (item.canCollect) {
      return (
        '<div class="handover-box">' +
        '<h3>' + icon('qr') + 'Collection QR</h3>' +
        '<p class="hint">You are collecting this item. Show your QR to the person handing it over — they scan it, check your account and confirm.</p>' +
        '<button class="btn btn-primary btn-sm" type="button" id="pass-btn">' + icon('qr') + 'Show my collection QR</button>' +
        '</div>'
      );
    }
    if (item.isOwner && item.type === 'found' && item.status === 'active') {
      return (
        '<div class="handover-box">' +
        '<h3>' + icon('qr') + 'Confirm a handover</h3>' +
        '<p class="hint">When the collector shows their QR, open the code here to check their verified account before handing the item over.</p>' +
        '<div class="row" style="gap:8px;flex-wrap:wrap">' +
        '<input class="input" id="handover-code" placeholder="Paste the collection code or link" style="flex:1;min-width:200px" />' +
        '<button class="btn btn-outline btn-sm" type="button" id="handover-open">Open code</button>' +
        '</div></div>'
      );
    }
    return '';
  }

  function matchPanel(match) {
    if (!match) {
      if (data.item.isOwner) {
        return (
          '<div class="match-panel">' +
          '<div class="score-line"><strong style="font-size:14px">' + icon('sparkles') + ' Looking for a match</strong>' +
          '<span class="badge blue">Scanning</span></div>' +
          '<p class="hint" style="margin-top:8px">We compare your listing against every report of the opposite type. Suggestions appear in <a href="/matches">Possible matches</a> as new items arrive.</p>' +
          '</div>'
        );
      }
      return '';
    }
    const other = match.lost.id === data.item.id ? match.found : match.lost;
    const parts = match.parts || {};
    return (
      '<div class="match-panel">' +
      '<div class="score-line"><strong style="font-size:14px">' + icon('sparkles') + ' ' + escapeHtml(match.label) + '</strong>' +
      '<span class="badge ' + (match.tier === 'strong' ? 'blue' : match.tier === 'good' ? 'amber' : '') + '">' + Math.round(match.score * 100) + '% similarity</span></div>' +
      '<div class="score-bar"><i style="width:' + Math.round(match.score * 100) + '%"></i></div>' +
      '<p class="hint" style="margin-top:10px">Compared with <a href="/item/' + encodeURIComponent(other.id) + '">' + escapeHtml(other.title) + '</a> in ' + escapeHtml(other.city) + '. This is a suggestion, not proof of ownership.</p>' +
      '<div class="breakdown" style="margin-top:10px">' +
      '<span>Image <b>' + Math.round((parts.image || 0) * 100) + '%</b></span>' +
      '<span>Description <b>' + Math.round((parts.text || 0) * 100) + '%</b></span>' +
      '<span>Category <b>' + Math.round((parts.category || 0) * 100) + '%</b></span>' +
      '<span>Colour <b>' + Math.round((parts.color || 0) * 100) + '%</b></span>' +
      '<span>Location <b>' + Math.round((parts.location || 0) * 100) + '%</b></span></div>' +
      '<div class="match-actions">' +
      '<button class="btn btn-outline btn-sm" type="button" data-match-action="confirmed">' + icon('check') + 'This looks like the same item</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-match-action="dismissed">Not the same</button>' +
      '<a class="btn btn-ghost btn-sm" href="/matches">All suggestions</a>' +
      '</div>' +
      (match.status !== 'suggested' ? '<p class="hint" style="margin-top:8px">You marked this suggestion as <strong>' + escapeHtml(match.status) + '</strong>.</p>' : '') +
      '</div>'
    );
  }

  function render() {
    if (!root) return;
    const item = data.item;
    const related = data.related || [];
    const owner = item.owner;

    root.innerHTML =
      '<div class="spread" style="padding:18px 0 0">' +
      '<a class="btn btn-ghost btn-sm" href="/explore">' + icon('arrow-left') + 'Back to listings</a>' +
      '<span class="result-count">Posted ' + escapeHtml(timeAgo(item.createdAt)) + '</span></div>' +
      '<div class="item-layout">' +
      '<div>' + gallery(item) + '</div>' +
      '<div class="item-info">' +
      '<div class="item-badges">' + typeBadge(item) +
      (item.collected
        ? '<span class="badge returned">' + icon('check-circle') + 'Collected</span>'
        : item.status === 'returned'
          ? '<span class="badge returned">' + icon('check') + 'Reunited</span>'
          : '') +
      '<span class="badge">' + escapeHtml(item.category) + '</span>' +
      (item.reward ? '<span class="badge amber">Reward ' + money(item.reward) + '</span>' : '') +
      '</div>' +
      '<h1>' + escapeHtml(item.title) + '</h1>' +
      '<div class="item-sub">' + icon('pin') + escapeHtml(item.city) +
      (item.area ? ' &middot; ' + escapeHtml(item.area) : '') +
      '<span class="dot"></span>' + icon('clock') + ' ' + escapeHtml(formatDate(item.incidentDate)) + '</div>' +
      actionButtons(item) +
      collectionPanel(item) +
      '<div class="meta-grid">' +
      '<div><span>Category</span><strong>' + escapeHtml(item.category) + '</strong></div>' +
      '<div><span>Colour</span><strong>' + escapeHtml(item.color || 'Not specified') + '</strong></div>' +
      '<div><span>Brand</span><strong>' + escapeHtml(item.brand || 'Not specified') + '</strong></div>' +
      '<div><span>Date</span><strong>' + escapeHtml(formatDate(item.incidentDate)) + '</strong></div>' +
      '<div><span>City</span><strong>' + escapeHtml(item.city) + '</strong></div>' +
      '<div><span>Area</span><strong>' + escapeHtml(item.area || 'Withheld for privacy') + '</strong></div>' +
      '</div>' +
      matchPanel(data.match) +
      '<div class="desc-block"><h3>Description</h3><p>' + escapeHtml(item.description) + '</p></div>' +
      (item.canEdit
        ? '<div class="desc-block"><h3>Private detail (only you can see this)</h3><p>' + escapeHtml(item.privateDetail || 'Not provided') + '</p></div>'
        : item.hasPrivateDetail
          ? '<div class="safety-note" style="margin-top:18px">' + icon('lock') +
            '<span>An identifying detail is kept private. The person who posted this will ask you to confirm it before a handover, so never guess or share more than needed.</span></div>'
          : '') +
      (owner
        ? '<div class="owner-box">' + avatar(owner, 'lg') +
          '<span class="who"><strong>' + escapeHtml(owner.fullName) + '</strong>' +
          '<span>@' + escapeHtml(owner.username) + ' &middot; ' + escapeHtml(owner.city || 'Location private') + '</span></span>' +
          '<a class="btn btn-outline btn-sm" href="/profile/' + encodeURIComponent(owner.username) + '">Profile</a></div>'
        : '') +
      '<div class="safety-note">' + icon('shield') +
      '<span>Meet in a public place, verify a private detail first, and never send money, OTPs or bank details to return an item.</span></div>' +
      '</div></div>' +
      (related.length
        ? '<section class="section"><div class="section-head"><div><h2>Other ' + escapeHtml(item.category) + ' items</h2>' +
          '<p>Similar reports that may also be worth a look.</p></div></div>' +
          '<div class="masonry">' + related.map((entry) => listingCard(entry)).join('') + '</div></section>'
        : '') +
      '<div style="height:40px"></div>';

    wire();
  }

  function wire() {
    root.querySelectorAll('[data-image]').forEach((button) => {
      button.addEventListener('click', () => {
        activeImage = Number(button.dataset.image);
        render();
      });
    });

    const collectBtn = qs('#collect-btn', root);
    if (collectBtn) collectBtn.addEventListener('click', collectItem);

    const passBtn = qs('#pass-btn', root);
    if (passBtn) passBtn.addEventListener('click', startPass);

    const handoverOpen = qs('#handover-open', root);
    if (handoverOpen) handoverOpen.addEventListener('click', openHandover);

    const handoverInput = qs('#handover-code', root);
    if (handoverInput) {
      handoverInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          openHandover();
        }
      });
    }

    const claimBtn = qs('#claim-btn', root);
    if (claimBtn) claimBtn.addEventListener('click', submitClaim);

    const reportBtn = qs('#report-btn', root);
    if (reportBtn) reportBtn.addEventListener('click', reportListing);

    const resolveBtn = qs('#resolve-btn', root);
    if (resolveBtn) {
      resolveBtn.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Mark this item as returned?',
          message: 'This tells the community the item is home. It also closes open suggestions for this listing.',
          confirmText: 'Yes, it is returned',
        });
        if (!ok) return;
        try {
          await api('/api/listings/' + encodeURIComponent(id) + '/resolve', { method: 'POST', body: {} });
          toast('Marked as returned. Thank you for closing the loop.', 'success');
          await load();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    }

    const removeBtn = qs('#remove-btn', root);
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Remove this listing?',
          message: 'It will disappear from the marketplace and from suggestions. This cannot be undone.',
          confirmText: 'Remove listing',
          danger: true,
        });
        if (!ok) return;
        try {
          await api('/api/listings/' + encodeURIComponent(id), { method: 'DELETE' });
          toast('Listing removed.', 'success');
          setTimeout(() => { window.location.href = '/explore'; }, 500);
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    }

    root.querySelectorAll('[data-match-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!requireAuth('Sign in to update this suggestion.')) return;
        try {
          const result = await api('/api/matches/' + encodeURIComponent(data.match.id), {
            method: 'PATCH',
            body: { status: button.dataset.matchAction },
          });
          data.match = result.item;
          toast(button.dataset.matchAction === 'confirmed' ? 'Marked as the same item. Verify the private detail before handover.' : 'Suggestion dismissed.', 'success');
          render();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    });
  }

  /* Collect (found listing) or Return (lost listing): open the DM with the
     lister and forward a pre-written first message naming the item. */
  async function collectItem() {
    if (!requireAuth('Sign in to contact the person who posted this.')) return;
    if (sendingContact) return;
    const isFound = data.item.type === 'found';
    const text = '“' + data.item.title + '” — ' + (isFound ? 'it is mine.' : 'I found it.');
    sendingContact = true;
    try {
      const result = await api('/api/conversations', {
        method: 'POST',
        body: { listingId: data.item.id, body: text },
      });
      window.location.href = '/messages/' + encodeURIComponent(result.conversation.id);
    } catch (error) {
      toast(error.message, 'error');
      sendingContact = false;
    }
  }

  async function startPass() {
    if (!requireAuth('Sign in to show a collection QR.')) return;
    try {
      const result = await api('/api/listings/' + encodeURIComponent(data.item.id) + '/collection-pass', {
        method: 'POST',
        body: {},
      });
      window.location.href = '/collect/' + encodeURIComponent(result.pass.token);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function openHandover() {
    const input = qs('#handover-code', root);
    const value = ((input && input.value) || '').trim();
    if (!value) {
      toast('Paste the collection code or link first.', 'error');
      return;
    }
    const code = value.split('?')[0].replace(/\/+$/, '').split('/').pop();
    if (!code || code.length < 6) {
      toast('That does not look like a collection code.', 'error');
      return;
    }
    window.location.href = '/collect/' + encodeURIComponent(code);
  }

  async function submitClaim() {
    if (!requireAuth('Sign in to submit a claim.')) return;
    const value = await openModal({
      title: 'Submit a claim',
      body:
        '<p>Describe a detail that is not visible in the photos. The person who found it will compare this with the private detail on file.</p>' +
        '<div class="field"><label class="label" for="claim-body">Your detail</label>' +
        '<textarea class="textarea" id="claim-body" data-modal-input placeholder="Inside the wallet there is a folded ticket and a small photo behind the card slot." maxlength="600"></textarea></div>' +
        '<p class="hint">Claims are private. Do not include your address or phone number.</p>',
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Send claim', value: true, variant: 'primary', collect: true },
      ],
    });
    if (value === null) return;
    try {
      await api('/api/listings/' + encodeURIComponent(data.item.id) + '/claim', {
        method: 'POST',
        body: { message: String(value || '') },
      });
      toast('Claim sent. The finder will review it and reply privately.', 'success');
      await load();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function reportListing() {
    if (!requireAuth('Sign in to report a listing.')) return;
    const options = meta.reportReasons
      .map((reason) => '<option value="' + escapeHtml(reason) + '">' + escapeHtml(reason) + '</option>')
      .join('');
    const value = await openModal({
      title: 'Report this listing',
      body:
        '<p>Reports go to moderators, never to the person who posted this.</p>' +
        '<div class="field"><label class="label" for="report-reason">Reason</label>' +
        '<select class="select" id="report-reason">' + options + '</select></div>' +
        '<div class="field"><label class="label" for="report-details">What happened?</label>' +
        '<textarea class="textarea" id="report-details" placeholder="Optional details that help a moderator review this." maxlength="800"></textarea></div>',
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Submit report', value: true, variant: 'danger' },
      ],
    });
    if (!value) return;
    try {
      await api('/api/reports', {
        method: 'POST',
        body: {
          listingId: data.item.id,
          reason: qs('#report-reason').value,
          details: qs('#report-details').value,
        },
      });
      toast('Report submitted. Thank you for flagging it.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function load() {
    try {
      data = await api('/api/listings/' + encodeURIComponent(id));
      render();
    } catch (error) {
      if (!root) return;
      root.innerHTML =
        '<div style="padding:60px 0">' +
        emptyState({
          icon: 'alert',
          title: error.status === 404 ? 'This listing is no longer available' : 'Listing could not load',
          message: error.status === 404 ? 'It may have been removed by its owner or a moderator.' : error.message,
          actionLabel: 'Browse listings',
          actionHref: '/explore',
        }) + '</div>';
    }
  }

  async function start() {
    await LNF.boot;
    if (!id) {
      window.location.href = '/explore';
      return;
    }
    meta = await api('/api/meta').catch(() => ({ reportReasons: [] }));
    await load();
  }

  start().catch((error) => {
    console.error(error);
    toast('This page could not load.', 'error');
  });
})();
