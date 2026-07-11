'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

const CTA_VARIATIONS = [
  {
    en: "If this spoke to you, comment the word me below and we will send you our self discipline guide.",
    he: "אם זה דיבר אליכם,\nתגיבו \"אני\" ואנחנו נשלח לכם\nאת המדריך למשמעת עצמית 👇",
  },
  {
    en: "If you are serious about growing, comment me below and we will send you our guide.",
    he: "אם אתם רציניים לגבי צמיחה,\nתגיבו \"אני\" ונשלח לכם\nאת המדריך 👇",
  },
  {
    en: "Comment the word me if you want our self discipline guide sent to you.",
    he: "תגיבו \"אני\" אם אתם רוצים\nשנשלח לכם את המדריך\nלמשמעת עצמית 👇",
  },
  {
    en: "Those who are ready to change, comment me below and we will send you the guide.",
    he: "מי שמוכן להשתנות,\nשיגיב \"אני\" ויקבל\nאת המדריך 👇",
  },
  {
    en: "Do not stay behind. Comment me and we will send you our self discipline guide right now.",
    he: "אל תישארו מאחור.\nתגיבו \"אני\" וקבלו את המדריך\nלמשמעת עצמית עכשיו 👇",
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
