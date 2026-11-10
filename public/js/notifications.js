/* Notifications: matches, messages, claims, returns and moderation updates. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs, icon, escapeHtml, timeAgo, emptyState, toast } = LNF;

  const list = qs('#notification-list');
  const markAll = qs('#mark-all-read');

  const ICON_FOR = {
    match: 'sparkles',
    message: 'message',
    claim: 'shield',
    returned: 'check-circle',
    moderation: 'shield',
    welcome: 'sparkles',
  };

  function linkFor(item) {
    if (item.type === 'message') return '/messages/' + encodeURIComponent(item.referenceId || '');
    if (item.type === 'match') return '/matches';
    if (item.type === 'claim' || item.type === 'returned') return '/item/' + encodeURIComponent(item.referenceId || '');
    return null;
  }

  async function load() {
    try {
      const data = await api('/api/notifications');
      const items = data.items || [];
      LNF.setUnread(data.unread || 0);
      if (!list) return;
      if (!items.length) {
        list.innerHTML =
          '<div style="padding:18px">' +
          emptyState({
            icon: 'bell',
            title: 'All quiet for now',
            message: 'Match suggestions, messages and return confirmations will appear here.',
            actionLabel: 'Browse listings',
            actionHref: '/explore',
          }) +
          '</div>';
        return;
      }
      list.innerHTML = items
        .map((item) => {
          const href = linkFor(item);
          const content =
            '<span class="notification-icon ' + escapeHtml(item.type) + '">' +
            icon(ICON_FOR[item.type] || 'bell') + '</span>' +
            '<span class="body"><strong>' + escapeHtml(item.title) + '</strong>' +
            '<p>' + escapeHtml(item.body) + '</p>' +
            '<span class="when">' + escapeHtml(timeAgo(item.createdAt)) + (item.isRead ? '' : ' &middot; unread') + '</span></span>';
          return href
            ? '<a class="notification' + (item.isRead ? '' : ' is-unread') + '" href="' + href + '" data-notification="' + escapeHtml(item.id) + '">' + content + '</a>'
            : '<div class="notification' + (item.isRead ? '' : ' is-unread') + '" data-notification="' + escapeHtml(item.id) + '">' + content + '</div>';
        })
        .join('');
    } catch (error) {
      if (error.status === 401) {
        window.location.href = '/login?next=' + encodeURIComponent('/notifications');
        return;
      }
      if (list) list.innerHTML = '<div style="padding:18px">' + emptyState({ icon: 'alert', title: 'Notifications could not load', message: error.message }) + '</div>';
      toast(error.message, 'error');
    }
  }

  async function markRead(id) {
    try {
      const result = await api('/api/notifications/read', { method: 'POST', body: id ? { id } : { all: true } });
      LNF.setUnread(result.unread || 0);
    } catch (error) {
      /* navigation still proceeds */
    }
  }

  if (markAll) {
    markAll.addEventListener('click', async () => {
      await markRead(null);
      toast('All notifications marked as read.', 'success');
      await load();
    });
  }

  if (list) {
    list.addEventListener('click', (event) => {
      const node = event.target.closest('[data-notification]');
      if (!node || !node.classList.contains('is-unread')) return;
      const id = node.dataset.notification;
      if (node.tagName === 'A') {
        event.preventDefault();
        const href = node.getAttribute('href');
        markRead(id).finally(() => { window.location.href = href; });
      } else {
        node.classList.remove('is-unread');
        markRead(id);
      }
    });
  }

  (async function start() {
    await LNF.boot;
    if (!LNF.state.user) {
      window.location.href = '/login?next=' + encodeURIComponent('/notifications');
      return;
    }
    await load();
  })().catch((error) => console.error(error));
})();
