import { Component, computed, input } from '@angular/core';

/**
 * One mark per place (#219, the Icons sheet): a single stroke, 1.6 at
 * 24, round caps and joins, in ink; the leaf alone takes the theme's
 * second colour, so Home is always the one coloured mark. Each is a
 * list of path data; Reader's dot is a filled circle.
 */
const PATHS = {
  leaf: [
    'M12 21c-5 0-8-3.5-8-8 0-4 3-7 7-8 4-1 6 0 9-2-1 4-1 7-2 10-1.5 4.5-3 8-6 8z',
    'M12 21c0-5 2-9 6-13',
  ],
  notes: ['M5 3h11a2 2 0 0 1 2 2v16H7a2 2 0 0 1-2-2z', 'M5 3v16', 'M9 8h5M9 12h5'],
  kitchen: ['M3 11h18', 'M4 11v3a8 8 0 0 0 16 0v-3', 'M8 11V8a4 4 0 0 1 8 0v3', 'M1 13h3M20 13h3'],
  reader: ['M4 11a9 9 0 0 1 9 9', 'M4 4a16 16 0 0 1 16 16'],
  'right-now': [
    'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z',
    'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  ],
  assistants: [
    'M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z',
    'M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
    'M4 16l.7 1.5L6 18l-1.3.5L4 20l-.7-1.5L2 18l1.3-.5z',
  ],
  reading: ['M6 3h12v18l-6-4-6 4z'],
  map: ['M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z', 'M9 4v14M15 6v14'],
  write: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  settings: [
    'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  ],
  chevron: ['M9 6l6 6-6 6'],
  // The Reader's controls (#221, A-Reader and A-Article).
  'chevron-left': ['M15 6l-6 6 6 6'],
  search: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'M20 20l-3.5-3.5'],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 20h16'],
  feeds: ['M4 6h16M4 12h16M4 18h10', 'M18 15.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z'],
  check: ['M4 12l5 5L20 6'],
  bookmark: ['M6 3h12v18l-6-4-6 4z'],
  'leaf-plus': [
    'M12 21c-5 0-8-3.5-8-8 0-4 3-7 7-8 4-1 6 0 9-2-1 4-1 7-2 10-1.5 4.5-3 8-6 8z',
    'M12 21c0-5 2-9 6-13',
    'M18 3v4M16 5h4',
  ],
  'open-page': [
    'M14 4h6v6',
    'M20 4l-9 9',
    'M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5',
  ],
  play: ['M8 5v14l11-7z'],
} as const;

export type IconName = keyof typeof PATHS;

/**
 * A mark, drawn at `size`; decoration only, so its link or button names
 * it. `filled` fills its shape in ink, for a state such as saved.
 */
@Component({
  selector: 'app-icon',
  template: `
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      [attr.width]="size()"
      [attr.height]="size()"
      fill="none"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      @for (d of paths(); track $index) {
        <path [attr.d]="d" />
      }
      @if (name() === 'reader') {
        <circle cx="5" cy="19" r="1.2" class="dot" />
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
    svg {
      stroke: var(--ink);
    }
    :host(.leaf) svg {
      stroke: var(--second);
    }
    :host(.filled) path {
      fill: var(--ink);
    }
    .dot {
      fill: var(--ink);
      stroke: none;
    }
  `,
  host: { '[class.leaf]': "name() === 'leaf'", '[class.filled]': 'filled()' },
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(24);
  readonly filled = input(false);
  protected readonly paths = computed(() => PATHS[this.name()]);
}
