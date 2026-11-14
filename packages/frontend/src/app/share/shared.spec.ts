import { openedHere, parseShare, shareKey, shareNoteText, webLink } from './shared';

describe('parseShare', () => {
  it('takes a page Chrome shared: its title, and its address in the text', () => {
    expect(
      parseShare({ title: ' Hasselback gratin ', text: 'https://recipes.test/gratin', url: '' }),
    ).toEqual({
      title: 'Hasselback gratin',
      words: '',
      link: 'https://recipes.test/gratin',
      key: shareKey({ title: ' Hasselback gratin ', text: 'https://recipes.test/gratin', url: '' }),
    });
  });

  it('takes the link out of selected text when it rides along at the end', () => {
    const shared = parseShare({
      title: 'Gratin',
      text: '"Slice the potatoes thinly.\nBake until golden."\nhttps://recipes.test/gratin',
    });
    expect(shared).toMatchObject({
      words: 'Slice the potatoes thinly.\nBake until golden.',
      link: 'https://recipes.test/gratin',
    });
  });

  it('finds a link inside free text, and leaves the words as they were', () => {
    expect(
      parseShare({ text: 'look at https://seeds.test/talk, it is about seeds talking' }),
    ).toMatchObject({
      title: '',
      words: 'look at https://seeds.test/talk, it is about seeds talking',
      link: 'https://seeds.test/talk',
    });
    // A trailing full stop or bracket is the sentence's, not the link's.
    expect(parseShare({ text: 'Read (https://a.test/x).' })?.link).toBe('https://a.test/x');
    expect(parseShare({ text: 'https://en.test/wiki/Moss_(plant)' })?.link).toBe(
      'https://en.test/wiki/Moss_(plant)',
    );
  });

  it('prefers the url field, and says an address once', () => {
    expect(
      parseShare({ title: 'Seeds', text: 'https://seeds.test/', url: 'https://seeds.test' }),
    ).toMatchObject({ title: 'Seeds', words: '', link: 'https://seeds.test' });
    // Another link in the text stays in the words.
    expect(
      parseShare({ text: 'see https://other.test too', url: 'https://seeds.test' }),
    ).toMatchObject({ words: 'see https://other.test too', link: 'https://seeds.test' });
  });

  it('takes a title alone, and text alone', () => {
    expect(parseShare({ title: 'A thought' })).toMatchObject({
      title: 'A thought',
      words: '',
      link: '',
    });
    expect(parseShare({ text: '  what if seeds could talk\r\n ' })).toMatchObject({
      title: '',
      words: 'what if seeds could talk',
      link: '',
    });
  });

  it('brings nothing for an empty share, and drops a title that only repeats the link', () => {
    expect(parseShare({})).toBeUndefined();
    expect(parseShare({ title: ' ', text: '\n', url: ' ' })).toBeUndefined();
    expect(parseShare({ url: 'javascript:alert(1)' })).toBeUndefined();
    expect(parseShare({ title: 'https://seeds.test/', text: 'https://seeds.test/' })?.title).toBe(
      '',
    );
  });

  it('keeps very long text whole, finding the link after it', () => {
    const words = 'Slice the potatoes. '.repeat(50_000).trim();
    const shared = parseShare({ text: `${words}\nhttps://recipes.test/gratin` })!;
    expect(shared.words).toBe(words);
    expect(shared.words.length).toBeGreaterThan(900_000);
    expect(shared.link).toBe('https://recipes.test/gratin');
  });
});

describe('shareKey', () => {
  it('is the moment sw.js took the share, else its fields', () => {
    expect(shareKey({ text: 'a', at: '1700000000000' })).toBe('at:1700000000000');
    expect(shareKey({ text: 'a', at: 'soon' })).toBe(shareKey({ text: 'a' }));
    expect(shareKey({ text: 'a' })).not.toBe(shareKey({ text: 'b' }));
  });
});

describe('shareNoteText', () => {
  it('is the title, the words and the link, each once', () => {
    expect(shareNoteText({ title: 'Seeds', words: 'what if', link: 'https://x.test' })).toBe(
      'Seeds\nwhat if\nhttps://x.test',
    );
    expect(
      shareNoteText({
        title: 'Seeds',
        words: 'Seeds that talk https://x.test',
        link: 'https://x.test',
      }),
    ).toBe('Seeds that talk https://x.test');
    expect(shareNoteText({ title: '', words: '', link: 'https://x.test' })).toBe('https://x.test');
  });
});

describe('webLink and openedHere', () => {
  it('takes http and https links only', () => {
    expect(webLink(' https://x.test/a ')).toBe('https://x.test/a');
    expect(webLink('ftp://x.test')).toBe('');
    expect(webLink('not a link')).toBe('');
  });

  it('trusts the share sheet and this app, not another site', () => {
    expect(openedHere('', 'https://notes.test')).toBe(true);
    expect(openedHere('android-app://com.android.chrome/', 'https://notes.test')).toBe(true);
    expect(openedHere('https://notes.test/home', 'https://notes.test')).toBe(true);
    expect(openedHere('https://evil.test/', 'https://notes.test')).toBe(false);
  });
});
