/* Saved items: bookmarked listings for the signed-in member. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs, escapeHtml, listingCard, skeletonCards, emptyState, toast } = LNF;

  const grid = qs('#saved-grid');
  const count = qs('#saved-count');

  async function load() {
    if (grid) grid.innerHTML = skeletonCards(6);
    try {
      const data = await api('/api/saved');
      const items = data.items || [];
      if (count) {
        count.textContent = items.length === 1 ? '1 saved item' : items.length + ' saved items';
      }
      if (!grid) return;
      grid.innerHTML = items.length
        ? items.map((listing) => listingCard(listing)).join('')
        : emptyState({
            icon: 'bookmark',
            title: 'Nothing saved yet',
            message: 'Tap the bookmark on any listing to keep it here while you decide.',
            actionLabel: 'Browse listings',
            actionHref: '/explore',
          });
    } catch (error) {
      if (error.status === 401) {
        window.location.href = '/login?next=' + encodeURIComponent('/saved');
        return;
      }
      if (grid) {
        grid.innerHTML = emptyState({
          icon: 'alert',
          title: 'Could not load saved items',
          message: error.message,
        });
      }
      toast(error.message, 'error');
    }
  }

  async function start() {
    await LNF.boot;
    if (!LNF.state.user) {
      window.location.href = '/login?next=' + encodeURIComponent('/saved');
      return;
    }
    await load();

    if (grid) {
      grid.addEventListener('click', (event) => {
        const button = event.target.closest('[data-save]');
        if (!button) return;
        setTimeout(load, 450);
      });
    }
  }

  start().catch((error) => {
    console.error(error);
  });
})();
