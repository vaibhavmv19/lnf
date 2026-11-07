'use strict';

/**
 * Heuristic similarity engine.
 *
 * The published scoring model mixes image, text and context signals. This
 * implementation runs entirely on the server with no external AI service:
 *
 *   image     45%  colour-layout signature distance (4x4 grid, from the browser
 *                  for uploads, from the artwork palette for seeded listings)
 *   text      30%  token cosine + fuzzy token overlap over title/description
 *   category  10%  exact or sibling-category match
 *   colour     5%  colour-family match
 *   location  10%  city/area proximity blended with incident-date proximity
 *
 * Scores are suggestions only. They never verify ownership, and the UI always
 * asks people to confirm a private detail before arranging a handover.
 */

const WEIGHTS = {
  image: 0.45,
  text: 0.3,
  category: 0.1,
  color: 0.05,
  location: 0.1,
};

const THRESHOLDS = {
  suggest: 0.42,
  notify: 0.62,
  good: 0.6,
  strong: 0.78,
};

const STOPWORDS = new Set(
  `a an the and or but if then than that this these those with without from near by at in on to of for my our your his her its it is was were be been being have has had i we you they he she them us me lost found missing please help item items something someone somewhere yesterday today day night morning evening around approx approximately about left right black white please contact thanks thank`.split(
    /\s+/,
  ),
);

const SIBLING_GROUPS = [
  ['Phones & Electronics', 'Audio', 'Cameras', 'Watches'],
  ['Wallets & Cards', 'Keys', 'Documents', 'Jewellery'],
  ['Bags & Luggage', 'Clothing'],
  ['Books & Stationery', 'Other'],
];

const COLOR_FAMILIES = {
  black: 'dark',
  charcoal: 'dark',
  grey: 'grey',
  gray: 'grey',
  silver: 'grey',
  white: 'light',
  cream: 'light',
  ivory: 'light',
  beige: 'light',
  blue: 'blue',
  navy: 'blue',
  teal: 'blue',
  turquoise: 'blue',
  sky: 'blue',
  red: 'red',
  maroon: 'red',
  crimson: 'red',
  pink: 'pink',
  rose: 'pink',
  purple: 'purple',
  violet: 'purple',
  lavender: 'purple',
  green: 'green',
  olive: 'green',
  mint: 'green',
  yellow: 'yellow',
  mustard: 'yellow',
  gold: 'yellow',
  orange: 'orange',
  brown: 'brown',
  tan: 'brown',
  copper: 'brown',
  transparent: 'clear',
  clear: 'clear',
};

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function termCounts(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

function cosineSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [token, count] of a) {
    normA += count * count;
    const other = b.get(token);
    if (other) dot += count * other;
  }
  for (const count of b.values()) normB += count * count;
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function fuzzyOverlap(tokensA, tokensB) {
  const setB = new Set(tokensB);
  const setA = new Set(tokensA);
  if (!setA.size || !setB.size) return 0;
  const score = (source, target) => {
    let total = 0;
    for (const token of source) {
      if (target.has(token)) {
        total += 1;
        continue;
      }
      if (token.length >= 4) {
        let partial = 0;
        for (const other of target) {
          if (other.length >= 4 && (other.startsWith(token) || token.startsWith(other))) {
            partial = 0.6;
            break;
          }
        }
        total += partial;
      }
    }
    return total / source.size;
  };
  return (score(setA, setB) + score(setB, setA)) / 2;
}

function textSimilarity(listingA, listingB) {
  const textOf = (listing) =>
    [listing.title, listing.title, listing.description, listing.brand, listing.color].filter(Boolean).join(' ');
  const tokensA = tokenize(textOf(listingA));
  const tokensB = tokenize(textOf(listingB));
  const cosine = cosineSimilarity(termCounts(tokensA), termCounts(tokensB));
  const overlap = fuzzyOverlap(tokensA, tokensB);
  return clamp01(cosine * 0.55 + overlap * 0.45);
}

function imageSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 48 || b.length !== 48) return 0.35;
  let total = 0;
  for (let i = 0; i < 48; i += 1) total += Math.abs(a[i] - b[i]);
  const meanDiff = total / 48;
  return clamp01(1 - meanDiff * 2.2);
}

function categoryScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  for (const group of SIBLING_GROUPS) {
    if (group.includes(a) && group.includes(b)) return 0.45;
  }
  return 0;
}

function colorScore(a, b) {
  const familyA = colorFamily(a);
  const familyB = colorFamily(b);
  if (!familyA || !familyB) return 0.3;
  if (familyA === familyB) return 1;
  if (familyA === 'clear' || familyB === 'clear') return 0.55;
  if (familyA === 'dark' && familyB === 'grey') return 0.6;
  if (familyA === 'light' && familyB === 'grey') return 0.6;
  return 0;
}

function colorFamily(value) {
  const words = tokenize(value || '');
  for (const word of words) {
    if (COLOR_FAMILIES[word]) return COLOR_FAMILIES[word];
  }
  return null;
}

function locationScore(a, b) {
  const cityA = normalize(a.city);
  const cityB = normalize(b.city);
  let city = cityA && cityA === cityB ? 1 : 0;
  if (city && a.area && b.area) {
    const areaOverlap = fuzzyOverlap(tokenize(a.area), tokenize(b.area));
    city = Math.min(1, city + areaOverlap * 0.15);
  }
  const days = Math.abs(new Date(a.incidentDate).getTime() - new Date(b.incidentDate).getTime()) / 86_400_000;
  const timing = clamp01(1 - days / 45);
  return clamp01(city * 0.7 + timing * 0.3);
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function scorePair(listingA, listingB) {
  const parts = {
    image: imageSimilarity(listingA.imageSignature, listingB.imageSignature),
    text: textSimilarity(listingA, listingB),
    category: categoryScore(listingA.category, listingB.category),
    color: colorScore(listingA.color, listingB.color),
    location: locationScore(listingA, listingB),
  };
  const total =
    parts.image * WEIGHTS.image +
    parts.text * WEIGHTS.text +
    parts.category * WEIGHTS.category +
    parts.color * WEIGHTS.color +
    parts.location * WEIGHTS.location;
  return {
    total: Math.round(total * 1000) / 1000,
    parts: Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, Math.round(value * 1000) / 1000])),
  };
}

function confidenceLabel(score) {
  if (score >= THRESHOLDS.strong) return 'Strong possible match';
  if (score >= THRESHOLDS.good) return 'Good possible match';
  return 'Other similar items';
}

function confidenceTier(score) {
  if (score >= THRESHOLDS.strong) return 'strong';
  if (score >= THRESHOLDS.good) return 'good';
  return 'similar';
}

module.exports = {
  WEIGHTS,
  THRESHOLDS,
  scorePair,
  confidenceLabel,
  confidenceTier,
  textSimilarity,
  imageSimilarity,
  categoryScore,
  colorScore,
  locationScore,
  tokenize,
};
