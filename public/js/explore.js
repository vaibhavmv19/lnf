/* Explore / lost / found: filters, search, masonry results and pagination. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs, qsa, escapeHtml, listingCard, skeletonCards, emptyState, debounce, toast } = LNF;

  const PAGE_SIZE = 24;
  const lockedType = document.body.dataset.lockType || '';
  const query = new URLSearchParams(window.location.search);

  const filterState = {
    q: query.get('q') || '',
    type: lockedType || query.get('type') || '',
    category: query.get('category') || '',
    city: query.get('city') || '',
    from: query.get('from') || '',
    to: query.get('to') || '',
    sort: query.get('sort') || 'recent',
    offset: 0,
    total: 0,
  };
  let loading = false;
  let firstLoad = true;

  const results = qs('#results');
  const loadMoreWrap = qs('#load-more-wrap');
  const resultCount = qs('#result-count');

  function buildQuery(offset) {
    const params = new URLSearchParams();
    if (filterState.q) params.set('q', filterState.q);
    if (filterState.type) params.set('type', filterState.type);
    if (filterState.category) params.set('category', filterState.category);
    if (filterState.city) params.set('city', filterState.city);
    if (filterState.from) params.set('from', filterState.from);
    if (filterState.to) params.set('to', filterState.to);
    if (filterState.sort) params.set('sort', filterState.sort);
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset || 0));
    return params.toString();
  }

  function syncUrl() {
    const params = new URLSearchParams();
    if (filterState.q) params.set('q', filterState.q);
    if (filterState.type && !lockedType) params.set('type', filterState.type);
    if (filterState.category) params.set('category', filterState.category);
    if (filterState.city) params.set('city', filterState.city);
    if (filterState.from) params.set('from', filterState.from);
    if (filterState.to) params.set('to', filterState.to);
    if (filterState.sort !== 'recent') params.set('sort', filterState.sort);
    const next = params.toString();
    history.replaceState(null, '', next ? '/explore?' + next : window.location.pathname);
  }

  function setCount(total) {
    if (!resultCount) return;
    const parts = [];
    parts.push(total === 1 ? '1 item' : total.toLocaleString('en-IN') + ' items');
    if (filterState.q) parts.push('for “' + filterState.q + '”');
    if (filterState.category) parts.push('in ' + filterState.category);
    if (filterState.city) parts.push('near ' + filterState.city);
    resultCount.textContent = parts.join(' ');
  }

  function append(items) {
    const html = items.map((listing) => listingCard(listing)).join('');
    results.insertAdjacentHTML('beforeend', html);
  }

  function updateLoadMore(hasMore) {
    if (!loadMoreWrap) return;
    loadMoreWrap.innerHTML = hasMore
      ? '<button class="btn btn-outline" type="button" id="load-more">Load more items</button>'
      : filterState.total > PAGE_SIZE
        ? '<span class="result-count">You have seen all ' + filterState.total.toLocaleString('en-IN') + ' items.</span>'
        : '';
    const button = qs('#load-more', loadMoreWrap);
    if (button) {
      button.addEventListener('click', () => {
        button.disabled = true;
        button.textContent = 'Loading…';
        load(false);
      });
    }
  }

  async function load(reset) {
    if (loading) return;
    if (reset) {
      filterState.offset = 0;
      results.innerHTML = skeletonCards(10);
      if (loadMoreWrap) loadMoreWrap.innerHTML = '';
      if (resultCount) resultCount.textContent = 'Loading listings…';
    }
    loading = true;
    try {
      const data = await api('/api/listings?' + buildQuery(filterState.offset));
      if (reset) results.innerHTML = '';
      filterState.total = data.total;
      if (reset && !data.items.length) {
        results.innerHTML = emptyState({
          icon: filterState.q ? 'search' : 'tag',
          title: filterState.q ? 'No items match that search' : 'Nothing here yet',
          message: filterState.q
            ? 'Try fewer words, a different city, or clear the filters to see everything.'
            : 'When someone reports a matching item, it will show up here.',
          actionLabel: filterState.q ? 'Clear search' : 'Post an item',
          actionHref: filterState.q ? window.location.pathname : '/post',
        });
      } else {
        append(data.items);
      }
      filterState.offset += data.items.length;
      setCount(data.total);
      updateLoadMore(data.hasMore);
    } catch (error) {
      results.innerHTML = emptyState({
        icon: 'alert',
        title: 'Listings could not load',
        message: error.message,
        actionLabel: 'Try again',
        actionHref: window.location.pathname,
      });
      toast(error.message, 'error');
    } finally {
      loading = false;
      firstLoad = false;
      if (reset) syncUrl();
    }
  }

  function wireFilters(meta) {
    const categorySelect = qs('#category-select');
    const cityList = qs('#city-options');
    if (categorySelect && meta.categories) {
      meta.categories.forEach((category) => {
        const option = document.createElement('option');
        option.value = category.name;
        option.textContent = category.name + ' (' + category.count + ')';
        categorySelect.appendChild(option);
      });
      categorySelect.value = filterState.category;
    }
    if (cityList && meta.cities) {
      meta.cities.forEach((city) => {
        const option = document.createElement('option');
        option.value = city;
        cityList.appendChild(option);
      });
    }

    const searchInput = qs('#search-input');
    if (searchInput) {
      searchInput.value = filterState.q;
      searchInput.addEventListener(
        'input',
        debounce(() => {
          filterState.q = searchInput.value.trim();
          load(true);
        }, 320),
      );
    }

    qsa('#type-chips [data-type]').forEach((chip) => {
      chip.classList.toggle('is-active', chip.dataset.type === filterState.type);
      chip.addEventListener('click', () => {
        filterState.type = chip.dataset.type;
        qsa('#type-chips [data-type]').forEach((entry) => entry.classList.toggle('is-active', entry === chip));
        load(true);
      });
    });

    const sortSelect = qs('#sort-select');
    if (sortSelect) {
      sortSelect.value = filterState.sort;
      sortSelect.addEventListener('change', () => {
        filterState.sort = sortSelect.value;
        load(true);
      });
    }

    const cityInput = qs('#city-input');
    if (cityInput) cityInput.value = filterState.city;
    const fromInput = qs('#from-input');
    if (fromInput) fromInput.value = filterState.from;
    const toInput = qs('#to-input');
    if (toInput) toInput.value = filterState.to;

    const panel = qs('#filter-panel');
    const toggle = qs('#more-filters');
    if (toggle && panel) {
      toggle.addEventListener('click', () => {
        const open = panel.classList.toggle('hidden');
        toggle.setAttribute('aria-expanded', String(!open));
      });
      const activeFilters = Boolean(filterState.category || filterState.city || filterState.from || filterState.to);
      if (activeFilters) {
        panel.classList.remove('hidden');
        toggle.setAttribute('aria-expanded', 'true');
      }
    }

    const apply = qs('#apply-filters');
    if (apply) {
      apply.addEventListener('click', () => {
        filterState.category = qs('#category-select').value;
        filterState.city = qs('#city-input').value.trim();
        filterState.from = qs('#from-input').value;
        filterState.to = qs('#to-input').value;
        load(true);
        if (panel && window.innerWidth < 720) panel.classList.add('hidden');
      });
    }

    const clear = qs('#clear-filters');
    if (clear) {
      clear.addEventListener('click', () => {
        filterState.category = '';
        filterState.city = '';
        filterState.from = '';
        filterState.to = '';
        filterState.q = '';
        if (qs('#category-select')) qs('#category-select').value = '';
        if (qs('#city-input')) qs('#city-input').value = '';
        if (qs('#from-input')) qs('#from-input').value = '';
        if (qs('#to-input')) qs('#to-input').value = '';
        if (searchInput) searchInput.value = '';
        load(true);
      });
    }
  }

  async function start() {
    await LNF.boot;
    if (lockedType) filterState.type = lockedType;
    const meta = await api('/api/meta').catch(() => ({ categories: [], cities: [] }));
    wireFilters(meta);
    await load(true);
  }

  start().catch((error) => {
    console.error(error);
    if (results) results.innerHTML = emptyState({ icon: 'alert', title: 'Could not load listings', message: error.message });
  });
})();
