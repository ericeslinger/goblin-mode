import { ApplicationRef, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ModulesService } from '../modules/modules.service';
import { DownloadsService } from '../reader/downloads.service';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { PlayerService } from '../reader/player.service';
import { ReaderService } from '../reader/reader.service';
import { FakeDownloads, FakeItems, FakeModules, FakeReader } from '../testing/fakes';
import { PodcastsQueue } from './podcasts-queue';

const audio = (seconds?: number) => ({
  url: 'https://pod.test/x.mp3',
  type: 'audio/mpeg',
  ...(seconds ? { seconds } : {}),
});
const ep = (id: string, title: string, more: Partial<ItemRecord> = {}): ItemRecord => ({
  id,
  feedId: 'p1',
  title,
  link: '',
  published: 0,
  summary: '',
  content: '',
  read: false,
  saved: false,
  enclosure: audio(3000),
  ...more,
});

async function open(list: ItemRecord[]) {
  const items = new FakeItems();
  items.episodes.set(list);
  const reader = new FakeReader();
  reader.feeds.set([
    {
      id: 'p1',
      url: 'https://kiln.test/f',
      title: 'Kiln talk',
      folders: [],
      dead: false,
      kind: 'podcast',
    },
  ]);
  const current = signal<string | undefined>(undefined);
  const player = {
    current,
    playing: signal(false),
    position: signal(0),
    duration: signal(0),
    item: computed(() => items.episodes().find((e) => e.id === current())),
    load: vi.fn((it: ItemRecord) => current.set(it.id)),
    toggle: vi.fn(),
  };
  const modules = new FakeModules();
  modules.set('podcasts', true);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'podcasts/queue', component: PodcastsQueue },
        { path: '**', children: [] },
      ]),
      { provide: ItemsService, useValue: items },
      { provide: ReaderService, useValue: reader },
      { provide: PlayerService, useValue: player },
      { provide: DownloadsService, useValue: new FakeDownloads() },
      { provide: ModulesService, useValue: modules },
    ],
  });
  const harness = await RouterTestingHarness.create('/podcasts/queue');
  const el = harness.routeNativeElement!;
  const settle = () => TestBed.inject(ApplicationRef).whenStable();
  const upNext = () =>
    [...el.querySelectorAll('ul[aria-label="Up next, drag to reorder"] > li.row .title')].map((t) =>
      t.textContent!.trim(),
    );
  const button = (name: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent!.replace(/\s+/g, ' ').trim()) === name,
    );
  const live = () => el.querySelector('[aria-live="polite"]')!.textContent!.trim();
  return { harness, el, items, player, upNext, button, settle, live };
}

const three = () => [
  ep('a', 'Ash glazes', { queue: 1000 }),
  ep('b', 'Bisque firing', { queue: 2000, position: 600 }),
  ep('c', 'Cone packs', { queue: 3000, enclosure: audio() }),
  ep('x', 'Not queued'),
];

describe('PodcastsQueue (#249)', () => {
  it('lists Up next in order, with its count and what is left of each', async () => {
    const { el, upNext } = await open(three());
    expect(upNext()).toEqual(['Ash glazes', 'Bisque firing', 'Cone packs']);
    // 50 min, then 40 of Bisque's left; Cone packs' length is unknown.
    expect(el.querySelector('.next .head .meta')!.textContent!.trim()).toBe('3 episodes · 90 min');
    const rows = el.querySelectorAll('li.row');
    const meta = (n: number) => rows[n].querySelector('.meta')!.textContent!.replace(/\s+/g, ' ');
    expect(meta(0)).toContain('Kiln talk · 50 min');
    expect(meta(1)).toContain('40 min left');
    expect(rows[0].querySelector('a')!.getAttribute('href')).toBe('/podcasts/e/a');
    expect(el.querySelector('button[aria-label="Move Ash glazes"]')).not.toBeNull();
    expect(el.querySelector('button[aria-label="More for Ash glazes"]')).not.toBeNull();
    expect(el.querySelector('#now-playing')).toBeNull();
  });

  it('says how to add to an empty queue', async () => {
    const { el, upNext } = await open([ep('x', 'Not queued')]);
    expect(upNext()).toEqual([]);
    expect(el.textContent).toContain('Nothing up next.');
    expect(el.querySelector('.next .head .meta')).toBeNull();
  });

  it('shows the playing one under Now playing, and not again under Up next', async () => {
    const { el, upNext, player, harness } = await open(three());
    player.current.set('b');
    player.position.set(600);
    player.duration.set(3000);
    harness.detectChanges();
    const now = el.querySelector('section.now')!;
    expect(now.textContent).toContain('Bisque firing');
    expect(now.textContent!.replace(/\s+/g, ' ')).toContain('Kiln talk · 40 min left');
    expect(now.querySelector<HTMLElement>('.progress span')!.style.width).toBe('20%');
    expect(upNext()).toEqual(['Ash glazes', 'Cone packs']);
    expect(el.querySelector('.next .head .meta')!.textContent!.trim()).toBe('2 episodes · 50 min');
  });

  it('moves a row by its grip’s arrows and says where', async () => {
    const { el, items, upNext, settle, live } = await open(three());
    const press = async (title: string, key: string) => {
      el.querySelector<HTMLButtonElement>(`button[aria-label="Move ${title}"]`)!.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
      await settle();
    };
    await press('Cone packs', 'ArrowUp');
    expect(items.moveInQueue).toHaveBeenLastCalledWith('c', ['a', 'c', 'b']);
    expect(upNext()).toEqual(['Ash glazes', 'Cone packs', 'Bisque firing']);
    expect(live()).toBe('Moved Cone packs to 2 of 3');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move Cone packs');
    await press('Cone packs', 'ArrowDown');
    expect(upNext()).toEqual(['Ash glazes', 'Bisque firing', 'Cone packs']);
    expect(live()).toBe('Moved Cone packs to 3 of 3');
    // Past the end it stays, and says so.
    await press('Cone packs', 'ArrowDown');
    expect(items.moveInQueue).toHaveBeenCalledTimes(2);
    expect(live()).toBe('Cone packs stays at 3 of 3');
  });

  it('drags a row by its grip: it lifts, a slot shows, and the drop writes the order', async () => {
    const { el, items, upNext, harness, live } = await open(three());
    // jsdom lays nothing out: each row 68 high, 8 apart.
    el.querySelectorAll<HTMLElement>('li.row').forEach((li, n) => {
      Object.defineProperty(li, 'offsetTop', { value: n * 76 });
      Object.defineProperty(li, 'offsetHeight', { value: 68 });
    });
    const grip = el.querySelector<HTMLButtonElement>('button[aria-label="Move Ash glazes"]')!;
    // Pointer events as the browser gives them (jsdom has no PointerEvent).
    const pointer = (type: string, clientY: number) =>
      grip.dispatchEvent(
        Object.assign(
          new MouseEvent(type, { button: 0, clientY, bubbles: true, cancelable: true }),
          { isPrimary: true, pointerId: 1 },
        ),
      );
    pointer('pointerdown', 30);
    harness.detectChanges();
    const lifted = el.querySelector('li.lifted .title');
    expect(lifted?.textContent).toBe('Ash glazes');
    // Past the middle of the second row: it would land second.
    pointer('pointermove', 30 + 90);
    harness.detectChanges();
    const slot = el.querySelector<HTMLElement>('li.drop')!;
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    expect(slot.style.top).toBe('76px');
    expect(slot.style.height).toBe('68px');
    const rows = el.querySelectorAll<HTMLElement>('li.row');
    expect(rows[0].style.transform).toBe('translateY(90px)');
    expect(rows[1].style.transform).toBe('translateY(-76px)');
    expect(rows[2].style.transform).toBe('');
    // Past the third's middle too: last.
    pointer('pointermove', 30 + 170);
    harness.detectChanges();
    expect(el.querySelector<HTMLElement>('li.drop')!.style.top).toBe('152px');
    pointer('pointerup', 30 + 170);
    harness.detectChanges();
    expect(items.moveInQueue).toHaveBeenCalledWith('a', ['b', 'c', 'a']);
    expect(upNext()).toEqual(['Bisque firing', 'Cone packs', 'Ash glazes']);
    expect(el.querySelector('li.drop')).toBeNull();
    expect(el.querySelector('li.lifted')).toBeNull();
    expect(live()).toBe('Moved Ash glazes to 3 of 3');
  });

  it('writes nothing for a drag dropped where it started', async () => {
    const { el, items, harness } = await open(three());
    el.querySelectorAll<HTMLElement>('li.row').forEach((li, n) => {
      Object.defineProperty(li, 'offsetTop', { value: n * 76 });
      Object.defineProperty(li, 'offsetHeight', { value: 68 });
    });
    const grip = el.querySelector<HTMLButtonElement>('button[aria-label="Move Bisque firing"]')!;
    const pointer = (type: string, clientY: number) =>
      grip.dispatchEvent(
        Object.assign(new MouseEvent(type, { button: 0, clientY, bubbles: true }), {
          isPrimary: true,
        }),
      );
    pointer('pointerdown', 10);
    pointer('pointermove', 12);
    pointer('pointerup', 12);
    harness.detectChanges();
    expect(items.moveInQueue).not.toHaveBeenCalled();
  });

  it('More: Play, Move up and down, Play next, Remove; Escape closes and focus returns', async () => {
    const { el, items, upNext, button, settle, live, player } = await open(three());
    const more = () => button('More for Cone packs')!;
    more().click();
    await settle();
    const menu = el.querySelector('#queue-menu')!;
    expect(menu.getAttribute('role')).toBe('group');
    expect(menu.getAttribute('aria-label')).toBe('More for Cone packs');
    expect(more().getAttribute('aria-expanded')).toBe('true');
    expect([...menu.querySelectorAll('button')].map((b) => b.textContent!.trim())).toEqual([
      'Play',
      'Move up',
      'Move down',
      'Play next',
      'Remove from the queue',
    ]);
    // The last row cannot move down; focus is on the first choice.
    expect(button('Move down')!.disabled).toBe(true);
    expect(document.activeElement?.textContent?.trim()).toBe('Play');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(el.querySelector('#queue-menu')).toBeNull();
    expect(document.activeElement).toBe(more());

    more().click();
    await settle();
    button('Move up')!.click();
    await settle();
    expect(upNext()).toEqual(['Ash glazes', 'Cone packs', 'Bisque firing']);
    expect(live()).toBe('Moved Cone packs to 2 of 3');
    expect(document.activeElement).toBe(more());

    more().click();
    await settle();
    button('Play next')!.click();
    await settle();
    expect(items.playNext).toHaveBeenCalledWith('c');
    expect(upNext()).toEqual(['Cone packs', 'Ash glazes', 'Bisque firing']);
    expect(live()).toBe('Cone packs plays next');

    button('More for Ash glazes')!.click();
    await settle();
    button('Remove from the queue')!.click();
    await settle();
    expect(items.removeFromQueue).toHaveBeenCalledWith('a');
    expect(upNext()).toEqual(['Cone packs', 'Bisque firing']);
    expect(live()).toBe('Removed Ash glazes from the queue');
    expect(document.activeElement).toBe(button('More for Bisque firing'));

    // Play from its row: in the player, out of Up next, the others in place.
    button('More for Bisque firing')!.click();
    await settle();
    button('Play')!.click();
    await settle();
    expect(player.load).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), {
      autoplay: true,
    });
    expect(upNext()).toEqual(['Cone packs']);
    expect(items.queue().map((e) => e.id)).toEqual(['c', 'b']);
    expect(el.querySelector('section.now')!.textContent).toContain('Bisque firing');
  });

  it('closes More on a press outside it', async () => {
    const { el, button, settle } = await open(three());
    button('More for Ash glazes')!.click();
    await settle();
    expect(el.querySelector('#queue-menu')).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await settle();
    expect(el.querySelector('#queue-menu')).toBeNull();
  });
});
