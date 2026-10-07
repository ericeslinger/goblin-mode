import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ListView, UNDO_MS } from './list-view';

const LIST = [
  'Shopping list',
  '## Produce',
  '- [ ] limes',
  '- [x] onions',
  '## Dry goods',
  '- [x] rice ★',
].join('\n');

@Component({
  imports: [ListView],
  template: `<app-list-view [body]="body()" (edited)="changes.push($event)" />`,
})
class Host {
  readonly body = signal(LIST);
  readonly changes: { body: string; keep: boolean }[] = [];
}

async function render() {
  await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

const box = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('label')]
    .find((l) => l.textContent?.trim() === text)!
    .querySelector('input')!;

describe('ListView', () => {
  it('shows open items under their headings and ticked ones under Got it', async () => {
    const { el } = await render();
    const lists = [...el.querySelectorAll('ul')].map((ul) => [
      el.querySelector(`#${ul.getAttribute('aria-labelledby')}`)?.textContent,
      [...ul.querySelectorAll('label')].map((l) => l.textContent?.trim()),
    ]);
    expect(lists).toEqual([
      ['Produce', ['limes']],
      ['Got it', ['onions', 'rice ★']],
    ]);
    expect(box(el, 'onions').checked).toBe(true);
  });

  it('ticks and unticks one line, and Done shopping keeps the old list', async () => {
    const { el, fixture } = await render();
    box(el, 'limes').click();
    expect(fixture.componentInstance.changes.at(-1)).toEqual({
      body: LIST.replace('- [ ] limes', '- [x] limes'),
      keep: false,
    });
    box(el, 'onions').click();
    expect(fixture.componentInstance.changes.at(-1)!.body).toContain('- [ ] onions');
    [...el.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Done shopping')!
      .click();
    expect(fixture.componentInstance.changes.at(-1)).toEqual({
      body: ['Shopping list', '## Produce', '- [ ] limes', '## Dry goods', '- [ ] rice ★'].join(
        '\n',
      ),
      keep: true,
    });
  });

  it('says how to add items when there are none', async () => {
    const { el, fixture } = await render();
    fixture.componentInstance.body.set('Shopping list\n## Produce');
    await fixture.whenStable();
    expect(el.textContent).toContain('No items yet.');
  });

  it('offers Undo after Done shopping, for a while', async () => {
    const { el, fixture } = await render();
    vi.useFakeTimers();
    try {
      const button = (text: string) =>
        [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
      button('Done shopping')!.click();
      fixture.detectChanges();
      expect(el.textContent).toContain('List cleared.');
      // Claude adds bread to the cleared list before Undo.
      const cleared = fixture.componentInstance.changes.at(-1)!.body;
      fixture.componentInstance.body.set(
        cleared.replace('- [ ] limes', '- [ ] limes\n- [ ] bread'),
      );
      fixture.detectChanges();
      button('Undo')!.click();
      expect(fixture.componentInstance.changes.at(-1)).toEqual({
        body: LIST.replace('- [ ] limes', '- [ ] limes\n- [ ] bread'),
        keep: false,
      });
      fixture.detectChanges();
      expect(button('Undo')).toBeUndefined();
      fixture.componentInstance.body.set(LIST);
      fixture.detectChanges();
      button('Done shopping')!.click();
      vi.advanceTimersByTime(UNDO_MS);
      fixture.detectChanges();
      expect(el.textContent).not.toContain('List cleared.');
    } finally {
      vi.useRealTimers();
    }
  });
});
