import { describe, expect, it } from 'vitest';
import { Note, SEND_ASK_MAX, SEND_OUTCOME_MAX } from './model';
import { aadFor, newDataKey, openText, sealText } from './sealed';
import {
  PLAIN_FORMS,
  SEALED_FORMS,
  anySealed,
  fieldValue,
  formsFound,
  withFieldValue,
  writtenForms,
} from './sealed-note';

const key = newDataKey();
const seal = (field: Parameters<typeof aadFor>[2], text: string) =>
  sealText(key, aadFor('uid-1', 'note-1', field), text);

describe('fieldValue and withFieldValue', () => {
  it('read and write the nested source text, keeping the rest of the map', () => {
    const doc = { source: { url: 'https://example.com', text: 'the page' } };
    expect(fieldValue(doc, 'source.text')).toBe('the page');
    const next = withFieldValue(doc, 'source.text', 'other');
    expect(next).toEqual({ source: { url: 'https://example.com', text: 'other' } });
    expect(doc.source.text).toBe('the page');
    expect(withFieldValue(doc, 'source.text', undefined)).toEqual({
      source: { url: 'https://example.com' },
    });
  });

  it('read a dotted source.text key in an update', () => {
    expect(fieldValue({ 'source.text': 'x' }, 'source.text')).toBe('x');
    expect(withFieldValue({ 'source.text': 'x' }, 'source.text', 'y')).toEqual({
      'source.text': 'y',
    });
  });

  it('read a list as its strings, and anything not text as absent', () => {
    expect(fieldValue({ synonyms: ['a', 3, 'b'] }, 'synonyms')).toEqual(['a', 'b']);
    expect(fieldValue({ synonyms: 'a' }, 'synonyms')).toBeUndefined();
    expect(fieldValue({ instructions: { delete: true } }, 'instructions')).toBeUndefined();
    expect(fieldValue(undefined, 'body')).toBeUndefined();
  });
});

describe('formsFound', () => {
  it('reads each field off its stored value, a list sealed when any element is', () => {
    const forms = formsFound({
      body: 'plain',
      title: seal('title', 'T'),
      synonyms: ['plain', seal('synonyms', 'S')],
      source: { url: 'u', text: seal('source.text', 'page') },
    });
    expect(forms.title).toBe('sealed');
    expect(forms.synonyms).toBe('sealed');
    expect(forms['source.text']).toBe('sealed');
    expect(forms.body).toBe('plain');
    expect(forms.instructions).toBe('plain');
    expect(anySealed(forms)).toBe(true);
    expect(anySealed(formsFound({ body: 'x', synonyms: ['y'] }))).toBe(false);
  });
});

describe('writtenForms', () => {
  it('keeps the form each field was found in', () => {
    expect(writtenForms(PLAIN_FORMS)).toEqual(PLAIN_FORMS);
    const found = { ...PLAIN_FORMS, instructions: 'sealed' as const };
    expect(writtenForms(found)).toEqual(found);
  });

  it('makes no field plainer than a sealed body', () => {
    expect(writtenForms({ ...PLAIN_FORMS, body: 'sealed' })).toEqual(SEALED_FORMS);
  });

  it('makes the other names no plainer than a sealed title, which a rename keeps among them', () => {
    const out = writtenForms({ ...PLAIN_FORMS, title: 'sealed' });
    expect(out.synonyms).toBe('sealed');
    expect(out.body).toBe('plain');
    expect(out.instructions).toBe('plain');
  });
});

describe('a sealed note against the stored schema (2026-11-13)', () => {
  it('parses with a sealed ask and outcome of the longest plain text allowed', () => {
    // Three bytes a character, the longest a sealed value of that length gets.
    const ask = 'あ'.repeat(SEND_ASK_MAX);
    const outcome = 'お'.repeat(SEND_OUTCOME_MAX);
    const sealedAsk = seal('sendAsk', ask);
    const sealedOutcome = seal('sendOutcome', outcome);
    expect(sealedAsk.length).toBeGreaterThan(SEND_ASK_MAX);
    expect(sealedOutcome.length).toBeGreaterThan(SEND_OUTCOME_MAX);
    const note = Note.parse({
      kind: 'concept',
      body: seal('body', 'text'),
      title: seal('title', 'Moss'),
      titleSource: 'user',
      synonyms: [seal('synonyms', 'Mossy')],
      instructions: seal('instructions', 'Keep it short.'),
      source: { url: 'https://example.com', text: seal('source.text', 'the page') },
      importError: seal('importError', 'no recipe there'),
      sendState: 'done',
      sendAsk: sealedAsk,
      sendOutcome: sealedOutcome,
      links: [],
      tags: [],
      archived: false,
      createdAt: { seconds: 0, nanoseconds: 0 },
      updatedAt: { seconds: 0, nanoseconds: 0 },
      updatedBy: 'user',
      deviceId: 'd',
    });
    expect(openText(key, aadFor('uid-1', 'note-1', 'sendAsk'), note.sendAsk!)).toBe(ask);
    expect(openText(key, aadFor('uid-1', 'note-1', 'sendOutcome'), note.sendOutcome!)).toBe(
      outcome,
    );
  });
  it('still holds a plain ask and outcome to their limits (review on #266)', () => {
    const base = {
      kind: 'text',
      body: 'text',
      title: 'A note',
      titleSource: 'words',
      links: [],
      tags: [],
      archived: false,
      createdAt: { seconds: 0, nanoseconds: 0 },
      updatedAt: { seconds: 0, nanoseconds: 0 },
      updatedBy: 'user',
      deviceId: 'd',
    };
    const at = { sendAsk: 'a'.repeat(SEND_ASK_MAX), sendOutcome: 'o'.repeat(SEND_OUTCOME_MAX) };
    expect(Note.safeParse({ ...base, ...at }).success).toBe(true);
    expect(Note.safeParse({ ...base, sendAsk: `${at.sendAsk}a` }).success).toBe(false);
    expect(Note.safeParse({ ...base, sendOutcome: `${at.sendOutcome}o` }).success).toBe(false);
  });
});
