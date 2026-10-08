import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AttachmentsService } from '../attachments/attachments.service';
import { type ReadingItem, ReadingService } from './reading.service';

/**
 * The reading queue (#48): PDFs and links saved to read later, newest
 * first, unread above read. A link can be saved here; its title and
 * text arrive once a function has fetched it.
 */
@Component({
  selector: 'app-reading',
  imports: [RouterLink],
  template: `
    <main class="page">
      <a routerLink="/browse">Back</a>
      <h1>Reading queue</h1>
      <form novalidate (submit)="save($event, link)">
        <label>
          <span class="visually-hidden">Link to save</span>
          <input #link type="url" placeholder="Paste a link to read later" enterkeyhint="done" />
        </label>
        <button type="submit">Save</button>
      </form>
      @if (status()) {
        <p class="status" role="status">{{ status() }}</p>
      }
      @if (reading.queue().length === 0) {
        <p class="muted">Nothing saved to read. Save a link, or ask Claude to save a paper.</p>
      }
      <ul aria-label="Reading queue">
        @for (item of reading.queue(); track item.id) {
          <li [class.read]="item.read">
            @if (item.url && item.kind === 'link') {
              <a class="name" [href]="item.url" target="_blank" rel="noopener noreferrer">{{
                item.name
              }}</a>
            } @else if (item.noteId) {
              <a class="name" [routerLink]="['/n', item.noteId]">{{ item.name }}</a>
            } @else {
              <button type="button" class="name link" (click)="open(item)">{{ item.name }}</button>
            }
            <span class="meta">{{ meta(item) }}</span>
            @if (item.importError) {
              <span class="meta">Could not fetch: {{ item.importError }}</span>
            }
            <button
              type="button"
              class="mark"
              [attr.aria-label]="(item.read ? 'Mark unread: ' : 'Mark read: ') + item.name"
              (click)="reading.setRead(item.id, !item.read)"
            >
              {{ item.read ? 'Unread' : 'Read' }}
            </button>
          </li>
        }
      </ul>
    </main>
  `,
  styles: `
    form {
      display: flex;
      gap: var(--space-2);
      margin-bottom: var(--space-3);
    }
    label {
      flex: 1;
    }
    input {
      box-sizing: border-box;
      width: 100%;
      font: inherit;
      padding: 10px 12px;
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      color: var(--ink);
      background: var(--surface);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 2px var(--space-2);
      padding: 10px 4px;
      border-bottom: 1px solid var(--rule);
    }
    li.read .name {
      color: var(--quiet);
    }
    .name {
      font-weight: 600;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .link {
      font: inherit;
      font-weight: 600;
      text-align: left;
      background: none;
      border: 0;
      padding: 0;
      cursor: pointer;
      text-decoration: underline;
    }
    .meta,
    .muted,
    .status {
      grid-column: 1;
      color: var(--quiet);
      font-size: 14px;
    }
    .mark {
      grid-column: 2;
      grid-row: 1 / span 2;
      align-self: center;
      min-height: 32px;
    }
  `,
})
export class Reading {
  protected readonly reading = inject(ReadingService);
  private readonly attachments = inject(AttachmentsService);
  protected readonly status = signal('');

  protected save(event: Event, input: HTMLInputElement): void {
    event.preventDefault();
    if (this.reading.save(input.value)) {
      input.value = '';
      this.status.set('Saved. Its title and text arrive in a moment.');
    } else {
      this.status.set('That is not a link. Paste one starting with https://.');
    }
  }

  /** A PDF with no note: its file, from the device or a download. */
  protected async open(item: ReadingItem): Promise<void> {
    // The tab opens within the tap, as phones require, then gets the file
    // once it is ready (review on #100).
    const tab = window.open('about:blank', '_blank');
    const url = await this.attachments.full(item.id);
    if (url && tab) tab.location.href = url;
    else {
      tab?.close();
      this.status.set('This PDF is not on this device yet. Try again online.');
    }
  }

  protected meta(item: ReadingItem): string {
    const kind = item.kind === 'pdf' ? `PDF${item.pages ? `, ${item.pages} pages` : ''}` : 'Link';
    const when = item.savedAt
      ? new Date(item.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : 'just now';
    return `${kind} · saved ${when}`;
  }
}
