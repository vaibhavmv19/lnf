/* Private conversation thread with a listing summary and safety actions. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs, icon, escapeHtml, avatar, formatTime, formatDate, timeAgo, emptyState, openModal, toast } = LNF;

  const root = qs('#conversation-page');
  const id = window.location.pathname.split('/').filter(Boolean)[1];
  let data = null;
  let lastCount = 0;
  let sending = false;
  let poller = null;

  function groupDay(iso) {
    return new Date(iso).toDateString();
  }

  function body(messages) {
    if (!messages.length) {
      return '<div class="empty" style="border:0;background:none"><p>Say hello and mention a detail about the item. Keep the most important detail back until you know who you are talking to.</p></div>';
    }
    let previousDay = '';
    return messages
      .map((message) => {
        const day = groupDay(message.createdAt);
        const separator =
          day !== previousDay
            ? '<span class="day-sep">' + escapeHtml(formatDate(message.createdAt)) + '</span>'
            : '';
        previousDay = day;
        return (
          separator +
          '<div class="bubble-row' + (message.mine ? ' mine' : '') + '">' +
          (message.mine ? '' : avatar(data.other)) +
          '<div><div class="bubble">' + escapeHtml(message.body) + '</div>' +
          '<div class="bubble-time" style="' + (message.mine ? 'text-align:right' : '') + '">' + escapeHtml(formatTime(message.createdAt)) + '</div></div></div>'
        );
      })
      .join('');
  }

  function render() {
    if (!root || !data) return;
    const listing = data.listingDetail;
    root.innerHTML =
      '<div class="thread-layout">' +
      '<aside class="thread-side">' +
      '<div class="panel"><div class="panel-head"><h3>About this item</h3></div>' +
      (listing
        ? '<a class="thread-listing" href="/item/' + encodeURIComponent(listing.id) + '">' +
          '<span class="thumb">' + (listing.image ? '<img src="' + escapeHtml(listing.image.url) + '" alt="" loading="lazy" />' : '') + '</span>' +
          '<span><strong style="font-size:13.5px;display:block">' + escapeHtml(listing.title) + '</strong>' +
          '<span class="hint">' + escapeHtml(listing.type === 'lost' ? 'Lost' : 'Found') + ' &middot; ' + escapeHtml(listing.city) + '</span></span></a>' +
          '<div style="padding:0 14px 14px"><a class="btn btn-outline btn-sm btn-block" href="/item/' + encodeURIComponent(listing.id) + '">Open listing</a></div>'
        : '<div class="panel-body"><p class="hint">This listing is no longer available.</p></div>') +
      '</div>' +
      '<div class="panel"><div class="panel-body">' +
      '<div class="row" style="gap:10px">' + avatar(data.other, 'lg') +
      '<span><strong style="display:block">' + escapeHtml(data.other ? data.other.fullName : 'Member') + '</strong>' +
      '<span class="hint">@' + escapeHtml(data.other ? data.other.username : '') + (data.other && data.other.city ? ' &middot; ' + escapeHtml(data.other.city) : '') + '</span></span></div>' +
      '<div class="safety-note" style="margin-top:14px">' + icon('shield') + '<span>Meet in a public place. Never share OTPs, bank details or your exact address, and never pay to get an item back.</span></div>' +
      '<button class="btn btn-ghost btn-sm btn-block" type="button" id="report-thread" style="margin-top:12px;color:#b91c1c">' + icon('alert') + 'Report this conversation</button>' +
      '</div></div></aside>' +

      '<section class="panel thread">' +
      '<div class="thread-head">' + avatar(data.other) +
      '<span class="who"><strong>' + escapeHtml(data.other ? data.other.fullName : 'Member') + '</strong>' +
      '<span>' + (listing ? escapeHtml(listing.title) : 'Listing removed') + '</span></span>' +
      '<a class="btn btn-ghost btn-sm" href="/messages">All messages</a></div>' +
      '<div class="thread-body" id="thread-body">' + body(data.messages || []) + '</div>' +
      '<form class="composer" id="composer">' +
      '<textarea id="composer-input" placeholder="Write a message…" maxlength="1200" aria-label="Message"></textarea>' +
      '<button class="btn btn-primary" type="submit" aria-label="Send message">' + icon('send') + '</button>' +
      '</form></section></div>';

    wire();
    scrollToBottom();
  }

  function scrollToBottom() {
    const threadBody = qs('#thread-body');
    if (threadBody) threadBody.scrollTop = threadBody.scrollHeight;
  }

  function wire() {
    const form = qs('#composer');
    const input = qs('#composer-input');
    if (form && input) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          form.requestSubmit();
        }
      });
      form.addEventListener('submit', send);
    }
    const report = qs('#report-thread');
    if (report) report.addEventListener('click', reportThread);
  }

  async function send(event) {
    event.preventDefault();
    if (sending) return;
    const input = qs('#composer-input');
    const text = input.value.trim();
    if (!text) return;
    sending = true;
    try {
      const result = await api('/api/messages', {
        method: 'POST',
        body: { conversationId: data.id, body: text },
      });
      data.messages = data.messages || [];
      data.messages.push(result.item);
      lastCount = data.messages.length;
      input.value = '';
      const threadBody = qs('#thread-body');
      if (threadBody) threadBody.innerHTML = body(data.messages);
      scrollToBottom();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      sending = false;
    }
  }

  async function reportThread() {
    const value = await openModal({
      title: 'Report this conversation',
      body:
        '<p>Reports are only visible to moderators. The other person is never told who reported them.</p>' +
        '<div class="field"><label class="label" for="report-reason">Reason</label>' +
        '<select class="select" id="report-reason">' +
        '<option>Possible scam or fraud</option><option>Harassment or abusive messages</option>' +
        '<option>Inappropriate or unsafe content</option><option>Something else</option></select></div>' +
        '<div class="field"><label class="label" for="report-details">Details</label>' +
        '<textarea class="textarea" id="report-details" placeholder="What happened?" maxlength="600"></textarea></div>',
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Submit report', value: true, variant: 'danger' },
      ],
    });
    if (!value) return;
    try {
      await api('/api/conversations/' + encodeURIComponent(data.id) + '/report', {
        method: 'POST',
        body: { reason: qs('#report-reason').value, details: qs('#report-details').value },
      });
      toast('Report submitted. Thank you.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function refresh() {
    try {
      const next = await api('/api/conversations/' + encodeURIComponent(data.id));
      if ((next.messages || []).length !== lastCount) {
        data = next;
        lastCount = (next.messages || []).length;
        const threadBody = qs('#thread-body');
        if (threadBody) {
          const atBottom = threadBody.scrollHeight - threadBody.scrollTop - threadBody.clientHeight < 120;
          threadBody.innerHTML = body(data.messages);
          if (atBottom) scrollToBottom();
        }
      }
    } catch (error) {
      /* keep the current thread visible */
    }
  }

  (async function start() {
    await LNF.boot;
    if (!LNF.state.user) {
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      return;
    }
    try {
      data = await api('/api/conversations/' + encodeURIComponent(id));
    } catch (error) {
      root.innerHTML =
        '<div style="padding:60px 0">' +
        emptyState({
          icon: 'message',
          title: error.status === 403 ? 'This conversation is not yours' : 'Conversation could not load',
          message: error.status === 403 ? 'Private conversations are only visible to their two participants.' : error.message,
          actionLabel: 'Back to messages',
          actionHref: '/messages',
        }) +
        '</div>';
      return;
    }
    lastCount = (data.messages || []).length;
    render();
    poller = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 15000);
    window.addEventListener('beforeunload', () => clearInterval(poller));
  })().catch((error) => console.error(error));
})();
