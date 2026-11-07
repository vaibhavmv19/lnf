/* Community leaderboard ranked by verified returns, then reputation. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs, icon, escapeHtml, avatar, emptyState, toast } = LNF;

  const root = qs('#leaderboard-page');

  function row(entry) {
    return (
      '<a class="leader-row' + (entry.isMe ? ' is-me' : '') + '" href="/profile/' + encodeURIComponent(entry.username) + '">' +
      '<span class="rank' + (entry.rank <= 3 ? ' r' + entry.rank : '') + '">' + entry.rank + '</span>' +
      avatar(entry) +
      '<span class="who"><strong>' + escapeHtml(entry.fullName) + (entry.isMe ? ' <span class="badge blue">You</span>' : '') + '</strong>' +
      '<span>@' + escapeHtml(entry.username) + (entry.city ? ' &middot; ' + escapeHtml(entry.city) : '') + ' &middot; ' + entry.listings + ' listings</span></span>' +
      '<span class="leader-score"><b>' + (entry.successfulReturns || 0) + '</b><span>verified returns</span></span>' +
      '</a>'
    );
  }

  async function start() {
    await LNF.boot;
    try {
      const data = await api('/api/leaderboard');
      const items = data.items || [];
      root.innerHTML =
        '<div class="panel" style="padding:18px 20px;margin-bottom:18px">' +
        '<div class="row" style="gap:10px;align-items:flex-start">' + icon('trophy') +
        '<div><strong style="display:block;margin-bottom:2px">How recognition works</strong>' +
        '<p class="hint">Points come from verified returns, not from posting volume. Marking an item returned adds 10 reputation, and a confirmed found-item handover adds a verified return. Nobody can buy their way up this list.</p></div></div></div>' +
        (items.length
          ? '<div class="leader-list">' + items.map(row).join('') + '</div>'
          : emptyState({
              icon: 'trophy',
              title: 'No rankings yet',
              message: 'The leaderboard fills up as members verify returns.',
              actionLabel: 'Browse listings',
              actionHref: '/explore',
            }));
    } catch (error) {
      root.innerHTML = emptyState({ icon: 'alert', title: 'Leaderboard could not load', message: error.message });
      toast(error.message, 'error');
    }
  }

  start().catch((error) => console.error(error));
})();
