import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { CaptureService } from '../capture/capture.service';
import { NotesService } from '../notes/notes.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { HomeLink } from './home-link';
import { NewNoteService } from './new-note';

@Component({ imports: [HomeLink], template: '<header><app-home-link /></header>' })
class Screen {}

@Component({ template: 'the capture screen' })
class Capture {}

async function render(url = '/reader') {
  localStorage.clear();
  const notes = new FakeNotes();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: '', component: Capture },
        { path: 'reader', component: Screen },
        { path: 'home', component: Capture },
      ]),
      { provide: NotesService, useValue: notes },
    ],
  });
  const harness = await RouterTestingHarness.create(url);
  const el = harness.routeNativeElement as HTMLElement;
  const button = () => el.querySelector<HTMLButtonElement>('button[aria-label="New note"]');
  return { harness, el, notes, button, router: TestBed.inject(Router) };
}

describe('New note (#272)', () => {
  afterEach(() => localStorage.clear());

  it('sits just right of the leaf, a named 44 px button', async () => {
    const { el, button } = await render();
    const leaf = el.querySelector('a[aria-label="Home"]')!;
    expect(button()).toBeTruthy();
    expect(button()!.type).toBe('button');
    // Next after the leaf, inside the same top-left group.
    expect(leaf.nextElementSibling?.tagName.toLowerCase()).toBe('app-new-note');
  });

  it('from a screen that is not a note, opens a fresh note at /, the last one settled', async () => {
    const { harness, notes, button, router } = await render();
    notes.signIn([noteRecord('n1', 'Kiln log')]);
    const capture = TestBed.inject(CaptureService);
    capture.openNote('n1');
    button()!.click();
    await harness.fixture.whenStable();
    expect(router.url).toBe('/');
    expect(capture.open()).toEqual({ id: 'new2', text: '' });
    expect(capture.home()).toBe('new2');
    expect(notes.settle).toHaveBeenCalledWith('n1', { edited: false });
  });

  it('leaves it to the screen showing a note while one is there', async () => {
    const { harness, button, router } = await render();
    const handled = vi.fn(async () => undefined);
    const undo = TestBed.inject(NewNoteService).handle(handled);
    button()!.click();
    await harness.fixture.whenStable();
    expect(handled).toHaveBeenCalledOnce();
    expect(router.url).toBe('/reader');
    undo();
    button()!.click();
    await harness.fixture.whenStable();
    expect(handled).toHaveBeenCalledOnce();
    expect(router.url).toBe('/');
  });
});
