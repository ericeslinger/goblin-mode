import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { ACTIVITY_API } from '../claude/activity';
import { ProposalsService } from '../claude/proposals.service';
import { FIREBASE } from '../firebase';
import { GroceryService } from '../kitchen/grocery.service';
import { ModulesService } from '../modules/modules.service';
import { type NoteRecord, NotesService } from '../notes/notes.service';
import { NOW } from '../platform/platform';
import { ItemsService } from '../reader/items.service';
import { ReadingService } from '../reading/reading.service';
import { RemindersService } from '../reminders/reminders.service';
import {
  FakeAuthService,
  FakeItems,
  FakeModules,
  FakeNotes,
  FakeProposals,
  fakeFirebase,
  noteRecord,
} from '../testing/fakes';
import { Home } from './home';

// Tuesday 2026-11-10, 6 pm, local time.
const NOW_MS = new Date(2026, 10, 10, 18).getTime();

interface Setup {
  notes?: NoteRecord[];
  kitchen?: boolean;
  reader?: boolean;
  reminders?: string[];
  listId?: string;
  runs?: number[];
}

async function render(setup: Setup = {}) {
  const auth = new FakeAuthService();
  auth.user.set({ uid: 'u1', email: 'eric@example.com' } as User);
  const notes = new FakeNotes();
  notes.signIn(setup.notes ?? []);
  const modules = new FakeModules();
  if (setup.kitchen) modules.set('kitchen', true);
  if (setup.reader) modules.set('reader', true);
  const items = new FakeItems();
  items.unreadCounts.set({ all: 14, saved: 0, podcasts: 2 });
  items.newSince.set([
    { folder: 'Design', count: 3 },
    { folder: 'Clay', count: 2 },
  ]);
  const proposals = new FakeProposals();
  const activity = {
    listen: vi.fn(
      (_db, _path, next: (docs: { id: string; data: Record<string, unknown> }[]) => void) => {
        next(
          (setup.runs ?? []).map((at, i) => ({
            id: `r${i}`,
            data: { at: { toMillis: () => at } },
          })),
        );
        return () => undefined;
      },
    ),
  };
  await TestBed.configureTestingModule({
    imports: [Home],
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: auth },
      { provide: NotesService, useValue: notes },
      { provide: ModulesService, useValue: modules },
      { provide: ItemsService, useValue: items },
      { provide: ProposalsService, useValue: proposals },
      { provide: ReadingService, useValue: { unread: signal([{}, {}, {}]) } },
      {
        provide: RemindersService,
        useValue: {
          placed: signal((setup.reminders ?? []).map((text, i) => ({ id: `${i}`, text }))),
        },
      },
      { provide: GroceryService, useValue: { listId: signal(setup.listId) } },
      { provide: ACTIVITY_API, useValue: activity },
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: NOW, useValue: () => NOW_MS },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Home);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

const tile = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLAnchorElement>('nav a')].find(
    (a) => a.querySelector('.name')?.textContent?.trim() === name,
  );
const names = (el: HTMLElement) =>
  [...el.querySelectorAll('nav a .name')].map((n) => n.textContent?.trim());

describe('Home (#219)', () => {
  it('shows a tile for each place, in order, none for a module that is off', async () => {
    const el = await render();
    expect(names(el)).toEqual(['Notes', 'Reading queue', 'Assistants', 'Map']);
    expect(tile(el, 'Notes')?.getAttribute('href')).toBe('/browse');
    expect(tile(el, 'Map')?.getAttribute('href')).toBe('/map');
  });

  it('shows Kitchen and the Reader once they are on', async () => {
    const el = await render({ kitchen: true, reader: true });
    expect(names(el)).toEqual(['Notes', 'Kitchen', 'Reader', 'Reading queue', 'Assistants', 'Map']);
    expect(tile(el, 'Kitchen')?.getAttribute('href')).toBe('/kitchen');
    expect(tile(el, 'Reader')?.textContent).toContain('14 unread · 2 episodes');
  });

  it('counts the live notes and those written in today', async () => {
    const today = NOW_MS - 60 * 60 * 1000;
    const yesterday = NOW_MS - 30 * 60 * 60 * 1000;
    const el = await render({
      notes: [
        { ...noteRecord('a', 'Kiln shelf'), updatedAt: today },
        { ...noteRecord('b', 'Glaze notes'), updatedAt: yesterday },
        { ...noteRecord('c', 'Old'), archived: true, updatedAt: today },
        { ...noteRecord('t', 'A template'), kind: 'template', updatedAt: today },
      ],
    });
    expect(tile(el, 'Notes')?.textContent).toContain('2 · 1 today');
  });

  it('names tonight’s dinner from this week’s plan and what is left to buy', async () => {
    const el = await render({
      kitchen: true,
      listId: 'groceries',
      notes: [
        {
          ...noteRecord(
            'meals-2026-11-09',
            '- [ ] Mon dinner: out\n- [ ] Tue dinner: [[Shakshuka]]\n',
          ),
          kind: 'mealplan',
          periodStart: '2026-11-09',
        },
        noteRecord('groceries', '## Shopping\n\n- [ ] eggs\n- [x] feta\n- [ ] peppers\n'),
      ],
    });
    expect(tile(el, 'Kitchen')?.textContent).toContain('Tonight: Shakshuka · 2 to buy');
  });

  it('says when nothing is planned tonight', async () => {
    const el = await render({ kitchen: true });
    expect(tile(el, 'Kitchen')?.textContent).toContain('Tonight: nothing planned');
  });

  it('shows the next reminders and what is new in the Reader, linking to Right Now', async () => {
    const el = await render({
      reader: true,
      reminders: ['Glaze the mugs', 'Plan the week', 'Call'],
    });
    const row = el.querySelector<HTMLAnchorElement>('a.right-now')!;
    expect(row.getAttribute('href')).toBe('/right-now');
    expect(row.textContent).toContain('Glaze the mugs · Plan the week · 5 new in the Reader');
    expect(row.textContent).not.toContain('Call');
  });

  it('leaves the Reader out of Right Now while it is off', async () => {
    const el = await render();
    expect(el.querySelector('a.right-now')?.textContent).toContain('Nothing to tend');
  });

  it('counts suggestions and today’s runs for Assistants', async () => {
    const el = await render({ runs: [NOW_MS - 1000, NOW_MS - 2000, NOW_MS - 48 * 3600 * 1000] });
    expect(tile(el, 'Assistants')?.textContent).toContain('0 suggestions · 2 runs today');
    expect(tile(el, 'Reading queue')?.textContent).toContain('3 to read');
  });

  it('opens the editor from its box, a link that holds no typing', async () => {
    const el = await render();
    const box = el.querySelector<HTMLAnchorElement>('a.write')!;
    expect(box.getAttribute('href')).toBe('/');
    expect(box.textContent).toContain('Plant a thought');
    expect(el.querySelector('input, textarea, [contenteditable]')).toBeNull();
    expect(el.querySelector('a[aria-label="Settings"]')?.getAttribute('href')).toBe('/settings');
  });
});
