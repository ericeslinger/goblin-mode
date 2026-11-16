import { TestBed } from '@angular/core/testing';
import { STORAGE } from '../platform/platform';
import { DENSITY_KEY, ReaderDensity } from './density';

describe('ReaderDensity (#288)', () => {
  beforeEach(() => localStorage.clear());

  it('starts comfortable, and keeps Compact on this device', () => {
    expect(TestBed.inject(ReaderDensity).value()).toBe('comfortable');
    TestBed.inject(ReaderDensity).set('compact');
    expect(localStorage.getItem(DENSITY_KEY)).toBe('"compact"');
    // A new page on the same device reads it back.
    TestBed.resetTestingModule();
    expect(TestBed.inject(ReaderDensity).value()).toBe('compact');
  });

  it('reads anything else stored as comfortable', () => {
    localStorage.setItem(DENSITY_KEY, '"tiny"');
    expect(TestBed.inject(ReaderDensity).value()).toBe('comfortable');
    localStorage.setItem(DENSITY_KEY, '{not json');
    TestBed.resetTestingModule();
    expect(TestBed.inject(ReaderDensity).value()).toBe('comfortable');
  });

  it('works without storage, forgetting', () => {
    TestBed.configureTestingModule({ providers: [{ provide: STORAGE, useValue: null }] });
    const density = TestBed.inject(ReaderDensity);
    density.set('compact');
    expect(density.value()).toBe('compact');
    expect(localStorage.getItem(DENSITY_KEY)).toBeNull();
  });
});
