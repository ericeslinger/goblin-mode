import { describe, expect, it } from 'vitest';
import { attachmentIds, tasks, wikiLinkTargets } from './extract';
import { parseNote } from './parse';

describe('wikiLinkTargets', () => {
  it('lists each target once, in order', () => {
    const root = parseNote('[[B]] then [[A|alias]] then [[B]]');
    expect(wikiLinkTargets(root)).toEqual(['B', 'A']);
  });
});

describe('tasks', () => {
  it('finds open and done GFM tasks with their lines', () => {
    const root = parseNote('# Today\n\n- [ ] buy a card\n- [x] call mum\n- plain item');
    expect(tasks(root)).toEqual([
      { text: 'buy a card', done: false, line: 3 },
      { text: 'call mum', done: true, line: 4 },
    ]);
  });
});

describe('attachmentIds', () => {
  it('collects attachment: images only', () => {
    const root = parseNote('![page 1](attachment:abc) ![web](https://x.test/a.png)');
    expect(attachmentIds(root)).toEqual(['abc']);
  });
});
