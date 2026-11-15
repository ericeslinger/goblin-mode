import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { KEY_SERVICE_MISSING, KeyWaitLine, KeyWaitNotice } from './key-wait-notice';
import { NoteKeyService } from './note-key.service';

// A write refused for want of the note key says so on the page (2026-11-15).
describe('KeyWaitLine', () => {
  const unconfigured = signal(false);
  const configure = () =>
    TestBed.configureTestingModule({
      imports: [KeyWaitLine],
      providers: [{ provide: NoteKeyService, useValue: { unconfigured } }],
    }).compileComponents();
  beforeEach(() => unconfigured.set(false));

  it('says the action was not done and why, calmly, until put away', async () => {
    await configure();
    const fixture = TestBed.createComponent(KeyWaitLine);
    const el = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
    expect(el.textContent?.trim()).toBe('');
    TestBed.inject(KeyWaitNotice).say();
    await fixture.whenStable();
    const line = el.querySelector('[role="status"]')!;
    expect(line.textContent).toContain('That was not done');
    expect(line.textContent).toContain('waiting for its note key');
    expect(line.textContent).toContain('needs a connection once');
    el.querySelector('button')!.click();
    await fixture.whenStable();
    expect(el.querySelector('[role="status"]')).toBeNull();
  });

  it('says the key service is not set up, pointing at the README, when it answered 503', async () => {
    await configure();
    unconfigured.set(true);
    const fixture = TestBed.createComponent(KeyWaitLine);
    TestBed.inject(KeyWaitNotice).say();
    await fixture.whenStable();
    const line = (fixture.nativeElement as HTMLElement).querySelector('[role="status"]')!;
    expect(line.textContent).toContain('That was not done.');
    expect(line.textContent).toContain(KEY_SERVICE_MISSING);
    expect(line.textContent).not.toContain('needs a connection');
  });
});
