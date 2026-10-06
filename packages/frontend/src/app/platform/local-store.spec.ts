import { TestBed } from '@angular/core/testing';
import { LocalStore } from './local-store';
import { STORAGE } from './platform';

describe('LocalStore', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips JSON values', () => {
    const store = TestBed.inject(LocalStore);
    store.set('k', { a: 1 });
    expect(store.get('k')).toEqual({ a: 1 });
    store.remove('k');
    expect(store.get('k')).toBeUndefined();
  });

  it('treats corrupt values as missing', () => {
    localStorage.setItem('k', '{not json');
    expect(TestBed.inject(LocalStore).get('k')).toBeUndefined();
  });

  it('works without storage at all', () => {
    TestBed.configureTestingModule({ providers: [{ provide: STORAGE, useValue: null }] });
    const store = TestBed.inject(LocalStore);
    store.set('k', 1);
    expect(store.get('k')).toBeUndefined();
  });
});
