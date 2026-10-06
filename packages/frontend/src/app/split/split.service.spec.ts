import { TestBed } from '@angular/core/testing';
import { clampShare, DEFAULT_SHARE, MAX_SHARE, MIN_SHARE, SplitService } from './split.service';

describe('clampShare', () => {
  it('keeps the share within bounds and whole', () => {
    expect(clampShare(5)).toBe(MIN_SHARE);
    expect(clampShare(95)).toBe(MAX_SHARE);
    expect(clampShare(42.6)).toBe(43);
    expect(clampShare(Number.NaN)).toBe(DEFAULT_SHARE);
  });
});

describe('SplitService', () => {
  beforeEach(() => localStorage.clear());

  it('starts at the default and remembers changes on the device', () => {
    const split = TestBed.inject(SplitService);
    expect(split.rightNowShare()).toBe(DEFAULT_SHARE);
    split.set(50);
    TestBed.resetTestingModule();
    expect(TestBed.inject(SplitService).rightNowShare()).toBe(50);
  });

  it('previews without saving', () => {
    const split = TestBed.inject(SplitService);
    split.preview(70);
    expect(split.rightNowShare()).toBe(70);
    expect(localStorage.getItem('goblin.rightNowShare')).toBeNull();
  });

  it('ignores a corrupt stored value', () => {
    localStorage.setItem('goblin.rightNowShare', 'banana');
    expect(TestBed.inject(SplitService).rightNowShare()).toBe(DEFAULT_SHARE);
  });
});
