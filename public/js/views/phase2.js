/* Phase 2: what to send once a prospect has said "yes, send a mockup".
 *
 * The five questions live here — editable, copy-to-clipboard, with a note
 * against each one so a rep hitting this screen on a phone knows exactly
 * what each answer changes about the mockup. Stored as one JSON blob in
 * settings.phase2_questions_json so a change to the wording travels with
 * the studio, not with one browser.
 */
import { api } from '../api.js';
import { html, mount, $, toast } from '../dom.js';

/**
 * The default question set — the one two rounds of thinking landed on for a
 * UK sole trader. Ordered by what a numbered reply extracts most cleanly:
 * name first (it becomes the title), then the layout-deciding CTA, then
 * facts about their business, then assets, then colours.
 */
const DEFAULTS = {
  intro: `Just 5 quick bits and I'll get one sorted:`,
  questions: [
    {
      q: 'What name should go on the site?',
      note: 'The masthead. "Hillside Roofing" reads warmer than "HILLSIDE ROOFING LIMITED".',
    },
    {
      q: `What's the main thing you want visitors to do? Call you, book, get a quote, see prices, or see your work?`,
      note: 'Decides the whole layout. Hero, main button, what the site is arranged around.',
    },
    {
      q: 'What areas do you cover?',
      note: 'The service area section, local SEO, page templates.',
    },
    {
      q: 'Got a logo? And any photos of past work?',
      note: 'Real logo vs generated wordmark. Real photos vs trade-styled placeholders.',
    },
    {
      q: 'Any brand colours you like?',
      note: 'Palette. Falls back to sector defaults if they say none.',
    },
  ],
  outro: `No stress if you can't answer them all. Even one or two gives me enough.`,
};

/** Fold the intro, numbered questions and outro into one paste-ready block. */
function assemble(state) {
  const numbered = state.questions.map((row, i) => `${i + 1}. ${row.q}`).join('\n');
  const parts = [state.intro, '', numbered, '', state.outro].filter((s) => s !== undefined);
  return parts.join('\n').trim();
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* insecure context fallback */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

export default async function phase2View(root) {
  const settings = await api.settings.get();
  let stored = null;
  try { stored = JSON.parse(settings.settings.phase2_questions_json ?? 'null'); } catch { /* invalid JSON, use defaults */ }

  // Merge saved values over the defaults so an install that only saved the
  // outro still gets the shipped questions until it edits them.
  const state = {
    intro: (stored?.intro ?? DEFAULTS.intro),
    outro: (stored?.outro ?? DEFAULTS.outro),
    questions: (Array.isArray(stored?.questions) && stored.questions.length)
      ? stored.questions.map((row, i) => ({
          q: (row?.q ?? DEFAULTS.questions[i]?.q ?? '').toString(),
          note: (row?.note ?? DEFAULTS.questions[i]?.note ?? '').toString(),
        }))
      : structuredClone(DEFAULTS.questions),
  };

  mount(root, html`
    <div class="bar">
      <h2>Ask them</h2>
      <div class="grow"></div>
      <span class="meta">Once they've said yes to a mockup. Copy it into WhatsApp or email.</span>
    </div>

    <form id="phase2">
      <div class="cols">
        <div>
          <div class="panel">
            <div class="panel-hd"><h3>The message to send</h3>
              <div class="grow"></div>
              <button type="button" class="mini" data-act="copy">Copy</button>
            </div>
            <div class="panel-bd">
              <p class="tip" style="margin-top:0">
                What lands in the reply extractor. Numbered format is what makes it
                parse cleanly, so keep the numbers.
              </p>
              <div class="mail">
                <div class="mail-bd" id="preview"
                     style="max-height:none;white-space:pre-wrap;font-family:inherit"></div>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-hd"><h3>Intro line</h3></div>
            <div class="panel-bd">
              <div class="f">
                <label for="p2-intro">First line, before the numbered questions</label>
                <input id="p2-intro" name="intro" type="text" value="${state.intro}" autocomplete="off">
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-hd"><h3>Sign-off line</h3></div>
            <div class="panel-bd">
              <div class="f">
                <label for="p2-outro">Last line, after the numbered questions</label>
                <input id="p2-outro" name="outro" type="text" value="${state.outro}" autocomplete="off">
              </div>
            </div>
          </div>
        </div>

        <div>
          ${state.questions.map((row, i) => html`
            <div class="panel">
              <div class="panel-hd"><h3>Question ${i + 1}</h3></div>
              <div class="panel-bd">
                <div class="f">
                  <label for="p2-q-${i}">The question they see</label>
                  <input id="p2-q-${i}" data-kind="q" data-index="${i}"
                         type="text" value="${row.q}" autocomplete="off">
                </div>
                <div class="f">
                  <label for="p2-note-${i}">What their answer decides <span class="opt">only you see this</span></label>
                  <input id="p2-note-${i}" data-kind="note" data-index="${i}"
                         type="text" value="${row.note}" autocomplete="off">
                </div>
              </div>
            </div>`)}
        </div>
      </div>

      <div class="bar" style="margin-top:14px">
        <button type="submit" class="primary">Save</button>
        <button type="button" class="mini ghost" data-act="reset">Reset to defaults</button>
        <div class="grow"></div>
      </div>
    </form>

    <style>
      .cols > div { display: flex; flex-direction: column; gap: 14px; }
    </style>
  `);

  const form = $('#phase2', root);
  const preview = $('#preview', root);

  const readState = () => {
    const intro = form.querySelector('#p2-intro')?.value ?? '';
    const outro = form.querySelector('#p2-outro')?.value ?? '';
    const questions = state.questions.map((_, i) => ({
      q: form.querySelector(`#p2-q-${i}`)?.value ?? '',
      note: form.querySelector(`#p2-note-${i}`)?.value ?? '',
    }));
    return { intro, outro, questions };
  };

  const refresh = () => { preview.textContent = assemble(readState()); };
  refresh();
  form.addEventListener('input', refresh);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const next = readState();
      await api.settings.save({ phase2_questions_json: JSON.stringify(next) });
      Object.assign(state, next);
      toast('Saved');
    } catch (err) {
      toast(err.message ?? 'Save failed', { error: true });
    }
  });

  form.querySelector('[data-act="copy"]')?.addEventListener('click', async () => {
    const ok = await copy(assemble(readState()));
    toast(ok ? 'Copied. Paste it into WhatsApp or email' : 'Could not copy. Select the text instead',
      { error: !ok });
  });

  form.querySelector('[data-act="reset"]')?.addEventListener('click', () => {
    form.querySelector('#p2-intro').value = DEFAULTS.intro;
    form.querySelector('#p2-outro').value = DEFAULTS.outro;
    DEFAULTS.questions.forEach((row, i) => {
      const q = form.querySelector(`#p2-q-${i}`);
      const n = form.querySelector(`#p2-note-${i}`);
      if (q) q.value = row.q;
      if (n) n.value = row.note;
    });
    refresh();
    toast('Restored the shipped wording. Click Save to keep it.');
  });
}
