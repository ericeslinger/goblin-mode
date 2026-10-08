import { describe, expect, it } from 'vitest';
import { driveFile, driveFiles } from './drive';
import { parseNote } from './parse';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

describe('driveFile', () => {
  it('reads the file id from Drive and Docs links', () => {
    expect(driveFile(`https://docs.google.com/document/d/${ID}/edit?tab=t.0`)).toEqual({
      id: ID,
      kind: 'Google Doc',
      url: `https://docs.google.com/document/d/${ID}/edit?tab=t.0`,
    });
    expect(driveFile(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)?.kind).toBe(
      'Google Sheet',
    );
    expect(driveFile(`https://drive.google.com/file/d/${ID}/view?usp=sharing`)?.id).toBe(ID);
    expect(driveFile(`https://drive.google.com/open?id=${ID}`)?.id).toBe(ID);
    expect(driveFile(`https://drive.google.com/drive/u/0/folders/${ID}`)).toMatchObject({
      id: ID,
      kind: 'Drive folder',
    });
  });

  it('leaves other links alone', () => {
    expect(driveFile('https://example.com/document/d/123')).toBeUndefined();
    expect(driveFile(`http://docs.google.com/document/d/${ID}`)).toBeUndefined();
    expect(driveFile('https://docs.google.com/document/d/x')).toBeUndefined();
    expect(driveFile('not a url')).toBeUndefined();
  });
});

describe('driveFiles', () => {
  it('lists each Drive file a note links to once, bare or named', () => {
    const body = [
      `Plan: https://docs.google.com/document/d/${ID}/edit`,
      `[the plan](https://docs.google.com/document/d/${ID}/edit) and https://example.com`,
      `[budget](https://docs.google.com/spreadsheets/d/${ID}x/edit)`,
    ].join('\n');
    expect(driveFiles(parseNote(body)).map((f) => [f.id, f.kind])).toEqual([
      [ID, 'Google Doc'],
      [`${ID}x`, 'Google Sheet'],
    ]);
  });
});
