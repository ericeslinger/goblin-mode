import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { boxWidthIs, screenIsWide } from '../testing/screen';
import { GardenMap } from './garden-map';

@Component({ template: '' })
class NotePage {}

const DAY = 86_400_000;

async function render(url: string, { loaded = true, extra = [] as NoteRecord[] } = {}) {
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
  if (loaded) notes.signIn([...list, ...extra]);
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

  it('says there is nothing to show for a concept no note links', async () => {
    const idle = { ...noteRecord('c-idle', ''), title: 'Idle', kind: 'concept' as const };
    const { el } = await render('/map/timeline?concept=c-idle', { extra: [idle] });
    expect(el.textContent).toContain('Nothing to show yet.');
    expect(el.querySelector('select')!.value).toBe('c-idle');
  });

  it('shows every concept when the filter names none that exists', async () => {
    const { el } = await render('/map/timeline?concept=c-gone');
    expect(el.querySelector('select')!.value).toBe('');
    expect(el.textContent).toContain('Firing log');
  });

  it('says it is loading, not empty, before the notes arrive', async () => {
    const { el } = await render('/map', { loaded: false });
    expect(el.textContent).toContain('Loading…');
    expect(el.textContent).not.toContain('The garden is empty');
  });

  describe('on a phone (#290)', () => {
    let undo: () => void;
    afterEach(() => undo());

    const zoomIn = async (el: HTMLElement, harness: RouterTestingHarness) => {
      [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Zoom in')!.click();
      await harness.fixture.whenStable();
    };

    it('leads with the Beds, the drawing after them in the zoom box', async () => {
      undo = boxWidthIs(380);
      const { el } = await render('/map');
      const beds = el.querySelector('section[aria-labelledby="beds"]')!;
      const frame = el.querySelector('app-map-frame')!;
      expect(frame.querySelector('svg.map')).not.toBeNull();
      expect(beds.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('names the beds in the drawing only once they read at 11 px', async () => {
      // Three beds, two across: 480 units. In a 300 px box a 17-unit
      // name is 10.6 px at Fit, 15.9 px a step in.
      undo = boxWidthIs(300);
      const { el, harness } = await render('/map');
      expect(el.querySelectorAll('svg .node').length).toBeGreaterThan(0);
      expect(el.querySelectorAll('svg text.bed-label')).toHaveLength(0);
      await zoomIn(el, harness);
      expect(
        [...el.querySelectorAll('svg text.bed-label')].map((t) => t.textContent?.trim()),
      ).toEqual(['Kiln', 'Glaze', 'Not linked yet']);
    });

    it('names the lanes and the dates a step in, not at Fit', async () => {
      // 760 units in 380 px: lane names 10 px and dates 9 px at Fit,
      // 15 px and 13.5 px a step in.
      undo = boxWidthIs(380);
      const { el, harness } = await render('/map/timeline');
      const over = el.querySelector('section[aria-labelledby="lanes"]')!;
      expect(
        over.compareDocumentPosition(el.querySelector('app-map-frame')!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(el.querySelectorAll('svg text')).toHaveLength(0);
      await zoomIn(el, harness);
      expect(el.querySelectorAll('svg text.lane-label').length).toBeGreaterThan(0);
      expect(el.querySelectorAll('svg text.axis')).toHaveLength(2);
    });
  });

  it('keeps the drawing first, every label, no zoom box, on a wide screen', async () => {
    const undo = screenIsWide();
    try {
      const { el } = await render('/map');
      expect(el.querySelector('app-map-frame')).toBeNull();
      const svg = el.querySelector('svg.map')!;
      const beds = el.querySelector('section[aria-labelledby="beds"]')!;
      expect(svg.compareDocumentPosition(beds) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(el.querySelectorAll('svg text.bed-label')).toHaveLength(3);
    } finally {
      undo();
    }
  });
});
