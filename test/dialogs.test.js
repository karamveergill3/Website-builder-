/**
 * Every dialog's handlers go when it closes.
 *
 * Dialogs attach their click handlers to the element modal() hands them. It
 * used to hand them the permanent #modal-root, so handlers piled up: after
 * one business was messaged from Reach, its handlers still ran on every later
 * dialog, and pressing Prepare on a brand new business also re-prepared the
 * one just messaged, showing "Already contacted by whatsapp" over the new
 * one. Read from the source, as the settings wiring checks are, since the
 * suite has no browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dom = readFileSync(new URL('../public/js/dom.js', import.meta.url), 'utf8');

test('a dialog is handed its own element, not the permanent #modal-root', () => {
  const modalFn = dom.slice(dom.indexOf('export function modal('), dom.indexOf('export function confirmDialog('));
  assert.ok(modalFn, 'modal() is where it was');
  assert.match(modalFn, /onMount\?\.\(backdrop, close\)/, 'onMount gets the dialog’s own element');
  assert.doesNotMatch(modalFn, /onMount\?\.\(root\b/, 'never the root that outlives it');
  assert.doesNotMatch(modalFn, /onSubmit\([^)]*,\s*root\)/, 'nor does onSubmit');
});
