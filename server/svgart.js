'use strict';

/**
 * Generative "photo" artwork for seeded listings.
 *
 * The demo runs without network access or external image services, so each
 * seeded listing gets a locally rendered SVG illustration. Uploaded photos are
 * used as-is, so the product still shows real photography when people post.
 */

const PALETTES = [
  { a: '#dbeafe', b: '#bfdbfe', ink: '#1e3a8a' },
  { a: '#fee2e2', b: '#fecdd3', ink: '#881337' },
  { a: '#dcfce7', b: '#bbf7d0', ink: '#14532d' },
  { a: '#fef3c7', b: '#fde68a', ink: '#78350f' },
  { a: '#ede9fe', b: '#ddd6fe', ink: '#4c1d95' },
  { a: '#ccfbf1', b: '#99f6e4', ink: '#134e4a' },
  { a: '#e2e8f0', b: '#cbd5e1', ink: '#1e293b' },
  { a: '#fae8ff', b: '#f5d0fe', ink: '#701a75' },
  { a: '#ffedd5', b: '#fed7aa', ink: '#7c2d12' },
  { a: '#e0f2fe', b: '#bae6fd', ink: '#075985' },
];

const GLYPHS = {
  phone:
    '<rect x="150" y="66" width="100" height="268" rx="24"/><line x1="186" y1="94" x2="214" y2="94"/><circle cx="200" cy="304" r="8"/>',
  wallet:
    '<rect x="78" y="132" width="244" height="150" rx="26"/><path d="M78 180h244"/><rect x="238" y="200" width="96" height="54" rx="14"/><circle cx="268" cy="227" r="7"/>',
  keys:
    '<circle cx="138" cy="148" r="46"/><circle cx="138" cy="148" r="16"/><path d="M172 178l104 104"/><path d="M244 250l30 30"/><path d="M274 280l26 26"/>',
  bag:
    '<path d="M112 168h176l-16 176H128z"/><path d="M156 168c0-42 20-66 44-66s44 24 44 66"/><path d="M170 214h60"/>',
  headphones:
    '<path d="M104 214v-22a96 96 0 01192 0v22"/><rect x="82" y="204" width="48" height="90" rx="22"/><rect x="270" y="204" width="48" height="90" rx="22"/>',
  glasses:
    '<circle cx="146" cy="206" r="48"/><circle cx="254" cy="206" r="48"/><path d="M194 200h12"/><path d="M98 190l-26-16"/><path d="M302 190l26-16"/>',
  watch:
    '<circle cx="200" cy="200" r="68"/><path d="M200 162v42l28 18"/><path d="M166 142l10-60h48l10 60"/><path d="M166 258l10 60h48l10-60"/>',
  book:
    '<path d="M118 104h132a26 26 0 0126 26v174H144a26 26 0 00-26 26z"/><path d="M118 330a26 26 0 0126-26h132"/><path d="M164 150h72"/><path d="M164 186h48"/>',
  umbrella:
    '<path d="M84 204a116 116 0 01232 0z"/><path d="M200 204v112a30 30 0 0060 0"/><path d="M200 84v20"/>',
  camera:
    '<rect x="86" y="140" width="228" height="152" rx="26"/><circle cx="200" cy="216" r="48"/><path d="M158 112h84v28h-84z"/><circle cx="272" cy="172" r="8"/>',
  bottle:
    '<path d="M172 100h56v34l16 34v146a18 18 0 01-18 18h-52a18 18 0 01-18-18V168l16-34z"/><path d="M172 176h56"/><path d="M182 100V76h36v24"/>',
  jewellery:
    '<circle cx="200" cy="238" r="62"/><path d="M166 150l34-52 34 52-34 36z"/><path d="M200 186v-88"/><path d="M188 104l12-22 12 22"/>',
  clothing:
    '<path d="M200 102l-72 32-28 92 48 20 12-42v104h80V204l12 42 48-20-28-92-72-32z"/><path d="M174 118c6 22 46 22 52 0"/>',
  pets:
    '<circle cx="200" cy="222" r="80"/><path d="M142 168l-16-58 56 32"/><path d="M258 168l16-58-56 32"/><circle cx="172" cy="212" r="6"/><circle cx="228" cy="212" r="6"/><path d="M200 236v14"/><path d="M176 258c8 12 40 12 48 0"/>',
  bicycle:
    '<circle cx="128" cy="252" r="54"/><circle cx="272" cy="252" r="54"/><path d="M128 252l50-72h44l30 72"/><path d="M178 180h-24"/><path d="M222 180l50 72"/><path d="M196 180l-8 72"/>',
  documents:
    '<path d="M136 90h112l42 42v182H136z"/><path d="M248 90v42h42"/><path d="M168 176h88"/><path d="M168 212h88"/><path d="M168 248h56"/>',
  luggage:
    '<rect x="100" y="148" width="200" height="166" rx="22"/><path d="M168 148v-26a16 16 0 0116-16h32a16 16 0 0116 16v26"/><path d="M164 190v84"/><path d="M236 190v84"/>',
  box:
    '<path d="M104 160l96-44 96 44-96 44z"/><path d="M104 160v112l96 44 96-44V160"/><path d="M200 204v112"/>',
};

const CATEGORY_GLYPH = {
  'Phones & Electronics': 'phone',
  'Wallets & Cards': 'wallet',
  Keys: 'keys',
  'Bags & Luggage': 'bag',
  Audio: 'headphones',
  Eyewear: 'glasses',
  Watches: 'watch',
  'Books & Stationery': 'book',
  Umbrellas: 'umbrella',
  Cameras: 'camera',
  Bottles: 'bottle',
  Jewellery: 'jewellery',
  Clothing: 'clothing',
  Pets: 'pets',
  Bicycles: 'bicycle',
  Documents: 'documents',
  Other: 'box',
};

function paletteFor(category, variant = 0) {
  const seed = hash(String(category) + variant);
  return PALETTES[seed % PALETTES.length];
}

function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function buildSvg(category, variant = 0, height = 780) {
  const palette = paletteFor(category, variant);
  const glyph = GLYPHS[CATEGORY_GLYPH[category] || 'box'] || GLYPHS.box;
  const offsetY = Math.round((height - 400) / 2) - 10;
  const tilt = variant % 2 === 0 ? -3 : 3;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 ${height}" width="600" height="${height}" role="img" aria-label="Illustration of a ${escapeXml(category)} item">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${palette.a}"/>
      <stop offset="1" stop-color="${palette.b}"/>
    </linearGradient>
  </defs>
  <rect width="600" height="${height}" fill="url(#bg)"/>
  <circle cx="92" cy="86" r="152" fill="#ffffff" opacity="0.26"/>
  <circle cx="544" cy="${height - 62}" r="196" fill="#ffffff" opacity="0.18"/>
  <circle cx="470" cy="150" r="42" fill="none" stroke="#ffffff" stroke-opacity="0.4" stroke-width="10"/>
  <ellipse cx="300" cy="${offsetY + 330}" rx="150" ry="24" fill="${palette.ink}" opacity="0.10"/>
  <g transform="translate(100 ${offsetY}) rotate(${tilt} 200 200)" fill="none" stroke="${palette.ink}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" opacity="0.82">
    ${glyph}
  </g>
</svg>`;
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (char) => {
    return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char];
  });
}

/**
 * A compact colour-layout signature (4x4 grid of RGB values). Seeded artwork
 * derives it from the palette; browsers send one for uploaded photos.
 */
function artSignature(category, variant = 0) {
  const palette = paletteFor(category, variant);
  const from = hexToRgb(palette.a);
  const to = hexToRgb(palette.b);
  const seed = hash(String(category) + variant);
  const cells = [];
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const t = (row + col) / 6;
      const jitter = (((seed >> (row * 4 + col)) & 7) - 3) / 90;
      for (let channel = 0; channel < 3; channel += 1) {
        const base = from[channel] + (to[channel] - from[channel]) * t;
        const white = 18 * (1 - t);
        cells.push(Math.round(Math.min(255, Math.max(0, base + white + jitter * 255))) / 255);
      }
    }
  }
  return cells.map((value) => Math.round(value * 1000) / 1000);
}

module.exports = {
  buildSvg,
  artSignature,
  paletteFor,
  CATEGORY_GLYPH,
  GLYPHS,
};
