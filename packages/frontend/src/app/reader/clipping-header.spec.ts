import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { feedId, feedItemId } from '@mossgoblin/schema';
import type { NoteRecord } from '../notes/notes.service';
import { FakeReader, noteRecord } from '../testing/fakes';
import { ClippingHeader, feedOfItem } from './clipping-header';
import { ReaderService } from './reader.service';

const SHOW = feedId('https://kiln.test/rss');
const BLOG = feedId('https://blog.test/rss');

function render(note: NoteRecord) {
  const reader = new FakeReader();
  reader.feeds.set([
    {
      id: SHOW,
      url: 'https://kiln.test/rss',
      title: 'Kiln',
      folders: [],
      dead: false,
      kind: 'podcast',
    },
    { id: BLOG, url: 'https://blog.test/rss', title: 'Blog', folders: [], dead: false },
  ]);
  TestBed.configureTestingModule({
    imports: [ClippingHeader],
    providers: [provideRouter([]), { provide: ReaderService, useValue: reader }],
  });
  const fixture = TestBed.createComponent(ClippingHeader);
  fixture.componentRef.setInput('note', note);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const clipping = (item: string): NoteRecord => ({
  ...noteRecord('c1', 'Reduction firing'),
  kind: 'clipping',
  source: { url: 'https://kiln.test/ep1', feedItemId: item },
});

describe('A clipping’s header (#163, #251)', () => {
  it('reads the feed from an item’s id', () => {
    expect(feedOfItem(feedItemId(SHOW, 'guid-1'))).toBe(SHOW);
    expect(feedOfItem('not-an-item')).toBeUndefined();
  });

  it('links an episode of a show back to its page in Podcasts', () => {
    const id = feedItemId(SHOW, 'guid-1');
    const el = render(clipping(id));
    const back = [...el.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'In Podcasts');
    expect(back?.getAttribute('href')).toBe(`/podcasts/e/${id}`);
    expect(el.textContent).not.toContain('In the Reader');
  });

  it('links a Reader article back to its article page', () => {
    const id = feedItemId(BLOG, 'guid-2');
    const el = render(clipping(id));
    const back = [...el.querySelectorAll('a')].find(
      (a) => a.textContent?.trim() === 'In the Reader',
    );
    expect(back?.getAttribute('href')).toBe(`/reader/a/${id}`);
  });
});
