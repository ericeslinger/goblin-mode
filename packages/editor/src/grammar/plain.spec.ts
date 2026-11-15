import { describe, expect, it } from 'vitest';
import { plainText } from './plain';

describe('plainText', () => {
  it('gives wiki links as their name, or their label', () => {
    expect(plainText('Dinner: [[Pork chops]] tonight')).toBe('Dinner: Pork chops tonight');
    expect(plainText('Ask [[Vikas Rao|Vikas]] first')).toBe('Ask Vikas first');
    expect(plainText('[[Fish of the week]]')).toBe('Fish of the week');
    expect(plainText('[[Dal]] (half recipe)')).toBe('Dal (half recipe)');
  });

  it('gives links as their text, and a bare address as it is', () => {
    expect(plainText('See [the kiln guide](https://example.com/kiln) now')).toBe(
      'See the kiln guide now',
    );
    expect(plainText('Read https://example.com/a-long-page today')).toBe(
      'Read https://example.com/a-long-page today',
    );
    expect(plainText('<https://example.com/x>')).toBe('https://example.com/x');
    expect(plainText('[](https://example.com/nothing-to-say)')).toBe('');
  });

  it('gives images as their alt text, never their address', () => {
    expect(plainText('![A blue bowl](https://example.com/bowl.jpg)')).toBe('A blue bowl');
    expect(plainText('![The kiln](attachment:abc123)')).toBe('The kiln');
    const long = `![](https://example.com/${'a'.repeat(300)}.jpg)`;
    expect(plainText(long)).toBe('');
    expect(plainText(`${long} Lovely glaze`)).toBe('Lovely glaze');
    expect(plainText(`[![Photo](https://example.com/p.jpg)](https://example.com/)`)).toBe('Photo');
  });

  it('drops emphasis in this dialect: *bold*, _italic_, **bold**, ~~struck~~', () => {
    expect(plainText('a *bold* b')).toBe('a bold b');
    expect(plainText('a _italic_ b')).toBe('a italic b');
    expect(plainText('a **bold** and __bold__ b')).toBe('a bold and bold b');
    expect(plainText('*bold _and italic_*')).toBe('bold and italic');
    expect(plainText('~~gone~~ kept')).toBe('gone kept');
  });

  it('leaves snake_case, arithmetic and a lone star alone', () => {
    expect(plainText('rename snake_case_word now')).toBe('rename snake_case_word now');
    expect(plainText('2 * 3 * 4 = 24')).toBe('2 * 3 * 4 = 24');
    expect(plainText('rated 5* by Sam')).toBe('rated 5* by Sam');
    expect(plainText('a * b')).toBe('a * b');
    expect(plainText('open file_name.txt')).toBe('open file_name.txt');
  });

  it('drops code ticks but keeps what is in them', () => {
    expect(plainText('run `npm test` first')).toBe('run npm test first');
    expect(plainText('`*not bold*`')).toBe('*not bold*');
    expect(plainText('```\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('drops heading, quote, list and checkbox markers', () => {
    expect(plainText('## Heading')).toBe('Heading');
    expect(plainText('# Groceries\n- [ ] eggs\n- [x] milk\n* bread\n+ jam')).toBe(
      'Groceries\neggs\nmilk\nbread\njam',
    );
    expect(plainText('1. one\n2) two')).toBe('one\ntwo');
    expect(plainText('> quoted *words*')).toBe('quoted words');
    expect(plainText('- [ ] eggs for [[Vikas]]')).toBe('eggs for Vikas');
    expect(plainText('- Monday\n  - nested')).toBe('Monday\nnested');
  });

  it('keeps a #tag and plain words as typed', () => {
    expect(plainText('#pottery glaze day')).toBe('#pottery glaze day');
    expect(plainText('Just words, nothing more.')).toBe('Just words, nothing more.');
    expect(plainText('Fish & chips')).toBe('Fish & chips');
  });

  it('gives a line per line, leaving out empty ones and rules', () => {
    expect(plainText('one\ntwo\n\n---\n\nthree')).toBe('one\ntwo\nthree');
    expect(plainText('')).toBe('');
    expect(plainText('  \n \n')).toBe('');
    // A lone bullet being typed (#118) has no words.
    expect(plainText('- Monday\n-')).toBe('Monday');
  });

  it('drops raw HTML, keeps table cells as words', () => {
    expect(plainText('a <b>b</b> c')).toBe('a b c');
    expect(plainText('| Day | Dish |\n| --- | --- |\n| Mon | [[Dal]] |')).toBe('Day Dish\nMon Dal');
  });

  it('keeps escaped marks as the characters they are', () => {
    expect(plainText('\\*not bold\\*')).toBe('*not bold*');
  });
  it('leaves addresses alone and survives marks left open', () => {
    expect(plainText('see https://example.com/a_b_c/d_e for more')).toBe(
      'see https://example.com/a_b_c/d_e for more',
    );
    expect(plainText('mail eric_e@example.com now')).toBe('mail eric_e@example.com now');
    expect(plainText('[[a_b_c]] here')).toBe('a_b_c here');
    expect(plainText('open [[link and words')).toBe('open [[link and words');
    expect(plainText('a *star left open')).toBe('a *star left open');
  });
});
