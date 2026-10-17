import { TestBed } from '@angular/core/testing';
import { EditorModeService, VIEWING_MAX } from './editor-mode.service';

describe('EditorModeService', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to live preview', () => {
    expect(TestBed.inject(EditorModeService).mode()).toBe('live');
  });

  it('remembers the choice on the device', () => {
    TestBed.inject(EditorModeService).toggle();
    expect(localStorage.getItem('goblin.editorMode')).toBe('source');
    TestBed.resetTestingModule();
    expect(TestBed.inject(EditorModeService).mode()).toBe('source');
  });

  it('remembers viewing per note, the most recent few', () => {
    const modes = TestBed.inject(EditorModeService);
    modes.setViewing('shop', true);
    expect(modes.viewing('shop')).toBe(true);
    expect(modes.viewing('other')).toBe(false);
    TestBed.resetTestingModule();
    const again = TestBed.inject(EditorModeService);
    expect(again.viewing('shop')).toBe(true);
    again.setViewing('shop', false);
    expect(again.viewing('shop')).toBe(false);
    for (let i = 0; i <= VIEWING_MAX; i++) again.setViewing(`n${i}`, true);
    expect(again.viewing('n0')).toBe(false);
    expect(again.viewing(`n${VIEWING_MAX}`)).toBe(true);
  });

  it('reads a damaged entry as nothing viewed', () => {
    localStorage.setItem('goblin.viewing', '{not json');
    expect(TestBed.inject(EditorModeService).viewing('x')).toBe(false);
  });
});
