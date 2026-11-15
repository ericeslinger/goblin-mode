import { TestBed } from '@angular/core/testing';
import { KeyWaitLine, KeyWaitNotice } from './key-wait-notice';

// A write refused for want of the note key says so on the page (2026-11-15).
describe('KeyWaitLine', () => {
  it('says the action was not done and why, calmly, until put away', async () => {
    await TestBed.configureTestingModule({ imports: [KeyWaitLine] }).compileComponents();
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
});
