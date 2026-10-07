import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { NotesService } from '../notes/notes.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { NeighborhoodMap } from './neighborhood-map';

@Component({ template: '' })
class NotePage {}

async function render(url: string) {
  const notes = new FakeNotes();
  notes.signIn([
    noteRecord('n1', 'Studio day\n[[Kiln]] and [[Glaze]]'),
    noteRecord('n2', 'Firing log\n[[Glaze]] only'),
    { ...noteRecord('c-kiln', ''), title: 'Kiln', kind: 'concept' },
    { ...noteRecord('c-glaze', ''), title: 'Glaze', kind: 'concept' },
    noteRecord('lonely', 'Nothing links here'),
  ]);
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

describe('NeighborhoodMap', () => {
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
    nodes.find((n) => n.textContent === 'Studio day')!.dispatchEvent(new MouseEvent('click'));
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/n/n1');
  });

  it('says so when nothing links here', async () => {
    const { el } = await render('/map/n/lonely');
    expect(el.textContent).toContain('Nothing links here yet.');
    expect(el.querySelector('svg')).toBeNull();
  });
});
