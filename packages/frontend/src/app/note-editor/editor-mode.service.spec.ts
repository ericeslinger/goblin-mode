import { TestBed } from '@angular/core/testing';
import { EditorModeService } from './editor-mode.service';

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
});
