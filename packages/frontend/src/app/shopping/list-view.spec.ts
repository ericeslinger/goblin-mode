import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ListView } from './list-view';

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
});
