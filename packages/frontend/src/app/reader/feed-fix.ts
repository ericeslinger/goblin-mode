import { Component, computed, inject, input, output, signal } from '@angular/core';
import { feedId, normalizeFeedUrl } from '@mossgoblin/schema';
import { type Fix, findTarget } from './feed-health';
import {
  type DiscoveredFeed,
  type FeedRecord,
  ReaderService,
  type Switched,
} from './reader.service';

/**
 * What can be done about a feed whose look failed (2026-11-15): what
 * went wrong in plain words, then the fixes that fit. Find the feed
 * asks the server for the feeds the site names (discovery, #174) and
 * lists them, each with Switch to it, which follows that address in
 * this feed's place (`ReaderService.switchFeed`). Try again marks it
 * due for the server's next round. Remove asks first. Used by Manage
 * feeds' attention section, a feed's page and a show's page; what it
 * did is said through `said`, since a switch or a removal takes this
 * feed, and this component, away.
 */
@Component({
  selector: 'app-feed-fix',
  template: `
    @if (words()) {
      <p class="words">{{ words() }}</p>
    }
    <div class="fixes" role="group" [attr.aria-label]="'What to do about ' + feed().title">
      @for (fix of fixes(); track fix) {
        @switch (fix) {
          @case ('find') {
            <button
              type="button"
              [attr.aria-label]="'Find the feed for ' + feed().title"
              [disabled]="finding()"
              (click)="find()"
            >
              Find the feed
            </button>
          }
          @case ('retry') {
            <button
              type="button"
              [attr.aria-label]="'Try ' + feed().title + ' again'"
              (click)="retry()"
            >
              {{ retryText() }}
            </button>
          }
          @case ('remove') {
            <button
              type="button"
              [attr.aria-label]="'Remove ' + feed().title"
              [attr.aria-expanded]="confirming()"
              (click)="confirming.set(!confirming())"
            >
              Remove
            </button>
          }
        }
      }
    </div>
    @if (confirming()) {
      <div class="confirm">
        <p>
          Remove {{ feed().title }}? Its articles go with it, but for any saved or filed in the
          garden.
        </p>
        <button type="button" class="danger" (click)="remove()">Remove {{ feed().title }}</button>
        <button type="button" (click)="confirming.set(false)">Keep it</button>
      </div>
    }
    <p class="note" aria-live="polite">{{ note() }}</p>
    @if (found().length) {
      <ul class="found" [attr.aria-label]="'Feeds found for ' + feed().title">
        @for (c of found(); track c.url) {
          <li>
            <span class="name">{{ c.title }}</span>
            <span class="url">{{ c.url }}{{ followedNote(c) }}</span>
            @if (isOwn(c)) {
              <button
                type="button"
                [attr.aria-label]="'Try ' + feed().title + ' again'"
                (click)="retry()"
              >
                It answers now: try again
              </button>
            } @else {
              <button
                type="button"
                [attr.aria-label]="'Switch ' + feed().title + ' to ' + c.title"
                (click)="switchTo(c)"
              >
                Switch to it
              </button>
            }
          </li>
        }
      </ul>
      <p class="muted">
        Switch follows that address in {{ feed().title }}’s place, in its folders. Its articles go,
        but for any saved or filed in the garden.
        @if (feed().kind === 'podcast') {
          Episodes waiting in the queue that are not saved go too.
        }
      </p>
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-2);
    }
    p {
      margin: 0;
    }
    .note:empty {
      display: none;
    }
    .note,
    .muted,
    .url {
      color: var(--quiet);
      font-size: 14px;
    }
    .fixes,
    .confirm {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }
    .confirm p {
      flex-basis: 100%;
    }
    button {
      min-height: 32px;
    }
    .danger {
      font-weight: 600;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .found li {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 2px var(--space-2);
      padding: 6px 0;
      border-top: 1px solid var(--rule);
    }
    .found .name {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .found .url {
      grid-column: 1;
      overflow-wrap: anywhere;
    }
    .found button {
      grid-column: 2;
      grid-row: 1 / span 2;
      align-self: center;
    }
  `,
})
export class FeedFix {
  protected readonly reader = inject(ReaderService);
  readonly feed = input.required<FeedRecord>();
  /** What went wrong, in words; none for a feed that is fine. */
  readonly words = input('');
  readonly fixes = input.required<readonly Fix[]>();
  /** What a fix did, for the page to say: a switch or a removal takes this feed away. */
  readonly said = output<string>();
  /** The feed now followed in this one's place. */
  readonly switched = output<Switched>();

  protected readonly finding = signal(false);
  protected readonly found = signal<DiscoveredFeed[]>([]);
  protected readonly note = signal('');
  protected readonly confirming = signal(false);
  protected readonly retryText = computed(() =>
    this.feed().error || this.feed().dead ? 'Try again' : 'Look again',
  );

  /** Find the feed: the feeds the site names, or why there are none. */
  protected async find(): Promise<void> {
    const feed = this.feed();
    const target = findTarget(feed);
    let host = target;
    try {
      host = new URL(target).hostname;
    } catch {
      // The address as it is, then.
    }
    this.finding.set(true);
    this.found.set([]);
    this.note.set(`Looking for feeds at ${host}…`);
    const got = await this.reader.discover(target);
    this.finding.set(false);
    if (typeof got === 'string') {
      this.note.set(
        /^No feed found/.test(got)
          ? `No feed found at ${host}. The site may have stopped publishing one.`
          : got,
      );
      return;
    }
    this.found.set(got);
    this.note.set(
      got.length === 1
        ? `Found a feed at ${host}.`
        : `Found ${got.length} feeds at ${host}; pick the one that is ${feed.title}.`,
    );
  }

  /** Whether a found feed is this one's own address, answering now. */
  protected isOwn(c: DiscoveredFeed): boolean {
    const url = normalizeFeedUrl(c.url);
    return !!url && feedId(url) === this.feed().id;
  }

  protected followedNote(c: DiscoveredFeed): string {
    if (this.isOwn(c)) return ' · its own address';
    const known = this.reader.followed(c.url);
    return known ? ` · already followed as ${known.title}` : '';
  }

  protected switchTo(c: DiscoveredFeed): void {
    const old = this.feed();
    const out = this.reader.switchFeed(old.id, c);
    if (typeof out === 'string') {
      this.note.set(out);
      return;
    }
    this.found.set([]);
    this.note.set('');
    this.said.emit(
      out.known
        ? `${old.title} is replaced by ${out.title}, already followed, now in its folders too.`
        : `Switched ${old.title} to ${c.url}. Its articles arrive once the server has looked.`,
    );
    this.switched.emit(out);
  }

  protected retry(): void {
    const feed = this.feed();
    this.reader.retry(feed.id);
    this.found.set([]);
    this.note.set('');
    this.said.emit(
      `${feed.title} will be looked at on the server’s next round, within 15 minutes.`,
    );
  }

  protected remove(): void {
    const feed = this.feed();
    this.confirming.set(false);
    this.reader.removeFeed(feed.id);
    this.said.emit(`Removed ${feed.title}.`);
  }
}
