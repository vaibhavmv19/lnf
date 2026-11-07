/* Inbox: conversation list for the signed-in member. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs, icon, escapeHtml, avatar, timeAgo, emptyState, toast } = LNF;

  const list = qs('#conversation-list');

  function render(items) {
    if (!list) return;
    if (!items.length) {
      list.innerHTML =
        '<div style="padding:18px">' +
        emptyState({
          icon: 'message',
          title: 'No messages yet',
          message: 'Start a conversation from any listing. Messages stay private between the two of you.',
          actionLabel: 'Find a listing',
          actionHref: '/explore',
        }) +
        '</div>';
      return;
    }
    list.innerHTML = items
      .map(
        (item) =>
          '<a class="conversation-row" href="/messages/' + encodeURIComponent(item.id) + '">' +
          '<span class="conversation-thumb">' +
          (item.listing && item.listing.image ? '<img src="' + escapeHtml(item.listing.image.url) + '" alt="" loading="lazy" />' : '') +
          '</span>' +
          '<span class="body"><strong>' + escapeHtml(item.other ? item.other.fullName : 'Member') +
          (item.unread ? ' <span class="badge blue">' + item.unread + ' new</span>' : '') + '</strong>' +
          '<p>' + escapeHtml(item.lastMessage ? (item.lastMessage.mine ? 'You: ' : '') + item.lastMessage.body : 'No messages yet') + '</p>' +
          '<span class="meta">' + escapeHtml(item.listing ? item.listing.title : 'Listing removed') + ' &middot; ' + escapeHtml(timeAgo(item.updatedAt)) + '</span></span>' +
          (item.unread ? '<span class="unread-dot" aria-label="Unread"></span>' : '') +
          '</a>',
      )
      .join('');
  }

  (async function start() {
    await LNF.boot;
    if (!LNF.state.user) {
      window.location.href = '/login?next=' + encodeURIComponent('/messages');
      return;
    }
    try {
      const data = await api('/api/messages');
      render(data.items || []);
      if (data.unread) LNF.setUnread(LNF.state.unread);
    } catch (error) {
      if (list) list.innerHTML = '<div style="padding:18px">' + emptyState({ icon: 'alert', title: 'Inbox could not load', message: error.message }) + '</div>';
      toast(error.message, 'error');
    }
  })().catch((error) => console.error(error));
})();
