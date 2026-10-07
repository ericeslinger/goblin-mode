import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { NotesService } from '../notes/notes.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { GardenMap } from './garden-map';

@Component({ template: '' })
class NotePage {}

const DAY = 86_400_000;

async function render(url: string, { loaded = true } = {}) {
  const notes = new FakeNotes();
  const list = [
    { ...noteRecord('n1', 'Studio day\n[[Kiln]] and [[Glaze]]'), createdAt: 1 * DAY },
    { ...noteRecord('n2', 'Firing log\n[[Kiln]] again'), createdAt: 3 * DAY },
    { ...noteRecord('n3', 'Glaze recipe\n[[Glaze]] only'), createdAt: 5 * DAY },
    { ...noteRecord('n4', 'Kiln repair\n[[Kiln]] element'), createdAt: 4 * DAY },
    { ...noteRecord('c-kiln', ''), title: 'Kiln', kind: 'concept' as const, createdAt: 0 },
    { ...noteRecord('c-glaze', ''), title: 'Glaze', kind: 'concept' as const, createdAt: 0 },
    { ...noteRecord('lonely', 'Nothing links here'), createdAt: 2 * DAY },
  ];
  if (loaded) notes.signIn(list);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'map', component: GardenMap },
        { path: 'map/timeline', component: GardenMap, data: { layout: 'timeline' } },
        { path: 'n/:id', component: NotePage },
      ]),
      { provide: NotesService, useValue: notes },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  return { harness, el: harness.routeNativeElement as HTMLElement };
}

const titles = (el: Element) =>
  [...el.querySelectorAll('svg .node title')].map((t) => t.textContent);

describe('GardenMap', () => {
  it('plants each note once in the bed of its most-linked concept', async () => {
    const { el } = await render('/map');
    const heads = [...el.querySelectorAll('h3')].map((h) => {
      const count = h.querySelector('.muted')!.textContent!;
      return [h.textContent!.replace(count, '').trim(), count];
    });
    expect(heads).toEqual([
      ['Kiln', '3'],
      ['Glaze', '1'],
      ['Not linked yet', '1'],
    ]);
    expect(el.querySelector('[aria-labelledby="bed-1"]')?.textContent).toContain('Glaze recipe');
    expect(el.querySelector('[aria-labelledby="bed-2"]')?.textContent).toContain(
      'Nothing links here',
    );
    expect(titles(el).filter((t) => t === 'Studio day')).toHaveLength(1);
    expect(el.querySelector('nav a[aria-current="page"]')?.textContent).toBe('Garden');
  });

  it('opens a note when its dot is tapped', async () => {
    const { el, harness } = await render('/map');
    [...el.querySelectorAll<SVGGElement>('svg .node')]
      .find((n) => n.querySelector('title')?.textContent === 'Firing log')!
      .dispatchEvent(new MouseEvent('click'));
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/n/n2');
  });

  it('lays notes along time, a lane per concept, and filters to one', async () => {
    const { el, harness } = await render('/map/timeline');
    expect(el.querySelector('nav a[aria-current="page"]')?.textContent?.trim()).toBe('Timeline');
    expect([...el.querySelectorAll('h3')].map((h) => h.textContent)).toContain('Kiln');
    const select = el.querySelector('select')!;
    select.value = 'c-glaze';
    select.dispatchEvent(new Event('change'));
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/map/timeline?concept=c-glaze');
    const lanes = [...el.querySelectorAll('h3')].map((h) => h.textContent);
    expect(lanes).toEqual(['Glaze']);
    expect(el.querySelector('[aria-labelledby="lane-0"]')?.textContent).toContain('Glaze recipe');
    expect(el.querySelector('[aria-labelledby="lane-0"]')?.textContent).toContain('Studio day');
    expect(el.textContent).not.toContain('Firing log');
  });

  it('keeps the filter from the URL', async () => {
    const { el } = await render('/map/timeline?concept=c-kiln');
    expect(el.querySelector('select')!.value).toBe('c-kiln');
    expect(el.textContent).not.toContain('Glaze recipe');
  });

  it('says it is loading, not empty, before the notes arrive', async () => {
    const { el } = await render('/map', { loaded: false });
    expect(el.textContent).toContain('Loading…');
    expect(el.textContent).not.toContain('The garden is empty');
  });
});
