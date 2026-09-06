/**
 * Localisation.
 *
 * Dhivehi is written in Thaana, a right-to-left script. RTL is structural here,
 * not a translation file: the queue board, the drag-and-drop, and the push
 * payloads all have to render it.
 *
 * TRANSLATION STATUS — the mechanism is complete and every string resolves
 * through it. Dhivehi copy below is limited to terms we are confident in;
 * anything not present falls back to English and is reported by
 * `pendingTranslations()` so it shows up in the admin template editor as work
 * to do rather than silently shipping wrong Dhivehi to patients. Owner: local
 * copy reviewer, pre-GA gate.
 */

export const LOCALES = ['en', 'dv'];
export const RTL = new Set(['dv']);

const STRINGS = {
  'app.name': { en: 'Vaguthu', dv: 'ވަގުތު' },
  'app.tagline': { en: 'Know your turn.', dv: null },
  'common.doctor': { en: 'Doctor', dv: 'ޑޮކްޓަރ' },
  'common.time': { en: 'Time', dv: 'ވަގުތު' },
  'common.now': { en: 'Now', dv: 'މިހާރު' },
  'common.number': { en: 'Number', dv: 'ނަންބަރު' },
  'common.hospital': { en: 'Hospital', dv: 'ހޮސްޕިޓަލް' },
  'common.language': { en: 'Language', dv: 'ދިވެހި' },
  'queue.howLong': { en: 'How much longer?', dv: 'ކިހާ އިރެއް؟' },
  'queue.yourToken': { en: 'Your token', dv: null },
  'queue.nowServing': { en: 'Now serving', dv: null },
  'queue.ahead': { en: 'ahead of you', dv: null },
  'queue.likelySeen': { en: 'Likely seen', dv: null },
  'queue.leaveNow': { en: 'Leave now', dv: null },
};

export function t(key, locale = 'en') {
  const entry = STRINGS[key];
  if (!entry) return key;
  return entry[locale] || entry.en || key;
}

export function pendingTranslations(locale = 'dv') {
  return Object.entries(STRINGS)
    .filter(([, v]) => !v[locale])
    .map(([k]) => k);
}

export function dir(locale) {
  return RTL.has(locale) ? 'rtl' : 'ltr';
}

export function strings(locale) {
  const out = {};
  for (const [k, v] of Object.entries(STRINGS)) out[k] = v[locale] || v.en;
  return { locale, dir: dir(locale), strings: out, pending: pendingTranslations(locale) };
}
