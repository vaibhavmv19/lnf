/* Post or edit a listing, with in-browser photo compression and a colour signature. */
(function () {
  'use strict';

  const LNF = window.LNF;
  const { api, qs, icon, escapeHtml, toast, requireAuth } = LNF;

  const root = qs('#post-page');
  const params = new URLSearchParams(window.location.search);
  const editId = params.get('edit');
  const state = {
    type: params.get('type') === 'found' ? 'found' : 'lost',
    images: [],
    meta: { categories: [], colors: [], cities: [] },
    listing: null,
    saving: false,
  };

  const MAX_IMAGES = 5;
  const MAX_SIDE = 1400;

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('That photo could not be read.'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('That photo could not be decoded.'));
      image.src = src;
    });
  }

  function signatureOf(image) {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 4, 4);
    let pixels;
    try {
      pixels = context.getImageData(0, 0, 4, 4).data;
    } catch (error) {
      return null;
    }
    const values = [];
    for (let index = 0; index < pixels.length; index += 4) {
      values.push(Math.round((pixels[index] / 255) * 1000) / 1000);
      values.push(Math.round((pixels[index + 1] / 255) * 1000) / 1000);
      values.push(Math.round((pixels[index + 2] / 255) * 1000) / 1000);
    }
    return values;
  }

  async function prepare(file) {
    const dataUrl = await readFile(file);
    const image = await loadImage(dataUrl);
    const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const compressed = canvas.toDataURL('image/jpeg', 0.82);
    if (compressed.length > 2_500_000) {
      throw new Error('That photo is still too large after compression. Try a smaller one.');
    }
    const signature = signatureOf(image);
    return { data: compressed, aspect: Math.round((width / height) * 1000) / 1000, signature, preview: compressed };
  }

  function categoryOptions() {
    return state.meta.categories
      .map(
        (category) =>
          '<option value="' + escapeHtml(category.name) + '"' +
          (state.listing && state.listing.category === category.name ? ' selected' : '') + '>' +
          escapeHtml(category.name) + '</option>',
      )
      .join('');
  }

  function colorOptions() {
    const selected = state.listing ? state.listing.color : '';
    return ['', ...(state.meta.colors || [])]
      .map(
        (color) =>
          '<option value="' + escapeHtml(color) + '"' + (selected === color ? ' selected' : '') + '>' +
          (color ? color.charAt(0).toUpperCase() + color.slice(1) : 'Not sure') + '</option>',
      )
      .join('');
  }

  function render() {
    if (!root) return;
    const listing = state.listing;
    const today = new Date().toISOString().slice(0, 10);
    const title = qs('#post-title');
    const subtitle = qs('#post-subtitle');
    if (editId) {
      if (title) title.textContent = 'Edit your listing';
      if (subtitle) subtitle.textContent = 'Changes are saved immediately. Matching suggestions refresh automatically.';
    }

    const tiles = state.images
      .map(
        (image, index) =>
          '<div class="upload-tile">' +
          '<img src="' + escapeHtml(image.preview || image.url) + '" alt="Photo ' + (index + 1) + '" />' +
          '<button class="remove" type="button" data-remove="' + index + '" aria-label="Remove photo">×</button>' +
          '</div>',
      )
      .join('');

    const addTile =
      state.images.length < MAX_IMAGES
        ? '<button class="upload-tile" type="button" id="add-photo">' +
          '<span class="inner">' + icon('camera') + 'Add photo</span></button>'
        : '';

    root.innerHTML =
      '<div class="post-card">' +
      '<div class="stepper">' +
      '<div class="is-active"><b>1</b> Photos</div><hr />' +
      '<div class="is-active"><b>2</b> Details</div><hr />' +
      '<div class="is-active"><b>3</b> Verify</div>' +
      '</div>' +
      '<div class="type-toggle">' +
      '<label class="type-option"><input type="radio" name="type" value="lost"' + (state.type === 'lost' ? ' checked' : '') + ' />' +
      '<strong>I LOST <span class="type-tag">Collector</span></strong><span>I am missing this item and will collect it.</span></label>' +
      '<label class="type-option"><input type="radio" name="type" value="found"' + (state.type === 'found' ? ' checked' : '') + ' />' +
      '<strong>I FOUND <span class="type-tag">Finder</span></strong><span>I have the item and want to hand it back.</span></label>' +
      '</div>' +

      '<div class="field"><span class="label">Photos <span class="hint">(up to ' + MAX_IMAGES + ', compressed in your browser)</span></span>' +
      '<div class="upload-grid" id="upload-grid">' + tiles + addTile + '</div>' +
      '<input type="file" id="photo-input" accept="image/jpeg,image/png,image/webp" multiple hidden />' +
      '<span class="hint">Photos are re-encoded before upload, which also removes location data (EXIF).</span></div>' +

      '<div class="form-grid">' +
      '<div class="field span-2"><label class="label" for="f-title">What is it?</label>' +
      '<input class="input" id="f-title" maxlength="120" placeholder="e.g. Black leather wallet with a torn inner pocket" value="' + escapeHtml(listing ? listing.title : '') + '" /></div>' +
      '<div class="field"><label class="label" for="f-category">Category</label>' +
      '<select class="select" id="f-category">' + categoryOptions() + '</select></div>' +
      '<div class="field"><label class="label" for="f-color">Main colour</label>' +
      '<select class="select" id="f-color">' + colorOptions() + '</select></div>' +
      '<div class="field"><label class="label" for="f-brand">Brand or make <span class="hint">(optional)</span></label>' +
      '<input class="input" id="f-brand" maxlength="60" placeholder="e.g. Hidesign" value="' + escapeHtml(listing ? listing.brand : '') + '" /></div>' +
      '<div class="field"><label class="label" for="f-date">Date</label>' +
      '<input class="input" id="f-date" type="date" max="' + today + '" value="' + escapeHtml(listing ? listing.incidentDate : today) + '" /></div>' +
      '<div class="field span-2"><label class="label" for="f-location">Location on campus</label>' +
      '<input class="input" id="f-location" maxlength="120" placeholder="e.g. Central Library, 2nd floor" value="' + escapeHtml(listing ? (listing.area || listing.city) : '') + '" />' +
      '<span class="hint">A building or landmark is enough. Exact rooms and personal addresses are never shown.</span></div>' +
      '<div class="field span-2"><label class="label" for="f-description">Description <span class="hint">(optional)</span></label>' +
      '<textarea class="textarea" id="f-description" maxlength="2000" placeholder="Describe the item, when you last saw it, and anything that makes it recognisable. Avoid your phone number or address.">' + escapeHtml(listing ? listing.description : '') + '</textarea></div>' +
      '</div>' +

      '<div class="field"><label class="label" for="f-reward">Reward <span class="hint">(optional, in ₹)</span></label>' +
      '<input class="input" id="f-reward" type="number" min="0" max="100000" step="50" placeholder="0" value="' + (listing && listing.reward ? listing.reward : '') + '" /></div>' +

      '<div class="row" style="justify-content:flex-end;margin-top:6px">' +
      '<a class="btn btn-ghost" href="' + (listing ? '/item/' + encodeURIComponent(listing.id) : '/explore') + '">Cancel</a>' +
      '<button class="btn btn-primary" type="button" id="submit-post">' + (editId ? 'Save changes' : 'Publish listing') + '</button>' +
      '</div></div>' +

      '<aside class="post-side">' +
      '<div class="panel"><div class="panel-body">' +
      '<h3 style="margin-bottom:8px">' + icon('shield') + ' Post it safely</h3>' +
      '<ul class="checklist">' +
      '<li>' + icon('check') + '<span>Never put your address or phone number in a listing.</span></li>' +
      '<li>' + icon('check') + '<span>Photos are compressed and stripped of camera metadata.</span></li>' +
      '<li>' + icon('check') + '<span>Verification happens privately in messages.</span></li>' +
      '<li>' + icon('check') + '<span>Meet in a public place and never pay to get an item back.</span></li>' +
      '</ul></div></div>' +
      '<div class="panel"><div class="panel-body">' +
      '<h3 style="margin-bottom:6px">' + icon('sparkles') + ' Matching</h3>' +
      '<p>As soon as you publish, we compare your photos, description, category and location against reports of the opposite type. Strong pairs become suggestions, never automatic claims.</p>' +
      '</div></div>' +
      '</aside>';

    wire();
  }

  function wire() {
    root.querySelectorAll('input[name="type"]').forEach((input) => {
      input.addEventListener('change', () => {
        state.type = input.value;
      });
    });

    const input = qs('#photo-input');
    const add = qs('#add-photo');
    if (add && input) add.addEventListener('click', () => input.click());
    if (input) {
      input.addEventListener('change', async () => {
        const files = Array.from(input.files || []).slice(0, MAX_IMAGES - state.images.length);
        input.value = '';
        for (const file of files) {
          if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
            toast('Only JPEG, PNG and WebP photos are supported.', 'error');
            continue;
          }
          try {
            const image = await prepare(file);
            state.images.push(image);
            render();
          } catch (error) {
            toast(error.message, 'error');
          }
        }
      });
    }

    root.querySelectorAll('[data-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        state.images.splice(Number(button.dataset.remove), 1);
        render();
      });
    });

    const submit = qs('#submit-post');
    if (submit) submit.addEventListener('click', save);
  }

  function collect() {
    return {
      type: state.type,
      title: qs('#f-title').value.trim(),
      description: qs('#f-description').value.trim(),
      category: qs('#f-category').value,
      brand: qs('#f-brand').value.trim(),
      color: qs('#f-color').value,
      location: qs('#f-location').value.trim(),
      incidentDate: qs('#f-date').value,
      reward: Number(qs('#f-reward').value || 0),
    };
  }

  async function save() {
    if (state.saving) return;
    if (!LNF.state.user) {
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search);
      return;
    }
    const values = collect();
    if (!state.images.length) return toast('Add at least one photo so people can recognise the item.', 'error');
    if (values.title.length < 4) return toast('Give the item a short, clear title.', 'error');
    if (!values.location) return toast('Where on campus was it lost or found?', 'error');

    const button = qs('#submit-post');
    state.saving = true;
    if (button) {
      button.disabled = true;
      button.textContent = 'Saving…';
    }

    const images = state.images.map((image) => {
      if (image.url) return { url: image.url, aspect: image.aspect };
      return { data: image.data, aspect: image.aspect, signature: image.signature || null };
    });
    const signature = state.images.find((image) => image.signature)?.signature || null;

    try {
      if (editId) {
        await api('/api/listings/' + encodeURIComponent(editId), {
          method: 'PATCH',
          body: { ...values, images, signature },
        });
        toast('Listing updated.', 'success');
        setTimeout(() => { window.location.href = '/item/' + encodeURIComponent(editId); }, 450);
      } else {
        const result = await api('/api/listings', { method: 'POST', body: { ...values, images, signature } });
        const created = result.matches || 0;
        toast(created ? 'Listing published. ' + created + ' possible match' + (created === 1 ? '' : 'es') + ' found.' : 'Listing published.', 'success');
        setTimeout(() => { window.location.href = '/item/' + encodeURIComponent(result.item.id); }, 550);
      }
    } catch (error) {
      toast(error.message, 'error');
      state.saving = false;
      if (button) {
        button.disabled = false;
        button.textContent = editId ? 'Save changes' : 'Publish listing';
      }
    }
  }

  async function start() {
    await LNF.boot;
    if (!requireAuth('Sign in to post a lost or found item.')) return;
    state.meta = await api('/api/meta').catch(() => ({ categories: [], colors: [], cities: [] }));

    if (editId) {
      try {
        const result = await api('/api/listings/' + encodeURIComponent(editId));
        if (!result.item.canEdit) {
          toast('You can only edit your own listings.', 'error');
          setTimeout(() => { window.location.href = '/item/' + encodeURIComponent(editId); }, 700);
          return;
        }
        state.listing = result.item;
        state.type = result.item.type;
        state.images = (result.item.images || []).map((image) => ({
          url: image.url,
          aspect: image.aspect || 0.8,
          preview: image.url,
        }));
      } catch (error) {
        toast(error.message, 'error');
        setTimeout(() => { window.location.href = '/explore'; }, 800);
        return;
      }
    }

    render();
  }

  start().catch((error) => {
    console.error(error);
    toast('The posting form could not load.', 'error');
  });
})();
