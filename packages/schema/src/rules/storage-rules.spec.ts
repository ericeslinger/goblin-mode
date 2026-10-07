import { describe, expect, it } from 'vitest';
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from '../model';
// Read through Vite rather than node:fs: this package has no Node types.
import rules from '../../../../storage.rules?raw';

// storage.rules is written by hand; this keeps its limits and the
// schema's from drifting apart.

describe('storage.rules', () => {
  it('allows the size the schema does', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    expect(rules).toContain('request.resource.size <= 25 * 1024 * 1024');
  });

  it('allows exactly the types the schema does', () => {
    const pattern = /contentType\.matches\('([^']+)'\)/.exec(rules)![1];
    const allowed = new RegExp(`^(?:${pattern})$`);
    for (const type of ATTACHMENT_TYPES) expect(allowed.test(type)).toBe(true);
    for (const type of ['image/svg+xml', 'text/html', 'application/zip', 'image/jpegx']) {
      expect(allowed.test(type)).toBe(false);
    }
  });
});
