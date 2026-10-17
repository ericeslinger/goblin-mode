import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LinksService } from './links.service';
import { NoteLinks } from './note-links';

async function render(backlinks: { id: string; title: string; sentence: string }[], empty = '') {
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
  fixture.componentRef.setInput('empty', empty);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('NoteLinks', () => {
  it('lists the notes linking here with their sentences', async () => {
    const el = await render([
      { id: 'n1', title: 'Glaze shelf', sentence: 'See also [[pots]]' },
      { id: 'n2', title: 'Damp room', sentence: '' },
    ]);
    const section = el.querySelector('section')!;
    expect(section.textContent).toContain('Glaze shelf');
    expect(section.textContent).toContain('See also [[pots]]');
    expect(section.querySelectorAll('li').length).toBe(2);
  });

  it('says so when nothing links here, if asked to', async () => {
    expect((await render([])).textContent?.trim()).toBe('');
    TestBed.resetTestingModule();
    expect((await render([], 'Nothing links here yet.')).textContent).toContain(
      'Nothing links here yet.',
    );
  });
});
