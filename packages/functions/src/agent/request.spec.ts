import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { arrivalRunId, arrives } from './request';

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

  it('is not a note of another kind, empty, archived, an assistant’s, or sent', () => {
    const at = (over: Record<string, unknown>) =>
      arrives('n1', note, { ...note, ...over, settledAt: settled });
    for (const kind of ['template', 'recipe', 'concept', 'mealplan', 'pantry', 'clipping'])
      expect(at({ kind })).toBe(false);
    expect(arrives('context', note, { ...note, settledAt: settled })).toBe(false);
    expect(at({ body: ' \n ' })).toBe(false);
    expect(at({ archived: true })).toBe(false);
    expect(at({ updatedBy: 'claude' })).toBe(false);
    expect(at({ sendState: 'queued' })).toBe(false);
    expect(at({ sendState: 'done' })).toBe(false);
  });

  it('names one run per note', () => {
    expect(arrivalRunId('n1')).toBe('arrival-n1');
  });
});
