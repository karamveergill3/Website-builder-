/**
 * The five questions sent once a prospect says yes to a mock up.
 *
 * Edited on the Ask screen (public/js/views/phase2.js), which ships the same
 * defaults and saves over them in settings.phase2_questions_json. The server
 * needs them too, to draft the "yes please" reply and to ask again for
 * anything a prospect left out. test/reply-draft.test.js checks the two
 * copies of the defaults still agree.
 */
import { getSetting } from '../db.js';

export const ASK_DEFAULTS = {
  intro: 'Just 5 quick bits and I\'ll get one sorted:',
  questions: [
    { q: 'What name should go on the site?' },
    { q: 'What\'s the main thing you want visitors to do? Call you, book, get a quote, see prices, or see your work?' },
    { q: 'What areas do you cover?' },
    { q: 'Got a logo? And any photos of past work?' },
    { q: 'Any brand colours you like?' },
  ],
  outro: 'No stress if you can\'t answer them all. Even one or two gives me enough.',
};

/** The questions as saved on the Ask screen, or the shipped ones. */
export function askQuestions() {
  let stored = null;
  try { stored = JSON.parse(getSetting('phase2_questions_json', 'null')); } catch { /* bad JSON: defaults */ }
  const questions = Array.isArray(stored?.questions) && stored.questions.length
    ? stored.questions.map((row, i) => ({ q: String(row?.q ?? ASK_DEFAULTS.questions[i]?.q ?? '').trim() }))
      .filter((row) => row.q)
    : ASK_DEFAULTS.questions;
  return {
    intro: String(stored?.intro ?? ASK_DEFAULTS.intro).trim(),
    questions,
    outro: String(stored?.outro ?? ASK_DEFAULTS.outro).trim(),
  };
}

/**
 * Which brief field each question fills, read from the wording so a question
 * reworded on the Ask screen still lines up.
 */
export function fieldOf(question) {
  const q = String(question ?? '').toLowerCase();
  if (/\bname\b/.test(q)) return 'trading_name';
  if (/\bcolou?rs?\b/.test(q)) return 'brand_colours';
  if (/\blogo\b|\bphotos?\b|\bpictures\b/.test(q)) return 'assets';
  if (/\bareas?\b|\bcover\b/.test(q)) return 'areas';
  if (/\bvisitors?\b|\bcall you\b|\bbook\b|\bquote\b/.test(q)) return 'primary_cta';
  if (/\bservices?\b|\bwhat do you do\b/.test(q)) return 'services';
  return null;
}
