/* Possible matches: paired lost and found reports with a transparent score. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs, icon, escapeHtml, timeAgo, emptyState, toast } = LNF;

  const root = qs('#matches-page');
  const refresh = qs('#refresh-matches');

  function mini(listing) {
    return (
      '<a class="mini-item" href="/item/' + encodeURIComponent(listing.id) + '">' +
      '<span class="thumb">' + (listing.image ? '<img src="' + escapeHtml(listing.image.url) + '" alt="" loading="lazy" />' : '') + '</span>' +
      '<span><strong>' + escapeHtml(listing.title) + '</strong>' +
      '<span>' + escapeHtml(listing.type === 'lost' ? 'Lost' : 'Found') + ' &middot; ' + escapeHtml(listing.city) + ' &middot; ' + escapeHtml(timeAgo(listing.createdAt)) + '</span></span></a>'
    );
  }

  function card(match) {
    const parts = match.parts || {};
    return (
      '<article class="match-card" data-match="' + escapeHtml(match.id) + '">' +
      '<div class="match-card-head"><div class="left">' +
      '<span class="badge ' + (match.tier === 'strong' ? 'blue' : match.tier === 'good' ? 'amber' : '') + '">' + icon('sparkles') + escapeHtml(match.label) + '</span>' +
      '<span class="badge">' + Math.round(match.score * 100) + '% similarity</span>' +
      (match.status !== 'suggested' ? '<span class="badge returned">' + escapeHtml(match.status) + '</span>' : '') +
      '</div><span class="result-count">' + escapeHtml(timeAgo(match.createdAt)) + '</span></div>' +
      '<div class="match-card-body">' + mini(match.lost) +
      '<span class="match-link">' + icon('link') + '</span>' + mini(match.found) + '</div>' +
      '<div class="match-foot"><div class="breakdown">' +
      '<span>Image <b>' + Math.round((parts.image || 0) * 100) + '%</b></span>' +
      '<span>Text <b>' + Math.round((parts.text || 0) * 100) + '%</b></span>' +
      '<span>Category <b>' + Math.round((parts.category || 0) * 100) + '%</b></span>' +
      '<span>Colour <b>' + Math.round((parts.color || 0) * 100) + '%</b></span>' +
      '<span>Location <b>' + Math.round((parts.location || 0) * 100) + '%</b></span>' +
      '</div><div class="row">' +
      '<button class="btn btn-outline btn-sm" type="button" data-action="confirmed">' + icon('check') + 'Same item</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-action="dismissed">Dismiss</button>' +
      '</div></div></article>'
    );
  }

  async function load() {
    if (!root) return;
    try {
      const data = await api('/api/matches');
      const items = data.items || [];
      root.innerHTML = items.length
        ? '<div class="match-panel" style="margin-bottom:18px">' + icon('shield') +
          '<div class="score-line"><strong style="font-size:14px">Suggestions are hints, not proof</strong></div>' +
          '<p class="hint" style="margin-top:6px">Image similarity weighs 45%, description 30%, category 10%, colour 5% and location 10%. Always confirm a private detail that is not shown in the photos before arranging a handover.</p></div>' +
          '<div class="matches-list">' + items.map(card).join('') + '</div>'
        : emptyState({
            icon: 'sparkles',
            title: 'No suggestions right now',
            message: 'When another member reports something that looks like your item, the pair will appear here.',
            actionLabel: 'Post a lost item',
            actionHref: '/post?type=lost',
          });
    } catch (error) {
      if (error.status === 401) {
        window.location.href = '/login?next=' + encodeURIComponent('/matches');
        return;
      }
      root.innerHTML = emptyState({ icon: 'alert', title: 'Could not load suggestions', message: error.message });
    }
  }

  if (root) {
    root.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const cardNode = button.closest('[data-match]');
      if (!cardNode) return;
      button.disabled = true;
      try {
        await api('/api/matches/' + encodeURIComponent(cardNode.dataset.match), {
          method: 'PATCH',
          body: { status: button.dataset.action },
        });
        toast(button.dataset.action === 'confirmed' ? 'Marked as the same item. Verify the private detail in messages.' : 'Suggestion dismissed.', 'success');
        await load();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    });
  }

  if (refresh) {
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      refresh.textContent = 'Checking…';
      try {
        const result = await api('/api/matches/run', { method: 'POST' });
        toast(result.created ? result.created + ' new suggestion' + (result.created === 1 ? '' : 's') + ' found.' : 'No new suggestions right now.', 'success');
        await load();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        refresh.disabled = false;
        refresh.textContent = 'Refresh suggestions';
      }
    });
  }

  (async function start() {
    await LNF.boot;
    if (!LNF.state.user) {
      window.location.href = '/login?next=' + encodeURIComponent('/matches');
      return;
    }
    await load();
  })().catch((error) => console.error(error));
})();
