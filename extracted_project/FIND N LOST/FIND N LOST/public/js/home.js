/* Homepage: live stats, recent listings, categories, reunions, match teaser. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs, icon, escapeHtml, listingCard, skeletonCards, emptyState } = LNF;

  const CATEGORY_ICON = {
    'Phones & Electronics': 'camera',
    Audio: 'message',
    Cameras: 'camera',
    'Wallets & Cards': 'bookmark',
    'Bags & Luggage': 'bag',
    Keys: 'lock',
    Eyewear: 'eye',
    Watches: 'clock',
    'Books & Stationery': 'edit',
    Umbrellas: 'shield',
    Bottles: 'heart',
    Jewellery: 'sparkles',
    Clothing: 'bag',
    Pets: 'heart',
    Bicycles: 'refresh',
    Documents: 'edit',
    Other: 'tag',
  };

  function fillStats(stats) {
    const map = {
      listings: stats.listings,
      reunited: stats.reunited,
      members: stats.members,
      cities: stats.cities,
    };
    Object.keys(map).forEach((key) => {
      const node = qs('[data-stat="' + key + '"]');
      if (node) node.textContent = Number(map[key] || 0).toLocaleString('en-IN');
    });
  }

  function renderCollage(listings) {
    const target = qs('#hero-collage');
    if (!target) return;
    const picks = (listings || []).filter((listing) => listing.image).slice(0, 4);
    if (!picks.length) {
      target.innerHTML = '<div class="hero-tile"><div style="height:100%;display:grid;place-items:center;color:#94a3b8">' + icon('image') + '</div></div>';
      return;
    }
    target.innerHTML = picks
      .map(
        (listing) =>
          '<div class="hero-tile"><img src="' + escapeHtml(listing.image.url) + '" alt="" loading="lazy" />' +
          '<span>' + escapeHtml(listing.city) + '</span></div>',
      )
      .join('');
  }

  function renderCategories(meta) {
    const target = qs('#category-grid');
    if (!target) return;
    const categories = (meta.categories || [])
      .filter((category) => category.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    if (!categories.length) {
      target.innerHTML = emptyState({
        icon: 'grid',
        title: 'No categories yet',
        message: 'Categories appear as people post lost and found items.',
      });
      return;
    }
    target.innerHTML = categories
      .map(
        (category) =>
          '<a class="category-card" href="/explore?category=' + encodeURIComponent(category.name) + '">' +
          '<span class="category-icon">' + icon(CATEGORY_ICON[category.name] || 'tag') + '</span>' +
          '<span><strong>' + escapeHtml(category.name) + '</strong>' +
          '<span>' + category.count + ' ' + (category.count === 1 ? 'item' : 'items') + '</span></span></a>',
      )
      .join('');
  }

  function renderMatchTeaser(state, matches) {
    const target = qs('#match-teaser');
    if (!target) return;

    if (!state.user) {
      target.innerHTML =
        '<div class="cta-band" style="background:linear-gradient(120deg,#eff6ff,#f8fafc);color:var(--navy);box-shadow:var(--shadow-sm);border:1px solid #dbe7ff">' +
        '<div><h2 style="color:var(--navy)">Something of yours went missing?</h2>' +
        '<p style="color:#475569">Sign in to post it and we will compare it against every found report, photo and description included.</p></div>' +
        '<div class="row"><a class="btn btn-primary" href="/login">Sign in</a>' +
        '<a class="btn btn-outline" href="/explore">Browse first</a></div></div>';
      return;
    }

    const items = (matches || []).slice(0, 2);
    if (!items.length) {
      target.innerHTML = emptyState({
        icon: 'sparkles',
        title: 'No suggestions just yet',
        message: 'When a found report looks similar to something you lost, it will appear here.',
        actionLabel: 'Post a lost item',
        actionHref: '/post?type=lost',
      });
      return;
    }

    target.innerHTML =
      '<div class="panel" style="overflow:hidden">' +
      '<div class="panel-head"><h3>' + icon('sparkles') + ' Possible matches for you</h3>' +
      '<a class="section-link" href="/matches">See all</a></div>' +
      items
        .map(
          (match) =>
            '<a class="conversation-row" href="/item/' + encodeURIComponent(match.lost.id) + '">' +
            '<span class="conversation-thumb">' + (match.found.image ? '<img src="' + escapeHtml(match.found.image.url) + '" alt="" loading="lazy" />' : '') + '</span>' +
            '<span class="body"><strong>' + escapeHtml(match.lost.title) + ' &harr; ' + escapeHtml(match.found.title) + '</strong>' +
            '<p>' + escapeHtml(match.label) + ' &middot; ' + Math.round(match.score * 100) + '% similarity &middot; ' + escapeHtml(match.found.city) + '</p></span>' +
            '<span class="match-link">' + icon('arrow-right') + '</span></a>',
        )
        .join('') +
      '</div>';
  }

  async function start() {
    const state = await LNF.boot;
    const trending = qs('#trending-grid');
    const reunited = qs('#reunited-grid');
    if (trending) trending.innerHTML = skeletonCards(10);
    if (reunited) reunited.innerHTML = skeletonCards(5);

    const [stats, meta, recent, returned] = await Promise.all([
      api('/api/stats').catch(() => ({})),
      api('/api/meta').catch(() => ({ categories: [] })),
      api('/api/listings?limit=12&sort=recent').catch(() => ({ items: [] })),
      api('/api/listings?limit=5&sort=returned&status=returned').catch(() => ({ items: [] })),
    ]);

    fillStats(stats || {});
    renderCategories(meta || {});
    renderCollage((recent && recent.items) || []);

    if (trending) {
      const items = (recent && recent.items) || [];
      trending.innerHTML = items.length
        ? items.map((listing) => listingCard(listing)).join('')
        : emptyState({
            icon: 'search',
            title: 'No listings yet',
            message: 'Be the first to report something lost or found.',
            actionLabel: 'Post an item',
            actionHref: '/post',
          });
    }

    if (reunited) {
      const items = (returned && returned.items) || [];
      reunited.innerHTML = items.length
        ? items.map((listing) => listingCard(listing)).join('')
        : emptyState({
            icon: 'check-circle',
            title: 'No reunions to show yet',
            message: 'Verified returns will be celebrated here once the first handover is confirmed.',
            actionLabel: 'Browse listings',
            actionHref: '/explore',
          });
    }

    if (state.user) {
      const matches = await api('/api/matches').catch(() => ({ items: [] }));
      renderMatchTeaser(state, (matches && matches.items) || []);
    } else {
      renderMatchTeaser(state, []);
    }
  }

  start().catch((error) => {
    console.error(error);
    LNF.toast('Some parts of the page could not load.', 'error');
  });
})();
