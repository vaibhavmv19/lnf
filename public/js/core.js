/* Lost N Found — shared browser runtime.
   Chrome, API access, icons, cards, dialogs and small utilities. */
(function () {
  'use strict';

  const state = {
    user: null,
    unread: 0,
    savedIds: new Set(),
    meta: null,
    ready: false,
  };

  /* ------------------------------------------------------------- utilities */

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }
  function qsa(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
    return parts.map((part) => part.charAt(0).toUpperCase()).join('') || '?';
  }

  function avatar(person, size) {
    if (!person) return '';
    const cls = 'avatar' + (size ? ' ' + size : '');
    if (person.avatarUrl) {
      return '<img class="' + cls + '" src="' + escapeHtml(person.avatarUrl) + '" alt="" loading="lazy" />';
    }
    const name = person.fullName || person.username || '?';
    return '<span class="' + cls + '" aria-hidden="true">' + escapeHtml(initials(name)) + '</span>';
  }

  function timeAgo(input) {
    if (!input) return '';
    const then = new Date(input).getTime();
    if (Number.isNaN(then)) return '';
    const seconds = Math.max(1, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.round(hours / 24);
    if (days < 7) return days + 'd ago';
    const weeks = Math.round(days / 7);
    if (weeks < 5) return weeks + 'w ago';
    return formatDate(input);
  }

  function formatDate(input) {
    if (!input) return '';
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatTime(input) {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  }

  function money(value) {
    const number = Number(value || 0);
    if (!number) return '';
    return '₹' + number.toLocaleString('en-IN');
  }

  function typeLabel(type) {
    return type === 'found' ? 'Found' : 'Lost';
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced() {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), wait || 250);
    };
  }

  function param(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  /* ------------------------------------------------------------------ api */

  async function api(path, options) {
    const opts = options || {};
    const init = {
      method: opts.method || 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const response = await fetch(path, init);
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }
    if (!response.ok) {
      const message = (payload && payload.error) || 'Something went wrong. Please try again.';
      const failure = new Error(message);
      failure.status = response.status;
      failure.payload = payload;
      throw failure;
    }
    return payload;
  }

  /* ---------------------------------------------------------------- icons */

  const ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.3-3.3"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/>',
    message: '<path d="M20 15a3 3 0 0 1-3 3H8l-4 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3Z"/>',
    bookmark: '<path d="M6 4h12v17l-6-4-6 4Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
    shield: '<path d="M12 21s7-3.4 7-9V5.7L12 3 5 5.7V12c0 5.6 7 9 7 9Z"/>',
    check: '<path d="m5 13 4 4L19 7"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5L16 9.5"/>',
    'arrow-left': '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    pin: '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    tag: '<path d="M20.6 13.4 12 22l-9-9V4h9l8.6 8.6a1.4 1.4 0 0 1 0 2Z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
    eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    alert: '<path d="M12 4 3 20h18Z"/><path d="M12 10v4M12 17h.01"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    edit: '<path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16Z"/><path d="m14.5 5.5 4 4"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>',
    camera: '<path d="M4 8h3l1.5-2h7L17 8h3v12H4Z"/><circle cx="12" cy="14" r="3.5"/>',
    upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 20h16"/>',
    sparkles: '<path d="m12 3 1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8Z"/><path d="M18 16.5 19 19l2.5 1L19 21l-1 2.5"/>',
    logout: '<path d="M10 4H5v16h5"/><path d="M15 8l4 4-4 4"/><path d="M19 12H9"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.3a2 2 0 1 1-4 0v-.2A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 2.6 14H2.4a2 2 0 1 1 0-4h.2A1.7 1.7 0 0 0 4.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 2.6V2.4a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.3a2 2 0 1 1 0 4h-.3a1.7 1.7 0 0 0-1.5 1Z"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    send: '<path d="M4 12 20 4l-6 16-3-7Z"/><path d="m11 13 9-9"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4v7h-7"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    link: '<path d="M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 5.8"/><path d="M14 11a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>',
    heart: '<path d="M12 20s-8-4.6-8-10a4.6 4.6 0 0 1 8-3 4.6 4.6 0 0 1 8 3c0 5.4-8 10-8 10Z"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0Z"/><path d="M8 5H5.5A1.5 1.5 0 0 0 4 6.5C4 9 5.7 11 8 11"/><path d="M12 13v4M9 21h6"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
    bag: '<path d="M5 8h14l-1.4 12H6.4Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    qr: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/><path d="M13.5 13.5h3v3h-3zM13.5 20.5h2M19 20.5h1.5M20.5 13.5v3"/>',
  };

  function icon(name, cls) {
    const markup = ICONS[name] || ICONS.tag;
    return (
      '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + markup + '</svg>'
    );
  }

  /* ---------------------------------------------------------------- toast */

  function toast(message, type) {
    let region = qs('#toast-region');
    if (!region) {
      region = document.createElement('div');
      region.id = 'toast-region';
      region.className = 'toast-region';
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
    const node = document.createElement('div');
    node.className = 'toast' + (type ? ' ' + type : '');
    node.innerHTML = icon(type === 'error' ? 'alert' : 'check-circle') + '<span>' + escapeHtml(message) + '</span>';
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => node.remove());
    node.appendChild(close);
    region.appendChild(node);
    setTimeout(() => node.remove(), 4800);
  }

  /* --------------------------------------------------------------- dialog */

  function openModal(options) {
    const opts = options || {};
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      const actions = opts.actions || [{ label: 'Close', value: null }];
      backdrop.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true" aria-label="' + escapeHtml(opts.title || 'Dialog') + '">' +
        '<div class="modal-head"><h3>' + escapeHtml(opts.title || '') + '</h3></div>' +
        '<div class="modal-body">' + (opts.body || '') + '</div>' +
        '<div class="modal-foot">' +
        actions
          .map(
            (action, index) =>
              '<button class="btn ' +
              (action.variant === 'primary' ? 'btn-primary' : action.variant === 'danger' ? 'btn-danger' : 'btn-outline') +
              '" type="button" data-action="' + index + '">' + escapeHtml(action.label) + '</button>',
          )
          .join('') +
        '</div></div>';

      function close(value) {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        resolve(value);
      }
      function onKey(event) {
        if (event.key === 'Escape') close(null);
      }

      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) close(null);
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const action = actions[Number(button.dataset.action)];
        const field = backdrop.querySelector('[data-modal-input]');
        if (action && action.collect) close(field ? field.value : '');
        else if (action) close(action.value === undefined ? true : action.value);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(backdrop);
      const first = backdrop.querySelector('input, textarea, .btn-primary');
      if (first) setTimeout(() => first.focus(), 40);
    });
  }

  function confirmDialog(options) {
    const opts = options || {};
    return openModal({
      title: opts.title || 'Are you sure?',
      body: '<p>' + escapeHtml(opts.message || '') + '</p>',
      actions: [
        { label: opts.cancelText || 'Cancel', value: false },
        { label: opts.confirmText || 'Confirm', value: true, variant: opts.danger ? 'danger' : 'primary' },
      ],
    }).then((value) => Boolean(value));
  }

  /* ---------------------------------------------------------------- cards */

  function listingCard(listing, options) {
    const opts = options || {};
    const image = listing.image || (listing.images && listing.images[0]);
    const saved = state.savedIds.has(listing.id);
    const ratio = image && image.aspect ? Number(image.aspect) : 0.8;
    const href = '/item/' + encodeURIComponent(listing.id);
    const location = [listing.city, listing.area].filter(Boolean).join(', ');
    const reward = listing.type === 'lost' && listing.reward ? '<span class="reward-pill">' + money(listing.reward) + '</span>' : '';
    const returned = listing.status === 'returned' ? '<span class="returned-pill">Returned</span>' : '';
    const matchChip = opts.matchLabel
      ? '<span class="match-chip">' + icon('sparkles') + escapeHtml(opts.matchLabel) + '</span>'
      : '';

    return (
      '<article class="card" data-card="' + escapeHtml(listing.id) + '">' +
      '<div class="card-media" style="aspect-ratio:' + (Number.isFinite(ratio) && ratio > 0.3 ? ratio : 0.8) + '">' +
      '<a href="' + href + '" aria-label="View ' + escapeHtml(listing.title) + '">' +
      (image
        ? '<img src="' + escapeHtml(image.url) + '" alt="' + escapeHtml(listing.title) + '" loading="lazy" />'
        : '<div style="height:100%;display:grid;place-items:center;color:#94a3b8">' + icon('image') + '</div>') +
      '</a>' +
      '<span class="type-flag ' + listing.type + '">' + typeLabel(listing.type) + '</span>' +
      '<button class="save-btn' + (saved ? ' is-saved' : '') + '" type="button" data-save="' + escapeHtml(listing.id) + '" ' +
      'aria-pressed="' + (saved ? 'true' : 'false') + '" aria-label="' + (saved ? 'Remove from saved' : 'Save this item') + '">' +
      icon('bookmark') + '</button>' +
      '</div>' +
      '<div class="card-body">' +
      '<a class="card-title" href="' + href + '">' + escapeHtml(listing.title) + '</a>' +
      '<div class="card-meta"><span>' + escapeHtml(location || 'Location private') + '</span>' +
      '<span class="dot"></span><span>' + escapeHtml(timeAgo(listing.createdAt)) + '</span></div>' +
      (matchChip || '') +
      '<div class="card-foot">' +
      '<span class="who">' + avatar(listing.owner) + '<span>' + escapeHtml(listing.owner ? listing.owner.fullName : 'Member') + '</span></span>' +
      reward + returned +
      '</div></div></article>'
    );
  }

  function skeletonCards(count) {
    let html = '';
    for (let i = 0; i < (count || 8); i += 1) {
      const height = 150 + ((i * 37) % 120);
      html +=
        '<div class="skeleton-card"><div class="skeleton" style="height:' + height + 'px"></div>' +
        '<div class="skeleton line mid"></div><div class="skeleton line"></div>' +
        '<div class="skeleton line short"></div><div style="height:10px"></div></div>';
    }
    return html;
  }

  function emptyState(options) {
    const opts = options || {};
    return (
      '<div class="empty">' +
      '<div class="empty-icon">' + icon(opts.icon || 'search') + '</div>' +
      '<h3>' + escapeHtml(opts.title || 'Nothing here yet') + '</h3>' +
      '<p>' + escapeHtml(opts.message || '') + '</p>' +
      (opts.actionLabel
        ? '<a class="btn btn-primary" href="' + escapeHtml(opts.actionHref || '/explore') + '">' + escapeHtml(opts.actionLabel) + '</a>'
        : '') +
      '</div>'
    );
  }

  /* --------------------------------------------------------------- auth UI */

  function requireAuth(message) {
    if (state.user) return true;
    toast(message || 'Please sign in to continue.', 'error');
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    setTimeout(() => {
      window.location.href = '/login?next=' + next;
    }, 700);
    return false;
  }

  async function toggleSave(listingId) {
    if (!requireAuth('Sign in to save items for later.')) return false;
    const isSaved = state.savedIds.has(listingId);
    try {
      if (isSaved) {
        await api('/api/saved/' + encodeURIComponent(listingId), { method: 'DELETE' });
        state.savedIds.delete(listingId);
      } else {
        await api('/api/saved', { method: 'POST', body: { listingId } });
        state.savedIds.add(listingId);
      }
      qsa('[data-save="' + listingId + '"]').forEach((button) => {
        button.classList.toggle('is-saved', !isSaved);
        button.setAttribute('aria-pressed', String(!isSaved));
        button.setAttribute('aria-label', !isSaved ? 'Remove from saved' : 'Save this item');
      });
      toast(!isSaved ? 'Saved for later.' : 'Removed from saved items.', 'success');
      return !isSaved;
    } catch (error) {
      toast(error.message, 'error');
      return isSaved;
    }
  }

  function setUnread(count) {
    state.unread = count;
    const badge = qs('#nav-unread');
    if (!badge) return;
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.toggle('hidden', !count);
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      /* session may already be gone */
    }
    window.location.href = '/';
  }

  /* ---------------------------------------------------------------- chrome */

  function renderChrome() {
    const page = document.body.dataset.page || '';
    const navKey = document.body.dataset.nav || '';
    const header = qs('#site-header');
    const user = state.user;

    const links = [
      ['explore', '/explore', 'Explore'],
      ['lost', '/lost', 'Lost'],
      ['found', '/found', 'Found'],
      ['community', '/leaderboard', 'Community'],
    ]
      .map(
        ([key, href, label]) =>
          '<a class="nav-link' + (navKey === key ? ' is-active' : '') + '" href="' + href + '">' + label + '</a>',
      )
      .join('');

    const actions = user
      ? '<a class="btn btn-primary btn-sm nav-post" href="/post">' + icon('plus') + 'Post</a>' +
        '<a class="icon-btn" href="/notifications" aria-label="Notifications">' + icon('bell') +
        '<span class="badge-count' + (state.unread ? '' : ' hidden') + '" id="nav-unread">' +
        (state.unread > 9 ? '9+' : String(state.unread || 0)) + '</span></a>' +
        '<a class="icon-btn" href="/messages" aria-label="Messages">' + icon('message') + '</a>' +
        '<div class="avatar-menu">' +
        '<button class="icon-btn" type="button" id="avatar-toggle" aria-expanded="false" aria-label="Account menu" style="width:auto;padding:0 3px">' +
        avatar(user) + '</button>' +
        '<div class="menu-panel hidden" id="avatar-menu">' +
        '<div class="menu-head"><strong>' + escapeHtml(user.fullName) + '</strong><span>@' + escapeHtml(user.username) + '</span></div>' +
        '<a href="/profile/' + encodeURIComponent(user.username) + '">' + icon('user') + 'My profile</a>' +
        '<a href="/saved">' + icon('bookmark') + 'Saved items</a>' +
        '<a href="/matches">' + icon('sparkles') + 'Possible matches</a>' +
        '<a href="/settings">' + icon('settings') + 'Settings</a>' +
        (user.isAdmin ? '<a href="/admin">' + icon('shield') + 'Moderation</a>' : '') +
        '<div class="menu-sep"></div>' +
        '<button type="button" data-logout>' + icon('logout') + 'Sign out</button>' +
        '</div></div>'
      : '<a class="btn btn-outline btn-sm" href="/login">Sign in</a>' +
        '<a class="btn btn-primary btn-sm" href="/post">' + icon('plus') + 'Post an item</a>';

    if (header) {
      header.innerHTML =
        '<div class="nav">' +
        '<a class="brand" href="/"><span class="brand-mark">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.3-3.3"/><path d="M11 8v3l2 1.4"/></svg>' +
        '</span><span class="brand-text">Lost N Found</span></a>' +
        '<nav class="nav-links" aria-label="Main">' + links + '</nav>' +
        '<form class="nav-search" id="nav-search" role="search">' +
        icon('search') +
        '<input type="search" name="q" placeholder="Search lost &amp; found" aria-label="Search lost and found items" />' +
        '</form>' +
        '<div class="nav-actions">' + actions +
        '<button type="button" class="icon-btn nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="nav-mobile" aria-label="Open menu">' +
        icon('grid') + '</button>' +
        '</div>' +
        '</div>' +
        '<div class="nav-mobile" id="nav-mobile" hidden>' +
        '<nav class="nav-mobile-links" aria-label="Main">' + links + '</nav>' +
        '<form class="nav-search nav-mobile-search" role="search">' +
        icon('search') +
        '<input type="search" name="q" placeholder="Search lost &amp; found" aria-label="Search lost and found items" />' +
        '</form>' +
        '</div>';

      const search = qs('#nav-search', header);
      if (search) {
        search.addEventListener('submit', (event) => {
          event.preventDefault();
          const value = search.querySelector('input').value.trim();
          window.location.href = value ? '/explore?q=' + encodeURIComponent(value) : '/explore';
        });
      }

      const mobileSearch = qs('.nav-mobile-search', header);
      if (mobileSearch) {
        mobileSearch.addEventListener('submit', (event) => {
          event.preventDefault();
          const value = mobileSearch.querySelector('input').value.trim();
          window.location.href = value ? '/explore?q=' + encodeURIComponent(value) : '/explore';
        });
      }

      const navToggle = qs('#nav-toggle', header);
      const navMobile = qs('#nav-mobile', header);
      if (navToggle && navMobile) {
        const setMenu = (open) => {
          navMobile.hidden = !open;
          navMobile.classList.toggle('is-open', open);
          navToggle.setAttribute('aria-expanded', String(open));
          navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
        };
        navToggle.addEventListener('click', (event) => {
          event.stopPropagation();
          setMenu(navMobile.hidden);
        });
        document.addEventListener('click', (event) => {
          if (navMobile.hidden) return;
          if (navMobile.contains(event.target) || navToggle.contains(event.target)) return;
          setMenu(false);
        });
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') setMenu(false);
        });
        window.addEventListener('resize', () => {
          if (window.innerWidth > 860) setMenu(false);
        });
      }
      const toggle = qs('#avatar-toggle', header);
      const menu = qs('#avatar-menu', header);
      if (toggle && menu) {
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          const open = menu.classList.toggle('hidden');
          toggle.setAttribute('aria-expanded', String(!open));
        });
        document.addEventListener('click', (event) => {
          if (!menu.classList.contains('hidden') && !menu.contains(event.target) && event.target !== toggle) {
            menu.classList.add('hidden');
            toggle.setAttribute('aria-expanded', 'false');
          }
        });
      }
    }

    const footer = qs('#site-footer');
    if (footer) {
      footer.innerHTML =
        '<div class="footer-grid">' +
        '<div><a class="brand" href="/"><span class="brand-mark">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
        '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.3-3.3"/></svg></span>Lost N Found</a>' +
        '<p>A community marketplace for lost and found belongings. Report it, match it, verify it, bring it home.</p></div>' +
        '<div><h4>Browse</h4><a href="/explore">All items</a><a href="/lost">Lost items</a><a href="/found">Found items</a><a href="/leaderboard">Community</a></div>' +
        '<div><h4>Take part</h4><a href="/post?type=lost">Report something lost</a><a href="/post?type=found">Report something found</a><a href="/matches">Possible matches</a><a href="/saved">Saved items</a></div>' +
        '<div><h4>Safety</h4><a href="/settings">Privacy settings</a><a href="/explore">Handover guidance</a><a href="/messages">Report a conversation</a><a href="/admin">Moderation</a></div>' +
        '</div>' +
        '<div class="footer-bottom"><span>© ' + new Date().getFullYear() + ' Lost N Found. A community project.</span>' +
        '<span>Never share OTPs or bank details. Meet in public places.</span></div>';
    }

    document.body.dataset.page = page;
  }

  /* -------------------------------------------------------------- listeners */

  document.addEventListener('click', (event) => {
    const saveButton = event.target.closest('[data-save]');
    if (saveButton) {
      event.preventDefault();
      event.stopPropagation();
      toggleSave(saveButton.dataset.save);
      return;
    }
    const logoutButton = event.target.closest('[data-logout]');
    if (logoutButton) {
      event.preventDefault();
      logout();
    }
  });

  /* -------------------------------------------------------------------- boot */

  const boot = (async function init() {
    renderChrome();
    try {
      const me = await api('/api/auth/me');
      state.user = me.user || null;
      state.unread = me.unread || 0;
      state.savedIds = new Set(me.savedIds || []);
      state.achievements = me.achievements || [];
      if (state.user || state.unread) renderChrome();
      setUnread(state.unread);
    } catch (error) {
      state.user = null;
    }
    state.ready = true;
    return state;
  })();

  /* ------------------------------------------------------------------ motion */

  function reduceMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* A soft dot that tracks the pointer and a ring that trails it, growing over
     anything clickable. Fine pointers only, and never with reduced motion. */
  function initCursor() {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    if (!fine.matches || reduceMotion() || document.querySelector('.lnf-cursor-ring')) return;

    const ring = document.createElement('div');
    ring.className = 'lnf-cursor-ring';
    ring.setAttribute('aria-hidden', 'true');
    ring.appendChild(document.createElement('i'));
    const dot = document.createElement('div');
    dot.className = 'lnf-cursor-dot';
    dot.setAttribute('aria-hidden', 'true');
    document.body.appendChild(ring);
    document.body.appendChild(dot);
    document.documentElement.classList.add('lnf-cursor-on');

    const hover = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const ringAt = { x: hover.x, y: hover.y };
    const dotAt = { x: hover.x, y: hover.y };
    let started = false;

    const interactive =
      'a, button, [role="button"], input, select, textarea, summary, label, ' +
      '.card, .chip, .category-card, .type-option, .avatar, .save-btn';

    function paint() {
      dotAt.x += (hover.x - dotAt.x) * 0.6;
      dotAt.y += (hover.y - dotAt.y) * 0.6;
      ringAt.x += (hover.x - ringAt.x) * 0.16;
      ringAt.y += (hover.y - ringAt.y) * 0.16;
      dot.style.transform = 'translate3d(' + dotAt.x.toFixed(2) + 'px, ' + dotAt.y.toFixed(2) + 'px, 0)';
      ring.style.transform = 'translate3d(' + ringAt.x.toFixed(2) + 'px, ' + ringAt.y.toFixed(2) + 'px, 0)';
      window.requestAnimationFrame(paint);
    }

    document.addEventListener('mousemove', (event) => {
      hover.x = event.clientX;
      hover.y = event.clientY;
      if (!started) {
        started = true;
        dotAt.x = hover.x;
        dotAt.y = hover.y;
        ringAt.x = hover.x;
        ringAt.y = hover.y;
        ring.classList.add('is-live');
        dot.classList.add('is-live');
        window.requestAnimationFrame(paint);
      }
      const over = event.target && event.target.closest ? event.target.closest(interactive) : null;
      ring.classList.toggle('is-hover', Boolean(over));
    }, { passive: true });

    document.addEventListener('mouseleave', () => {
      ring.classList.remove('is-live', 'is-hover');
      dot.classList.remove('is-live');
      started = false;
    });
    document.addEventListener('mousedown', () => ring.classList.add('is-down'));
    document.addEventListener('mouseup', () => ring.classList.remove('is-down'));
  }

  /* Sections and cards rise into place once, staggered a little, as they scroll in. */
  function initReveal() {
    if (reduceMotion()) return;
    document.documentElement.classList.add('lnf-motion');

    const selector =
      '.section-head, .step, .category-card, .panel, .cta-band, .empty-state, ' +
      '.masonry > *, .hero-stats > *, .stat-row > *, .review-card';
    let order = 0;
    let waiting = [];

    function tag() {
      Array.from(document.querySelectorAll(selector)).forEach((el) => {
        if ('reveal' in el.dataset || el.classList.contains('is-in')) return;
        el.setAttribute('data-reveal', '');
        el.style.setProperty('--reveal-delay', String((order % 6) * 55));
        order += 1;
        waiting.push(el);
      });
    }

    function sweep() {
      const limit = window.innerHeight * 0.94;
      waiting = waiting.filter((el) => {
        if (!el.isConnected) return false;
        const box = el.getBoundingClientRect();
        if (box.top < limit && box.bottom > -60) {
          el.classList.add('is-in');
          return false;
        }
        return true;
      });
    }

    /* Scroll-driven on purpose: IntersectionObserver callbacks can be skipped in
       throttled or backgrounded tabs, and content must never stay invisible. */
    let last = 0;
    function onMotion() {
      const now = Date.now();
      if (now - last < 50) return;
      last = now;
      sweep();
    }

    tag();
    sweep();
    window.addEventListener('scroll', onMotion, { passive: true });
    window.addEventListener('resize', onMotion);
    window.addEventListener('load', () => { tag(); sweep(); });

    const refresh = debounce(() => { tag(); sweep(); }, 140);
    new MutationObserver(refresh).observe(document.body, { childList: true, subtree: true });
  }

  /* Thin gradient bar that fills as the page scrolls. */
  function initProgress() {
    if (document.getElementById('lnf-progress')) return;
    const bar = document.createElement('div');
    bar.id = 'lnf-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);

    function paint() {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const value = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      bar.style.setProperty('--p', value.toFixed(4));
    }

    paint();
    window.addEventListener('scroll', paint, { passive: true });
    window.addEventListener('resize', paint);
  }

  function initMotion() {
    try {
      initProgress();
      initCursor();
      initReveal();
    } catch (error) {
      document.documentElement.classList.remove('lnf-motion', 'lnf-cursor-on');
    }
  }

  initMotion();

  window.LNF = {
    state,
    boot,
    api,
    qs,
    qsa,
    icon,
    escapeHtml,
    avatar,
    initials,
    timeAgo,
    formatDate,
    formatTime,
    money,
    typeLabel,
    debounce,
    param,
    toast,
    listingCard,
    skeletonCards,
    emptyState,
    openModal,
    confirmDialog,
    requireAuth,
    toggleSave,
    setUnread,
    renderChrome,
    logout,
  };
})();
