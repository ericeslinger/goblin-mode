import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ModulesService } from '../modules/modules.service';
import { ItemsService } from '../reader/items.service';
import { type DiscoveredFeed, type FeedRecord, ReaderService } from '../reader/reader.service';
import { FakeItems, FakeModules, FakeReader } from '../testing/fakes';
import { PodcastsAdd } from './podcasts-add';

function setup(found: DiscoveredFeed[] | string = []) {
  const reader = Object.assign(new FakeReader(), {
    addFeed: vi.fn((_url: string, _folder?: string, _title?: string, _as?: object) => 'p9'),
    followed: vi.fn((_url: string): FeedRecord | undefined => undefined),
    discover: vi.fn(async (_url: string) => found),
  });
  const modules = new FakeModules();
  modules.set('podcasts', true);
  TestBed.configureTestingModule({
    imports: [PodcastsAdd],
    providers: [
      provideRouter([]),
      { provide: ReaderService, useValue: reader },
      { provide: ItemsService, useValue: new FakeItems() },
      { provide: ModulesService, useValue: modules },
    ],
  });
  const fixture = TestBed.createComponent(PodcastsAdd);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const type = (label: string, value: string) => {
    const input = [...el.querySelectorAll('label')]
      .find((l) => l.textContent?.includes(label))!
      .querySelector('input')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const button = (text: RegExp) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => text.test(b.textContent!))!;
  const sw = () => el.querySelector<HTMLInputElement>('input[role="switch"]')!;
  return { fixture, el, reader, type, button, sw };
}

describe('Add a podcast (#245)', () => {
  it('has New episodes join the queue off by default, and follows the show with its kind', async () => {
    const { fixture, el, reader, type, button, sw } = setup([
      { url: 'https://kiln.test/rss', title: 'Kiln talk', episodes: 112 },
    ]);
    expect(sw().checked).toBe(false);
    expect(el.textContent).toContain('Off: you add episodes yourself');
    type('feed, or its site', 'kiln.test');
    fixture.detectChanges();
    button(/Find the feed/).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(reader.discover).toHaveBeenCalledWith('kiln.test');
    expect(el.querySelector('[aria-label="Feeds found"]')?.textContent).toContain(
      'Found its feed · 112 episodes',
    );
    type('Folder', 'Making');
    button(/Follow Kiln talk/).click();
    expect(reader.addFeed).toHaveBeenCalledWith('https://kiln.test/rss', 'Making', 'Kiln talk', {
      podcast: true,
      autoQueue: false,
    });
    fixture.detectChanges();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Following Kiln talk.');
  });

  it('keeps the switch on when switched, and follows a link as typed without a look', () => {
    const { fixture, el, reader, type, button, sw } = setup();
    sw().click();
    fixture.detectChanges();
    expect(el.textContent).toContain('On: its new episodes go to the end of the queue');
    expect(el.textContent).not.toContain('comes soon');
    type('feed, or its site', 'https://pod.test/feed.xml');
    fixture.detectChanges();
    button(/^\s*Follow\s*$/).click();
    expect(reader.addFeed).toHaveBeenCalledWith('https://pod.test/feed.xml', undefined, undefined, {
      podcast: true,
      autoQueue: true,
    });
  });

  it('moves nothing: a feed in the Reader stays there, and says where to move it', () => {
    const { fixture, el, reader, type, button } = setup();
    reader.followed.mockReturnValue({
      id: 'f1',
      url: 'https://blog.test/rss',
      title: 'A blog',
      folders: [],
      dead: false,
    });
    type('feed, or its site', 'https://blog.test/rss');
    fixture.detectChanges();
    button(/^\s*Follow\s*$/).click();
    fixture.detectChanges();
    expect(reader.addFeed).not.toHaveBeenCalled();
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'A blog is in the Reader; Manage feeds there can move it to Podcasts.',
    );
  });
});
