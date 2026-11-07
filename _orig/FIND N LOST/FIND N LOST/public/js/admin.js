/* Moderation: report queue, recent listings and marketplace health. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs, icon, escapeHtml, timeAgo, formatDate, emptyState, confirmDialog, toast } = LNF;

  const root = qs('#admin-page');

  function statCard(value, label) {
    return '<div class="stat"><strong>' + Number(value || 0).toLocaleString('en-IN') + '</strong><span>' + escapeHtml(label) + '</span></div>';
  }

  function reportRow(report) {
    return (
      '<div class="report-row" data-report="' + escapeHtml(report.id) + '">' +
      '<div class="body"><strong>' + escapeHtml(report.reason) + '</strong>' +
      '<p>' + (report.details ? escapeHtml(report.details) : 'No extra details provided.') + '</p>' +
      '<p class="hint" style="margin-top:4px">' +
      (report.reporter ? 'Reported by @' + escapeHtml(report.reporter.username) : 'Reported anonymously') +
      ' &middot; ' + escapeHtml(timeAgo(report.createdAt)) +
      (report.listing ? ' &middot; <a href="/item/' + encodeURIComponent(report.listing.id) + '">' + escapeHtml(report.listing.title) + '</a> (' + escapeHtml(report.listing.status) + ')' : '') +
      '</p></div>' +
      '<span class="badge ' + (report.status === 'pending' ? 'amber' : report.status === 'resolved' ? 'returned' : '') + '">' + escapeHtml(report.status) + '</span>' +
      '<div class="row">' +
      '<button class="btn btn-outline btn-sm" type="button" data-review="resolved">Resolve</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-review="dismissed">Dismiss</button>' +
      (report.listing && report.listing.status !== 'removed'
        ? '<button class="btn btn-danger btn-sm" type="button" data-remove>Remove listing</button>'
        : '') +
      '</div></div>'
    );
  }

  function render(data) {
    const reports = data.reports || [];
    const pending = reports.filter((report) => report.status === 'pending');
    root.innerHTML =
      '<div class="admin-grid">' +
      statCard(data.stats.listings, 'Active listings') +
      statCard(data.stats.reunited, 'Verified reunions') +
      statCard(data.stats.members, 'Members') +
      statCard(pending.length, 'Open reports') +
      '</div>' +

      '<section class="panel" style="overflow:hidden;margin-bottom:18px">' +
      '<div class="panel-head"><h3>Reports ' + (pending.length ? '<span class="badge amber">' + pending.length + ' pending</span>' : '') + '</h3>' +
      '<span class="result-count">' + reports.length + ' total</span></div>' +
      (reports.length ? reports.map(reportRow).join('') : '<div class="panel-body"><p class="hint">No reports have been submitted. That is a good sign.</p></div>') +
      '</section>' +

      '<div class="post-layout" style="padding-bottom:0">' +
      '<section class="panel" style="overflow:hidden">' +
      '<div class="panel-head"><h3>Recent listings</h3><a class="section-link" href="/explore">Open marketplace</a></div>' +
      '<div style="overflow-x:auto"><table class="table"><thead><tr><th>Item</th><th>Type</th><th>City</th><th>Status</th><th>Posted</th></tr></thead><tbody>' +
      (data.recent || [])
        .map(
          (listing) =>
            '<tr><td><a href="/item/' + encodeURIComponent(listing.id) + '">' + escapeHtml(listing.title) + '</a></td>' +
            '<td>' + escapeHtml(listing.type) + '</td><td>' + escapeHtml(listing.city) + '</td>' +
            '<td><span class="badge ' + (listing.status === 'returned' ? 'returned' : '') + '">' + escapeHtml(listing.status) + '</span></td>' +
            '<td>' + escapeHtml(formatDate(listing.createdAt)) + '</td></tr>',
        )
        .join('') +
      '</tbody></table></div></section>' +

      '<aside class="post-side">' +
      '<div class="panel"><div class="panel-head"><h3>Marketplace</h3></div><div class="panel-body">' +
      '<div class="switch-row"><div><strong>' + (data.stats.lost || 0) + '</strong><span>Lost reports</span></div>' +
      '<div style="text-align:right"><strong>' + (data.stats.found || 0) + '</strong><span>Found reports</span></div></div>' +
      '<div class="switch-row"><div><strong>' + (data.stats.conversations || 0) + '</strong><span>Conversations</span></div>' +
      '<div style="text-align:right"><strong>' + (data.stats.messages || 0) + '</strong><span>Messages sent</span></div></div>' +
      '</div></div>' +
      '<div class="panel"><div class="panel-head"><h3>Newest members</h3></div><div class="panel-body">' +
      (data.members || [])
        .map(
          (member) =>
            '<div class="row" style="justify-content:space-between;padding:6px 0">' +
            '<a href="/profile/' + encodeURIComponent(member.username) + '">@' + escapeHtml(member.username) + '</a>' +
            '<span class="hint">' + escapeHtml(formatDate(member.createdAt)) + '</span></div>',
        )
        .join('') +
      '</div></div></aside></div>';

    root.querySelectorAll('[data-report]').forEach((node) => {
      node.querySelectorAll('[data-review]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            await api('/api/admin/reports/' + encodeURIComponent(node.dataset.report), {
              method: 'PATCH',
              body: { status: button.dataset.review },
            });
            toast('Report ' + button.dataset.review + '.', 'success');
            await load();
          } catch (error) {
            toast(error.message, 'error');
          }
        });
      });
      const remove = node.querySelector('[data-remove]');
      if (remove) {
        remove.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Remove this listing?',
            message: 'The listing disappears from the marketplace and its matches are deleted.',
            confirmText: 'Remove listing',
            danger: true,
          });
          if (!ok) return;
          try {
            await api('/api/admin/reports/' + encodeURIComponent(node.dataset.report), {
              method: 'PATCH',
              body: { status: 'resolved', removeListing: true },
            });
            toast('Listing removed.', 'success');
            await load();
          } catch (error) {
            toast(error.message, 'error');
          }
        });
      }
    });
  }

  async function load() {
    try {
      const data = await api('/api/admin/overview');
      render(data);
    } catch (error) {
      if (error.status === 401) {
        window.location.href = '/login?next=' + encodeURIComponent('/admin');
        return;
      }
      if (error.status === 403) {
        root.innerHTML = emptyState({
          icon: 'shield',
          title: 'Moderators only',
          message: 'This area is limited to moderators. Sign in with the demo moderator account to review reports.',
          actionLabel: 'Back to the marketplace',
          actionHref: '/explore',
        });
        return;
      }
      root.innerHTML = emptyState({ icon: 'alert', title: 'Moderation data could not load', message: error.message });
    }
  }

  (async function start() {
    await LNF.boot;
    if (!LNF.state.user) {
      window.location.href = '/login?next=' + encodeURIComponent('/admin');
      return;
    }
    await load();
  })().catch((error) => {
    console.error(error);
    toast('Moderation could not load.', 'error');
  });
})();
