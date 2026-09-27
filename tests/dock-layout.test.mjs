// Static layout invariants for the dock, learned from an on-device WebKit
// check (macOS 14.8): the `.body` column must be the *only* thing that
// scrolls, and cards must never be squeezed to fit — otherwise short windows
// (min 640px) and an expanded ENI card silently clip their content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/dock.css', import.meta.url), 'utf8');

/** Concatenate the declaration blocks of every rule whose selector line is exactly `selector`. */
function block(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`, 'g');
  const blocks = [...css.matchAll(re)].map((m) => m[1]);
  assert.ok(blocks.length, `rule "${selector}" not found in dock.css`);
  return blocks.join('\n');
}

test('.body is the scroll container (flex child that may shrink and scroll)', () => {
  const b = block('.body');
  assert.match(b, /overflow-y:\s*auto/);
  assert.match(b, /min-height:\s*0/);
  assert.match(b, /flex:\s*1/);
});

test('.card never shrinks inside the body column', () => {
  const c = block('.card');
  assert.match(c, /flex:\s*none/, '`.card` must declare `flex: none`');
});

test('body itself does not scroll (the dock owns the viewport)', () => {
  assert.match(block('body'), /overflow:\s*hidden/);
});
