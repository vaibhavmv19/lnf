/* Google-only sign-in for RVU accounts, honouring ?next= redirects. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs } = LNF;

  const params = new URLSearchParams(window.location.search);
  const next = params.get('next') || '/';

  function safeNext() {
    return next.startsWith('/') && !next.startsWith('//') ? next : '/';
  }

  function showError(message) {
    const box = qs('#auth-error');
    if (!box) return;
    box.textContent = message;
    box.classList.remove('hidden');
  }

  function startUrl() {
    return '/api/auth/google/start?next=' + encodeURIComponent(safeNext());
  }

  async function start() {
    const state = await LNF.boot;
    if (state.user) {
      window.location.href = safeNext();
      return;
    }

    const failed = params.get('error');
    if (failed) showError(failed);

    let config = {};
    try {
      config = await api('/api/auth/config');
    } catch (error) {
      showError(error.message);
      return;
    }

    const domain = config.googleDomain || 'mys.rvu.edu.in';
    const hint = qs('#domain-hint');
    if (hint) {
      hint.innerHTML = 'Only accounts managed by <strong>@' + domain + '</strong> can sign in.';
    }

    const button = qs('#google-continue');
    if (!button) return;

    if (!config.googleEnabled) {
      button.addEventListener('click', () => {
        showError('Google sign-in is not available on this copy yet.');
      });
      return;
    }

    button.addEventListener('click', () => {
      window.location.href = startUrl();
    });
  }

  start().catch((error) => console.error(error));
})();
