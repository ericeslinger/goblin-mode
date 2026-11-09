import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { arrivalRunId, arrivalSkipOf, arrives } from './request';

// Garden on arrival (#214): which note writes are an arrival. The
// emulator spec (request.emulator.spec.ts) covers the rest.
const settled = Timestamp.fromMillis(Date.parse('2026-11-09T10:05:00Z'));
const note = { kind: 'text', body: 'Glaze notes', archived: false, updatedBy: 'user' };

describe('arrives', () => {
  it('is the first settle of a plain text note of the gardener’s', () => {
    expect(arrives('n1', note, { ...note, settledAt: settled })).toBe(true);
    expect(arrives('n1', undefined, { ...note, settledAt: settled })).toBe(true);
  });

  it('is not a later settle, an unsettled write, or a delete', () => {
    const later = Timestamp.fromMillis(settled.toMillis() + 60_000);
    expect(arrives('n1', { ...note, settledAt: settled }, { ...note, settledAt: later })).toBe(
      false,
    );
    expect(arrives('n1', note, { ...note, body: 'Glaze notes, more' })).toBe(false);
    expect(arrives('n1', { ...note, settledAt: settled }, undefined)).toBe(false);
  });

  it('is not a note of another kind, empty, archived, in Trash, an assistant’s, or sent', () => {
    const at = (over: Record<string, unknown>) =>
      arrives('n1', note, { ...note, ...over, settledAt: settled });
    for (const kind of ['template', 'recipe', 'concept', 'mealplan', 'pantry', 'clipping'])
      expect(at({ kind })).toBe(false);
    expect(arrives('context', note, { ...note, settledAt: settled })).toBe(false);
    expect(at({ body: ' \n ' })).toBe(false);
    expect(at({ archived: true })).toBe(false);
    expect(at({ deletedAt: settled })).toBe(false);
    expect(at({ updatedBy: 'claude' })).toBe(false);
    expect(at({ sendState: 'queued' })).toBe(false);
    expect(at({ sendState: 'done' })).toBe(false);
  });

  // Leave it alone (#229): checked before anything else.
  const skip = { templates: ['t-journal'], tags: ['private'] };
  const at = (over: Record<string, unknown>) =>
    arrives('n1', note, { ...note, ...over, settledAt: settled }, skip);

  it('is not a note Eric holds back', () => {
    expect(at({ gardenHold: true })).toBe(false);
    expect(at({ gardenHold: false })).toBe(true);
    // Held, it is left alone even with nothing skipped in Settings.
    expect(arrives('n1', note, { ...note, gardenHold: true, settledAt: settled })).toBe(false);
  });

  it('is not a text note made from a skipped template', () => {
    expect(at({ fromTemplate: 't-journal' })).toBe(false);
    expect(at({ fromTemplate: 't-shopping' })).toBe(true);
  });

  it('is not a note carrying a skipped tag, however it is written', () => {
    expect(at({ tags: ['private'] })).toBe(false);
    expect(at({ tags: ['pottery', '#Private'] })).toBe(false);
  });

  it('still takes a note whose tags are not skipped', () => {
    expect(at({ tags: ['pottery'] })).toBe(true);
    expect(at({ tags: [] })).toBe(true);
  });

  it('reads arrivalSkip as stored, or none', () => {
    expect(arrivalSkipOf(undefined)).toEqual({ templates: [], tags: [] });
    expect(arrivalSkipOf('private')).toEqual({ templates: [], tags: [] });
    expect(arrivalSkipOf({ templates: ['t1', 2], tags: 'x' })).toEqual({
      templates: ['t1'],
      tags: [],
    });
  });

  it('names one run per note', () => {
    expect(arrivalRunId('n1')).toBe('arrival-n1');
  });
});
