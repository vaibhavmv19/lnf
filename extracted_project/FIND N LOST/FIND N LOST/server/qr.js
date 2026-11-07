'use strict';

/**
 * Renders a QR code as a standalone SVG string.
 *
 * The encoder is the MIT-licensed `qrcode-generator` by Kazuhiko Arase,
 * vendored in ./vendor so the project stays dependency-free and offline.
 */

const qrcode = require('./vendor/qrcode');

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function qrSvg(text, options = {}) {
  const size = clamp(options.size || 320, 96, 1024);
  const margin = clamp(options.margin == null ? 4 : options.margin, 0, 12);
  const dark = options.dark || '#101827';
  const light = options.light || '#ffffff';

  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();

  const count = qr.getModuleCount();
  const total = count + margin * 2;
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" role="img" aria-label="Collection QR code" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}

module.exports = { qrSvg };
