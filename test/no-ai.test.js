import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Running this tool must cost nothing on anyone's AI account. It is plain
 * Node: no model calls, no AI SDK, no inference of any kind. These tests
 * fail if that ever stops being true, whether by a dependency creeping in
 * or by a call being added to a hosted model.
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
