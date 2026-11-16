import { Component, computed, input } from '@angular/core';
import { SOURCE_HUES, SOURCE_TINT } from '../theme/themes';

/** A feed's mark: the letter drawn, and which of SOURCE_HUES tints it. */
export interface SourceMark {
  letter: string;
  hue: number;
}

/** FNV-1a over the string's UTF-16 units, 32 bits: the same hue on every device. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * A feed's mark (#288, 2026-11-15): the first letter or digit of its
 * name, upper case, so "🎮 Games weekly" is G and "100 Rabbits" is 1;
 * a name with neither is a dot. The hue is the feed id's, which a
 * rename keeps; with no id, the name's.
 */
export function sourceMark(feedId: string, title: string): SourceMark {
  const found = /[\p{L}\p{N}]/u.exec(title.normalize('NFC'))?.[0];
  const upper = found?.toLocaleUpperCase();
  // One character stays one: "ß" would be "SS".
  const letter = !found ? '•' : [...upper!].length === 1 ? upper! : found;
  return { letter, hue: hash(feedId || title) % SOURCE_HUES.length };
}

/**
 * The mark at a row's left edge: a tinted circle with the feed's
 * letter. Decoration only: the row says the feed's name in words.
 * Drawn on the device, so the list loads no one's favicon.
 */
@Component({
  selector: 'app-source-mark',
  template: `{{ mark().letter }}`,
  host: {
    'aria-hidden': 'true',
    '[style.background]': 'tint()',
  },
  styles: `
    :host {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      color: var(--ink);
      font-family: var(--font-body);
      font-size: 14px;
      font-weight: 600;
      line-height: 1;
      user-select: none;
    }
    :host(.small) {
      width: 24px;
      height: 24px;
      font-size: 12px;
    }
  `,
})
export class SourceMarkView {
  readonly feedId = input.required<string>();
  readonly title = input.required<string>();
  protected readonly mark = computed(() => sourceMark(this.feedId(), this.title()));
  protected readonly tint = computed(
    () => `color-mix(in srgb, ${SOURCE_HUES[this.mark().hue]} ${SOURCE_TINT}%, var(--surface))`,
  );
}
