// 0.5.4 SF (item 11, review P1 R2-1): a pane id is canonical. tmux looks a `%` target up by NUMBER, so `%050` may name pane 50 while nika compares ids as text.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PANE_ID } from '../src/ids.js';

describe('0.5.4 SF (item 11): PANE_ID is canonical', () => {
  test('(+) the ids tmux prints still pass: %0, %5, %50, %123456, %999999', () => {
    for (const id of ['%0', '%5', '%9', '%10', '%50', '%123456', '%999999']) assert.match(id, PANE_ID, id);
  });

  test('(\u2212) a leading zero is refused: %050, %00, %0123, %01 (an alias of another pane for tmux, a different string for nika)', () => {
    for (const id of ['%050', '%00', '%0123', '%01', '%000', '%0999999']) assert.doesNotMatch(id, PANE_ID, id);
  });

  test('(\u2212) the other shapes stay refused: too long, empty number, signs, spaces, newlines, another sigil', () => {
    for (const id of ['%1000000', '%', '', '5', '%-1', '%+1', '% 5', '%5 ', ' %5', '%5\n', '%5\u0000', '%x', '%1;%2', '$5', '@5', '%5.0', '%%5']) assert.doesNotMatch(id, PANE_ID, JSON.stringify(id));
  });

  test('(+) the shape is the canonical one the review named, and it is anchored', () => {
    assert.equal(PANE_ID.source, '^%(?:0|[1-9]' + String.raw`\d` + '{0,5})$');
  });
});
