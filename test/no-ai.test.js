/* These tests save and restore process.env around awaits on purpose — that
 * is how a host allow-list gets exercised. The rule cannot tell the
 * difference between that and a real race. */
/* eslint-disable require-atomic-updates */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Running this tool must cost nothing on anyone's AI account.
 *
 * The promise is about BILLING and PRIVACY, not about the abstract presence
 * of a language model. Since the reply extractor gained an optional local
 * model, the rule is stated precisely:
 *
 *   - no AI npm dependency, ever
 *   - no call to any hosted model provider, ever
 *   - inference is permitted ONLY against a loopback address, where it runs
 *     on the user's own hardware: no key, no account, no bill, and no
 *     prospect data leaving the machine
 *
 * These tests fail if any of that stops being true.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'data') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (['.js', '.mjs', '.cjs', '.html', '.json'].includes(extname(name))
             && name !== 'package-lock.json') out.push(full);
  }
  return out;
}

const FILES = sourceFiles(ROOT);

test('no AI or model-provider dependency is declared', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

  const banned = /anthropic|openai|@ai-sdk|langchain|llamaindex|cohere|mistral|replicate|huggingface|ollama|transformers|onnxruntime|tensorflow/i;
  const offenders = deps.filter((d) => banned.test(d));
  assert.deepEqual(offenders, [], `AI dependency introduced: ${offenders.join(', ')}`);

  // The whole runtime surface, so an addition is a deliberate decision.
  assert.deepEqual(
    Object.keys(pkg.dependencies).sort(),
    ['better-sqlite3', 'dotenv', 'express'],
    'runtime dependencies changed — check the addition is not an AI client'
  );
});

test('no source file reaches a model provider', () => {
  const banned = [
    /api\.anthropic\.com/i, /api\.openai\.com/i, /generativelanguage\.googleapis\.com/i,
    /api\.cohere\.ai/i, /api\.mistral\.ai/i, /api\.replicate\.com/i,
    /api-inference\.huggingface\.co/i, /bedrock[a-z-]*\.amazonaws\.com/i,
    /openai\.azure\.com/i, /\/v1\/chat\/completions/i, /\/v1\/messages\b/i,
  ];

  const hits = [];
  for (const file of FILES) {
    // Test files name providers deliberately, as the values that must be
    // refused. Scanning them would fail on their own fixtures.
    if (file.includes('/test/')) continue;
    const text = readFileSync(file, 'utf8');
    for (const re of banned) {
      if (re.test(text)) hits.push(`${file.replace(ROOT, '.')} matches ${re}`);
    }
  }
  assert.deepEqual(hits, [], `model-provider call introduced:\n${hits.join('\n')}`);
});

test('every outbound host is one of the services this tool uses', () => {
  // Companies House, Google Places, Gmail/OAuth, the webfont CDN, DuckDuckGo
  // (for free contact discovery), plus the deep-link handoff domains for
  // WhatsApp. Anything else is a new external dependency and should be a
  // deliberate choice.
  const ALLOWED = new Set([
    'api.company-information.service.gov.uk',
    'find-and-update.company-information.service.gov.uk',
    'resources.companieshouse.gov.uk',
    'places.googleapis.com',
    'gmail.googleapis.com',
    'www.googleapis.com',
    'accounts.google.com',
    'oauth2.googleapis.com',
    'openidconnect.googleapis.com',
    'developers.google.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'duckduckgo.com',
    // Free contact-discovery: DuckDuckGo HTML search. No key, no cost.
    'html.duckduckgo.com',
    // Contact-finder result targets: public pages we may fetch and parse
    // when the search returns them; and the WhatsApp deep-link domain we
    // build wa.me/{E164} links against. wa.me links open on the user's
    // phone, they are not called by the server.
    'wa.me',
    'facebook.com',
    'faq.whatsapp.com',
    // Appears only in the install instructions inside a comment. The tool
    // never calls it: Ollama is reached at 127.0.0.1, enforced below.
    'ollama.com',
    // Invoicing / payments. paypal.me is the pay-link format shown to a
    // client on an invoice; the api-m hosts are PayPal's REST API used by
    // automated PayPal Checkout (Phase B). Cloudflare's cloudflared is how
    // the team hub is reached from anywhere (a quick tunnel), not called by
    // the server.
    'paypal.me', 'www.paypal.com', 'api-m.paypal.com', 'api-m.sandbox.paypal.com',
    // Stripe's REST API, used by automated Stripe Checkout (card / Klarna /
    // Clearpay). One host for both test and live — the key prefix decides which.
    'api.stripe.com',
  ]);

  const found = new Set();
  for (const file of FILES) {
    if (file.includes('/test/')) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/https:\/\/([a-z0-9.-]+)/gi)) {
      found.add(m[1].toLowerCase());
    }
  }

  const unexpected = [...found].filter((h) => !ALLOWED.has(h));
  assert.deepEqual(unexpected, [], `new outbound host(s): ${unexpected.join(', ')}`);
});

/* ------------------------------------------------ local inference only */

test('the only inference endpoint in the tree is loopback', () => {
  // Ollama's base URL is built from OLLAMA_HOST. Any literal model endpoint
  // in the source must point at the local machine — never a hosted one.
  const offenders = [];
  for (const file of FILES) {
    if (file.includes('/test/')) continue;
    const text = readFileSync(file, 'utf8');
    // Any /api/generate or /api/chat call must sit behind a loopback base.
    // Only actual inference paths — `/v1/` alone also matches Google's
    // OAuth userinfo endpoint, which has nothing to do with a model.
    const INFERENCE_PATH = /https?:\/\/([a-z0-9.[\]:-]+)\/(?:api\/(?:generate|chat|embeddings)|v1\/(?:chat\/completions|completions|messages|embeddings))/gi;
    for (const m of text.matchAll(INFERENCE_PATH)) {
      const host = m[1].toLowerCase();
      const loopback = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$/.test(host);
      if (!loopback) offenders.push(`${file.replace(ROOT, '.')} -> ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `non-loopback inference endpoint:\n${offenders.join('\n')}`);
});

test('the ollama client refuses a non-loopback host at runtime', async () => {
  const { baseUrl, available } = await import('../server/lib/ollama.js');

  const original = process.env.OLLAMA_HOST;
  try {
    for (const bad of ['api.openai.com', 'https://api.anthropic.com', '10.0.0.5:11434',
                       'evil.example.com:11434']) {
      process.env.OLLAMA_HOST = bad;
      assert.throws(() => baseUrl(), /loopback/i, `${bad} should be refused`);
      // The probe must report it as a misconfiguration, not silently fall back.
      const probe = await available({ force: true });
      assert.equal(probe.ok, false, bad);
      assert.equal(probe.misconfigured, true, bad);
    }

    for (const good of ['127.0.0.1:11434', 'localhost:11434', '127.0.0.1']) {
      process.env.OLLAMA_HOST = good;
      assert.doesNotThrow(() => baseUrl(), `${good} should be allowed`);
    }
  } finally {
    if (original === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = original;
  }
});

test('a reply still extracts with no model available at all', async () => {
  // The rules pass is what runs on a machine with no Ollama. If this ever
  // starts depending on the model, the tool breaks for everyone who has not
  // installed one.
  const original = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = '127.0.0.1:1';   // nothing listens here
  try {
    const { buildBrief } = await import('../server/lib/brief.js');
    const brief = await buildBrief(
      '1. Test Roofing\n2. Roofing and guttering\n3. No logo\n4. People ringing us',
      { business_name: 'Test Ltd', location: 'Leeds' }
    );
    assert.equal(brief.trading_name, 'Test Roofing');
    assert.deepEqual(brief.services, ['Roofing', 'Guttering']);
    assert.equal(brief.primary_cta, 'call');
    assert.equal(brief.source, 'rules');
  } finally {
    if (original === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = original;
  }
});
