import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { NotesService } from '../notes/notes.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { boxWidthIs, screenIsWide } from '../testing/screen';
import { NeighborhoodMap } from './neighborhood-map';

@Component({ template: '' })
class NotePage {}

async function render(url: string, { loaded = true } = {}) {
  const notes = new FakeNotes();
  const list = [
    noteRecord('n1', 'Studio day\n[[Kiln]] and [[Glaze]]'),
    noteRecord('n2', 'Firing log\n[[Glaze]] only'),
    { ...noteRecord('c-kiln', ''), title: 'Kiln', kind: 'concept' },
    { ...noteRecord('c-glaze', ''), title: 'Glaze', kind: 'concept' },
    noteRecord('lonely', 'Nothing links here'),
  ];
  if (loaded) notes.signIn(list);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'map/n/:id', component: NeighborhoodMap },
        { path: 'n/:id', component: NotePage },
      ]),
      { provide: NotesService, useValue: notes },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  return { harness, el: harness.routeNativeElement as HTMLElement };
}

let teardown: (() => void)[] = [];
const onTeardown = (undo: () => void) => teardown.push(undo);

describe('NeighborhoodMap', () => {
  afterEach(() => {
    teardown.forEach((undo) => undo());
    teardown = [];
  });

  it('draws the rings and lists the same notes', async () => {
    const { el } = await render('/map/n/c-kiln');
    expect(el.querySelector('h1')?.textContent).toBe('Around Kiln');
    expect(el.querySelectorAll('svg .node')).toHaveLength(3);
    expect(el.textContent).not.toContain('Firing log');
    expect(el.querySelector('[aria-labelledby="direct"]')?.textContent).toContain('Studio day');
    const far = el.querySelector('[aria-labelledby="two-away"]')!.textContent!;
    expect(far).toContain('Glaze');
    expect(far).toContain('through Studio day');
  });

  it('opens a note when its node is tapped', async () => {
    const { el, harness } = await render('/map/n/c-kiln');
    const nodes = [...el.querySelectorAll<SVGGElement>('svg .node')];
    nodes
      .find((n) => n.querySelector('title')?.textContent === 'Studio day')!
      .dispatchEvent(new MouseEvent('click'));
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/n/n1');
  });

  it('says so when nothing links here', async () => {
    const { el } = await render('/map/n/lonely');
    expect(el.textContent).toContain('Nothing links here yet.');
    // The map's own drawing; the header's icons are drawn as svg too.
    expect(el.querySelector('svg.map')).toBeNull();
  });

  it('says it is loading, not empty, before the notes arrive', async () => {
    const { el } = await render('/map/n/c-kiln', { loaded: false });
    expect(el.textContent).toContain('Loading…');
    expect(el.textContent).not.toContain('Nothing links here yet.');
  });

  it('labels a crowded outer ring only in the list, with a large tap target on each dot', async () => {
    const wide = screenIsWide();
    onTeardown(wide);
    const notes = new FakeNotes();
    const many = Array.from({ length: 14 }, (_, i) =>
      noteRecord(`m${i}`, `Note ${i}\n[[Studio day]]`),
    );
    notes.signIn([
      noteRecord('n1', 'Studio day\n[[Kiln]] and [[Glaze]]'),
      { ...noteRecord('c-kiln', ''), title: 'Kiln', kind: 'concept' },
      { ...noteRecord('c-glaze', ''), title: 'Glaze', kind: 'concept' },
      ...many,
    ]);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'map/n/:id', component: NeighborhoodMap }]),
        { provide: NotesService, useValue: notes },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/map/n/c-kiln');
    const el = harness.routeNativeElement as HTMLElement;
    // Kiln and Studio day labelled; the 15 notes two away (Glaze and the
    // 14 linking Studio day) are not.
    expect(el.querySelectorAll('svg text')).toHaveLength(2);
    expect(el.querySelectorAll('svg circle.hit')).toHaveLength(17);
    expect(el.querySelector('svg .node title')?.textContent).toBe('Kiln');
    expect(el.querySelector('[aria-labelledby="two-away"]')!.querySelectorAll('li')).toHaveLength(
      15,
    );
  });

  describe('on a phone (#290)', () => {
    beforeEach(() => onTeardown(boxWidthIs(380)));

    const labels = (el: Element) => [...el.querySelectorAll('svg text')].map((t) => t.textContent);
    const zoomIn = async (el: HTMLElement, harness: RouterTestingHarness) => {
      [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Zoom in')!.click();
      await harness.fixture.whenStable();
    };

    it('leads with the Nearby list, the drawing after it in the zoom box', async () => {
      const { el } = await render('/map/n/c-kiln');
      const list = el.querySelector('section[aria-labelledby="nearby"]')!;
      const frame = el.querySelector('app-map-frame')!;
      expect(frame.querySelector('svg.map')).not.toBeNull();
      expect(list.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(el.querySelectorAll('svg.map')).toHaveLength(1);
    });

    it('draws no label at Fit, where they would be 9 px, and all three a step in', async () => {
      const { el, harness } = await render('/map/n/c-kiln');
      // 14-unit labels, a 600-unit drawing, a 380 px box: 8.9 px.
      expect(el.querySelectorAll('svg .node')).toHaveLength(3);
      expect(labels(el)).toEqual([]);
      await zoomIn(el, harness);
      // 13.3 px.
      expect(labels(el)).toEqual(['Kiln', 'Studio day', 'Glaze']);
    });

    it('still opens a note from its node in the box', async () => {
      const { el, harness } = await render('/map/n/c-kiln');
      [...el.querySelectorAll<SVGGElement>('app-map-frame svg .node')]
        .find((n) => n.querySelector('title')?.textContent === 'Glaze')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await harness.fixture.whenStable();
      expect(TestBed.inject(Router).url).toBe('/n/c-glaze');
    });
  });

  it('keeps the drawing first, with no zoom box, on a wide screen', async () => {
    onTeardown(screenIsWide());
    const { el } = await render('/map/n/c-kiln');
    expect(el.querySelector('app-map-frame')).toBeNull();
    const svg = el.querySelector('svg.map')!;
    const list = el.querySelector('section[aria-labelledby="nearby"]')!;
    expect(svg.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el.querySelectorAll('svg text')).toHaveLength(3);
  });
});
