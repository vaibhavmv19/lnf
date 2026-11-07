/* Account settings: profile, notification preferences and password. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs, icon, escapeHtml, toast } = LNF;

  const root = qs('#settings-page');
  let user = null;

  function switchRow(id, title, description, checked) {
    return (
      '<div class="switch-row"><div><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(description) + '</span></div>' +
      '<label class="switch"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + ' /><i></i></label></div>'
    );
  }

  function render() {
    if (!root || !user) return;
    const prefs = user.prefs || { emailMatches: true, emailMessages: true, emailUpdates: false };
    root.innerHTML =
      '<div class="post-layout">' +
      '<div style="display:flex;flex-direction:column;gap:16px">' +
      '<section class="panel"><div class="panel-head"><h3>Profile</h3></div><div class="panel-body">' +
      '<form id="profile-form">' +
      '<div class="form-grid">' +
      '<div class="field span-2"><label class="label" for="s-name">Full name</label>' +
      '<input class="input" id="s-name" maxlength="60" value="' + escapeHtml(user.fullName) + '" /></div>' +
      '<div class="field"><label class="label" for="s-city">City</label>' +
      '<input class="input" id="s-city" maxlength="80" value="' + escapeHtml(user.city || '') + '" /></div>' +
      '<div class="field"><label class="label" for="s-username">Username</label>' +
      '<input class="input" id="s-username" value="@' + escapeHtml(user.username) + '" disabled /></div>' +
      '<div class="field span-2"><label class="label" for="s-bio">Short bio</label>' +
      '<textarea class="textarea" id="s-bio" maxlength="400" style="min-height:80px" placeholder="A line about you, if you like.">' + escapeHtml(user.bio || '') + '</textarea>' +
      '<span class="hint">Visible on your public profile. Never include contact details.</span></div>' +
      '</div>' +
      '<div class="row" style="justify-content:flex-end"><button class="btn btn-primary" type="submit">Save profile</button></div>' +
      '</form></div></section>' +

      '<section class="panel"><div class="panel-head"><h3>Notifications</h3></div><div class="panel-body" style="padding-top:4px;padding-bottom:6px">' +
      '<form id="prefs-form">' +
      switchRow('p-matches', 'Possible matches', 'Tell me when a found report looks like something I lost.', prefs.emailMatches) +
      switchRow('p-messages', 'New messages', 'Tell me when someone replies about one of my listings.', prefs.emailMessages) +
      switchRow('p-updates', 'Product updates', 'Occasional notes about new Lost N Found features.', prefs.emailUpdates) +
      '<div class="row" style="justify-content:flex-end;padding:12px 0"><button class="btn btn-primary" type="submit">Save preferences</button></div>' +
      '</form></div></section>' +

      '<section class="panel"><div class="panel-head"><h3>Password</h3></div><div class="panel-body">' +
      '<form id="password-form">' +
      '<div class="form-grid">' +
      '<div class="field"><label class="label" for="s-current">Current password</label>' +
      '<input class="input" id="s-current" type="password" autocomplete="current-password" /></div>' +
      '<div class="field"><label class="label" for="s-new">New password</label>' +
      '<input class="input" id="s-new" type="password" autocomplete="new-password" placeholder="At least 8 characters" /></div>' +
      '</div>' +
      '<div class="row" style="justify-content:flex-end"><button class="btn btn-outline" type="submit">Update password</button></div>' +
      '</form></div></section>' +
      '</div>' +

      '<aside class="post-side">' +
      '<div class="panel"><div class="panel-body">' +
      '<h3 style="margin-bottom:8px">' + icon('user') + ' Account</h3>' +
      '<p class="hint" style="margin-bottom:6px">Email</p><strong>' + escapeHtml(user.email || '') + '</strong>' +
      '<p class="hint" style="margin-top:12px;margin-bottom:6px">Reputation</p><strong>' + (user.reputation || 0) + ' points &middot; ' + (user.successfulReturns || 0) + ' verified returns</strong>' +
      '<div style="margin-top:14px"><a class="btn btn-outline btn-sm btn-block" href="/profile/' + encodeURIComponent(user.username) + '">View public profile</a></div>' +
      '</div></div>' +
      '<div class="panel"><div class="panel-body">' +
      '<h3 style="margin-bottom:6px">' + icon('shield') + ' Privacy</h3>' +
      '<p class="hint">Your email, private verification details and exact handover plans are never shown publicly. Only you and the other person in a conversation can read it.</p>' +
      '<button class="btn btn-danger btn-sm btn-block" type="button" id="signout" style="margin-top:12px">' + icon('logout') + 'Sign out</button>' +
      '</div></div>' +
      '</aside></div>';

    wire();
  }

  function wire() {
    const profileForm = qs('#profile-form');
    if (profileForm) {
      profileForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          const result = await api('/api/settings', {
            method: 'PATCH',
            body: {
              fullName: qs('#s-name').value.trim(),
              city: qs('#s-city').value.trim(),
              bio: qs('#s-bio').value.trim(),
            },
          });
          user = { ...user, ...result.user };
          LNF.state.user = { ...LNF.state.user, ...result.user };
          LNF.renderChrome();
          toast('Profile saved.', 'success');
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    }

    const prefsForm = qs('#prefs-form');
    if (prefsForm) {
      prefsForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          const result = await api('/api/settings', {
            method: 'PATCH',
            body: {
              prefs: {
                emailMatches: qs('#p-matches').checked,
                emailMessages: qs('#p-messages').checked,
                emailUpdates: qs('#p-updates').checked,
              },
            },
          });
          user = { ...user, ...result.user };
          toast('Preferences saved.', 'success');
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    }

    const passwordForm = qs('#password-form');
    if (passwordForm) {
      passwordForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const currentPassword = qs('#s-current').value;
        const newPassword = qs('#s-new').value;
        if (!currentPassword || newPassword.length < 8) {
          toast('Enter your current password and a new one of at least 8 characters.', 'error');
          return;
        }
        try {
          await api('/api/settings/password', { method: 'POST', body: { currentPassword, newPassword } });
          qs('#s-current').value = '';
          qs('#s-new').value = '';
          toast('Password updated.', 'success');
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    }

    const signout = qs('#signout');
    if (signout) signout.addEventListener('click', () => LNF.logout());
  }

  (async function start() {
    await LNF.boot;
    if (!LNF.state.user) {
      window.location.href = '/login?next=' + encodeURIComponent('/settings');
      return;
    }
    user = LNF.state.user;
    render();
  })().catch((error) => console.error(error));
})();
