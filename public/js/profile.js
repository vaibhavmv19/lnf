/* Public member profile: reputation, achievements and contributions. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs, icon, escapeHtml, avatar, formatDate, listingCard, emptyState, toast } = LNF;

  const root = qs('#profile-page');
  const username = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] || '');
  let data = null;
  let tab = 'listings';

  function achievements(list) {
    if (!list || !list.length) {
      return '<span class="hint">No badges yet. Verified returns earn recognition.</span>';
    }
    return list
      .map((item) => '<span class="badge amber" title="' + escapeHtml(item.description) + '">' + icon('trophy') + escapeHtml(item.label) + '</span>')
      .join(' ');
  }

  function render() {
    if (!root || !data) return;
    const user = data.user;
    const stats = data.stats || {};
    const items = (data.listings || []).filter((listing) => (tab === 'reunited' ? listing.status === 'returned' : true));

    root.innerHTML =
      '<div class="profile-head">' + avatar(user, 'lg') +
      '<div class="who"><h1>' + escapeHtml(user.fullName) + '</h1>' +
      '<div class="handle">@' + escapeHtml(user.username) + (user.isAdmin ? ' &middot; moderator' : '') + '</div>' +
      (user.bio ? '<p class="bio">' + escapeHtml(user.bio) + '</p>' : '') +
      '<div class="profile-meta">' +
      (user.city ? '<span>' + icon('pin') + escapeHtml(user.city) + '</span>' : '') +
      '<span>' + icon('clock') + 'Joined ' + escapeHtml(formatDate(user.createdAt)) + '</span>' +
      '<span>' + icon('check-circle') + (user.successfulReturns || 0) + ' verified returns</span>' +
      '<span>' + icon('sparkles') + (user.reputation || 0) + ' reputation</span>' +
      '</div>' +
      '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' + achievements(data.achievements) + '</div>' +
      '</div>' +
      (user.isMe
        ? '<a class="btn btn-outline" href="/settings">' + icon('settings') + 'Edit profile</a>'
        : '<a class="btn btn-outline" href="/explore?owner=' + encodeURIComponent(user.username) + '">' + icon('search') + 'Browse items</a>') +
      '</div>' +

      '<div class="stat-row">' +
      '<div class="stat"><strong>' + (stats.listings || 0) + '</strong><span>Items shared</span></div>' +
      '<div class="stat"><strong>' + (stats.lost || 0) + '</strong><span>Lost reports</span></div>' +
      '<div class="stat"><strong>' + (stats.found || 0) + '</strong><span>Found reports</span></div>' +
      '<div class="stat"><strong>' + (stats.returned || 0) + '</strong><span>Reunited</span></div>' +
      '</div>' +

      '<div class="profile-tabs">' +
      '<button type="button" data-tab="listings" class="' + (tab === 'listings' ? 'is-active' : '') + '">All listings (' + (data.listings || []).length + ')</button>' +
      '<button type="button" data-tab="reunited" class="' + (tab === 'reunited' ? 'is-active' : '') + '">Reunited (' + (stats.returned || 0) + ')</button>' +
      '</div>' +

      (items.length
        ? '<div class="masonry">' + items.map((listing) => listingCard(listing)).join('') + '</div>'
        : emptyState({
            icon: tab === 'reunited' ? 'check-circle' : 'tag',
            title: tab === 'reunited' ? 'No confirmed reunions yet' : 'No listings yet',
            message: tab === 'reunited' ? 'When this member marks an item returned, it shows up here.' : 'Nothing has been posted from this account so far.',
            actionLabel: user.isMe && tab !== 'reunited' ? 'Post an item' : 'Browse listings',
            actionHref: user.isMe && tab !== 'reunited' ? '/post' : '/explore',
          }));

    root.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        tab = button.dataset.tab;
        render();
      });
    });
  }

  async function start() {
    await LNF.boot;
    try {
      data = await api('/api/users/' + encodeURIComponent(username));
    } catch (error) {
      root.innerHTML =
        '<div style="padding:50px 0">' +
        emptyState({
          icon: 'user',
          title: error.status === 404 ? 'Member not found' : 'Profile could not load',
          message: error.status === 404 ? 'That username does not belong to an account here.' : error.message,
          actionLabel: 'Browse listings',
          actionHref: '/explore',
        }) +
        '</div>';
      return;
    }
    document.title = data.user.fullName + ' · Lost N Found';
    render();
  }

  start().catch((error) => {
    console.error(error);
    toast('Profile could not load.', 'error');
  });
})();
