import { Component, booleanAttribute, computed, inject, input } from '@angular/core';
import { Icon, type IconName } from '../home/icon';
import { type ItemRecord, ItemsService } from './items.service';

/** What an article's read or save control shows and says, in its state. */
export interface ItemAct {
  icon: IconName;
  /** Its accessible name, before the article's title where a row adds it. */
  label: string;
  /** Its tooltip, for a mouse: what a press does. */
  tip: string;
  /** Whether the icon is filled (saved). */
  filled: boolean;
  /** `aria-pressed`, for a toggle that keeps its name; undefined for one that changes it. */
  pressed?: boolean;
}

/**
 * Keep unread and Mark read (#288): an open dot on a read article, a
 * tick on an unread one; the name says what a press does next, so
 * there is no pressed state.
 */
export function readAct(read: boolean): ItemAct {
  return read
    ? { icon: 'unread', label: 'Keep unread', tip: 'Keep unread', filled: false }
    : { icon: 'check', label: 'Mark read', tip: 'Mark read', filled: false };
}

/** Save for later (#221): one name, the bookmark filled and pressed once saved. */
export function saveAct(saved: boolean): ItemAct {
  return {
    icon: 'bookmark',
    label: 'Save for later',
    tip: saved ? 'Saved for later; press to unsave' : 'Save for later',
    filled: saved,
    pressed: saved,
  };
}

/** A row's name for an act: "Mark read: Three chairs"; the toolbar's has no title. */
export function actName(act: ItemAct, about: string | undefined): string {
  return about ? `${act.label}: ${about}` : act.label;
}

/*
 * The act's box (#221's icon-only control): 44 px, or 36 on a row of
 * the list with a mouse (`small`), 44 again on touch; pressed shows as
 * the chip's ground, as the article's toolbar always had it.
 */
const ACT_STYLES = `
  :host {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-control);
    background: transparent;
    cursor: pointer;
  }
  :host(.small) {
    width: 36px;
    height: 36px;
  }
  :host(:hover) {
    background: var(--chip-bg);
  }
  :host([aria-pressed='true']) {
    background: var(--chip-bg);
  }
  @media (pointer: coarse) {
    :host(.small) {
      width: 44px;
      height: 44px;
    }
  }
`;

/**
 * An article's read control, the same in the article's toolbar and on
 * a row of the list (Eric, 2026-11-22: the row's buttons are the
 * toolbar's icons), so the two cannot drift: icon, name, tooltip and
 * state come from `readAct`. On a row, `about` is the article's title,
 * added to the name so each row's is its own.
 */
@Component({
  selector: 'button[appReadAct]',
  imports: [Icon],
  host: {
    type: 'button',
    '[class.small]': 'small()',
    '[attr.aria-label]': 'name()',
    '[attr.title]': 'act().tip',
    '(click)': 'items.setRead(item().id, !item().read)',
  },
  template: `<app-icon [name]="act().icon" [size]="small() ? 20 : 22" />`,
  styles: ACT_STYLES,
})
export class ReadAct {
  protected readonly items = inject(ItemsService);
  readonly item = input.required<ItemRecord>();
  readonly about = input<string | undefined>(undefined);
  readonly small = input(false, { transform: booleanAttribute });
  protected readonly act = computed(() => readAct(!!this.item().read));
  protected readonly name = computed(() => actName(this.act(), this.about()));
}

/** An article's Save for later, the toolbar's and a row's alike; see ReadAct. */
@Component({
  selector: 'button[appSaveAct]',
  imports: [Icon],
  host: {
    type: 'button',
    '[class.small]': 'small()',
    '[attr.aria-label]': 'name()',
    '[attr.title]': 'act().tip',
    '[attr.aria-pressed]': "act().pressed ? 'true' : 'false'",
    '(click)': 'items.setSaved(item().id, !item().saved)',
  },
  template: `<app-icon [name]="act().icon" [size]="small() ? 20 : 22" [filled]="act().filled" />`,
  styles: ACT_STYLES,
})
export class SaveAct {
  protected readonly items = inject(ItemsService);
  readonly item = input.required<ItemRecord>();
  readonly about = input<string | undefined>(undefined);
  readonly small = input(false, { transform: booleanAttribute });
  protected readonly act = computed(() => saveAct(!!this.item().saved));
  protected readonly name = computed(() => actName(this.act(), this.about()));
}
