'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

// Fixed CTA (exact wording + 3-line layout requested) — used for every video.
// Unlike every other caption, the CTA is deliberately NOT chunked to 4-5 words: it
// stays on screen as one static 3-line block for the whole closing shot.
const CTA_VARIATIONS = [
  {
    en: "Comment the word me if you made it this far, and get our guide to building self discipline.",
    he: "תגיבו \"אני\" אם הגעתם עד לכאן,\nוקבלו את המדריך לפיתוח\nמשמעת עצמית 👇",
  },
];

const CTA_QUERIES = [
  'sunrise mountain success',
  'ocean waves calm inspiring',
  'city skyline sunrise',
  'person standing mountain top',
  'golden sunset landscape',
];

function buildContent(topic, ctaIndex, outDir) {
  const cta = CTA_VARIATIONS[ctaIndex % CTA_VARIATIONS.length];
  const ctaQuery = CTA_QUERIES[ctaIndex % CTA_QUERIES.length];

  const segments = [
    // Hook
    { en: topic.hook.en, he: topic.hook.he, query: topic.points[0].query },
    // Main points
    ...topic.points.map(p => ({ en: p.en, he: p.he, query: p.query })),
    // Fear beat
    { en: topic.fear.en, he: topic.fear.he, query: topic.fear.query },
    // Jealousy beat
    { en: topic.jealousy.en, he: topic.jealousy.he, query: topic.jealousy.query },
  ];

  return {
    outDir,
    segments,
    cta: { en: cta.en, he: cta.he, query: ctaQuery },
  };
}

module.exports = { buildContent };
