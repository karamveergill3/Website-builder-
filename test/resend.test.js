import test from 'node:test';
import assert from 'node:assert/strict';

const { teardown } = await import('./helpers.js');

test.after(teardown);

/* ---- Stub fetch for Resend API ---- */

const realFetch = globalThis.fetch;
let lastReq = null;
let nextResponse = null;

function stubResend(status = 200, body = { id: 'msg-1' }) {
  nextResponse = { status, body };
  lastReq = null;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('api.resend.com')) {
      lastReq = { url: String(url), ...opts, parsed: JSON.parse(opts.body) };
      const r = nextResponse;
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

/* ---- Tests ---- */

test('configured() reflects RESEND_API_KEY', async () => {
  const orig = process.env.RESEND_API_KEY;
  try {
    delete process.env.RESEND_API_KEY;
    // Re-import to get fresh module evaluation isn't needed: configured()
    // reads process.env at call time.
    const { configured } = await import('../server/lib/resend.js');
    assert.equal(configured(), false);

    process.env.RESEND_API_KEY = 're_test_123';
    assert.equal(configured(), true);

    process.env.RESEND_API_KEY = '   ';
    assert.equal(configured(), false);
  } finally {
    if (orig !== undefined) process.env.RESEND_API_KEY = orig;
    else delete process.env.RESEND_API_KEY;
  }
});

test('sendEmail calls the Resend API with correct payload', async () => {
  process.env.RESEND_API_KEY = 're_test_key';
  stubResend(200, { id: 'resend-msg-1' });
  try {
    const { sendEmail } = await import('../server/lib/resend.js');
    const result = await sendEmail({
      from: 'Karam Gill <karam@keylostudios.com>',
      to: 'lead@example.co.uk',
      subject: 'We build websites',
      text: 'Hello, this is a test.',
      replyTo: 'karam@keylostudios.com',
    });

    assert.equal(result.id, 'resend-msg-1');
    assert.ok(lastReq);
    assert.equal(lastReq.parsed.from, 'Karam Gill <karam@keylostudios.com>');
    assert.deepEqual(lastReq.parsed.to, ['lead@example.co.uk']);
    assert.equal(lastReq.parsed.subject, 'We build websites');
    assert.equal(lastReq.parsed.text, 'Hello, this is a test.');
    assert.deepEqual(lastReq.parsed.reply_to, ['karam@keylostudios.com']);
    assert.ok(lastReq.url.includes('api.resend.com/emails'));
    assert.ok(lastReq.headers.Authorization.includes('re_test_key'));
  } finally {
    restoreFetch();
    delete process.env.RESEND_API_KEY;
  }
});

test('sendEmail throws ResendError on auth failure', async () => {
  process.env.RESEND_API_KEY = 're_bad_key';
  stubResend(403, { message: 'Invalid API key' });
  try {
    const { sendEmail, ResendError } = await import('../server/lib/resend.js');
    await assert.rejects(
      () => sendEmail({ from: 'a@b.com', to: 'c@d.com', subject: 'x', text: 'y' }),
      (err) => {
        assert.ok(err instanceof ResendError);
        assert.equal(err.code, 'AUTH_ERROR');
        return true;
      },
    );
  } finally {
    restoreFetch();
    delete process.env.RESEND_API_KEY;
  }
});

test('sendEmail throws ResendError on rate limit', async () => {
  process.env.RESEND_API_KEY = 're_test_key';
  stubResend(429, { message: 'Too many requests' });
  try {
    const { sendEmail, ResendError } = await import('../server/lib/resend.js');
    await assert.rejects(
      () => sendEmail({ from: 'a@b.com', to: 'c@d.com', subject: 'x', text: 'y' }),
      (err) => {
        assert.ok(err instanceof ResendError);
        assert.equal(err.code, 'RATE_LIMITED');
        assert.equal(err.retryable, true);
        return true;
      },
    );
  } finally {
    restoreFetch();
    delete process.env.RESEND_API_KEY;
  }
});

test('sendEmail throws when no API key set', async () => {
  const orig = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const { sendEmail, ResendError } = await import('../server/lib/resend.js');
    await assert.rejects(
      () => sendEmail({ from: 'a@b.com', to: 'c@d.com', subject: 'x', text: 'y' }),
      (err) => {
        assert.ok(err instanceof ResendError);
        assert.equal(err.code, 'NOT_CONFIGURED');
        return true;
      },
    );
  } finally {
    if (orig !== undefined) process.env.RESEND_API_KEY = orig;
  }
});

test('sendEmail omits reply_to when not provided', async () => {
  process.env.RESEND_API_KEY = 're_test_key';
  stubResend(200, { id: 'msg-2' });
  try {
    const { sendEmail } = await import('../server/lib/resend.js');
    await sendEmail({ from: 'a@b.com', to: 'c@d.com', subject: 'hi', text: 'body' });
    assert.equal(lastReq.parsed.reply_to, undefined);
  } finally {
    restoreFetch();
    delete process.env.RESEND_API_KEY;
  }
});
