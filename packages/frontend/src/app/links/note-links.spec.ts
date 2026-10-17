import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LinksService } from './links.service';
import { NoteLinks } from './note-links';

async function render(backlinks: { id: string; title: string; sentence: string }[]) {
  TestBed.configureTestingModule({
    imports: [NoteLinks],
    providers: [
      provideRouter([]),
      {
        provide: LinksService,
        useValue: { backlinksTo: () => backlinks, togetherWith: () => [] },
      },
    ],
  });
  const fixture = TestBed.createComponent(NoteLinks);
  fixture.componentRef.setInput('noteId', 'c-pots');
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('NoteLinks', () => {
  it('folds the notes linking here under how many there are (2026-10-17)', async () => {
    const { el, fixture } = await render([
      { id: 'n1', title: 'Glaze shelf', sentence: 'See also [[pots]]' },
      { id: 'n2', title: 'Damp room', sentence: '' },
    ]);
    const fold = el.querySelector('button')!;
    expect(fold.textContent?.trim()).toBe('Linked from 2');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('section')).toBeNull();
    fold.click();
    await fixture.whenStable();
    expect(el.querySelector('section')!.textContent).toContain('Glaze shelf');
    // Another note opens folded.
    fixture.componentRef.setInput('noteId', 'c-other');
    await fixture.whenStable();
    expect(el.querySelector('section')).toBeNull();
  });

  it('shows nothing when nothing links here', async () => {
    const { el } = await render([]);
    expect(el.querySelector('button')).toBeNull();
  });
});
