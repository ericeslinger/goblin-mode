import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type ItemRecord, ItemsService } from './items.service';
import { ReadAct, SaveAct, actName, readAct, saveAct } from './item-acts';

const article = (read: boolean, saved: boolean): ItemRecord => ({
  id: 'a',
  feedId: 'feed1',
  title: 'Three chairs',
  link: 'https://x.test/a',
  published: Date.parse('2026-11-07T12:00:00Z'),
  summary: '',
  content: '',
  read,
  saved,
});

describe('readAct and saveAct (2026-11-22)', () => {
  it('says what a press does next, the toolbar’s icons and names', () => {
    expect(readAct(false)).toEqual({
      icon: 'check',
      label: 'Mark read',
      tip: 'Mark read',
      filled: false,
    });
    expect(readAct(true)).toMatchObject({ icon: 'unread', label: 'Keep unread' });
    expect(readAct(true).pressed).toBeUndefined();
    expect(saveAct(false)).toMatchObject({
      icon: 'bookmark',
      label: 'Save for later',
      filled: false,
      pressed: false,
    });
    expect(saveAct(true)).toMatchObject({ label: 'Save for later', filled: true, pressed: true });
    expect(saveAct(true).tip).toBe('Saved for later; press to unsave');
  });

  it('names a row’s with its article, the toolbar’s without', () => {
    expect(actName(readAct(false), 'Three chairs')).toBe('Mark read: Three chairs');
    expect(actName(saveAct(true), undefined)).toBe('Save for later');
  });
});

@Component({
  imports: [ReadAct, SaveAct],
  template: `
    <button appReadAct class="bar-read" [item]="item()"></button>
    <button appSaveAct class="bar-save" [item]="item()"></button>
    <button appReadAct small class="row-read" [item]="item()" [about]="item().title"></button>
    <button appSaveAct small class="row-save" [item]="item()" [about]="item().title"></button>
  `,
})
class Host {
  readonly item = signal(article(false, false));
}

describe('ReadAct and SaveAct (2026-11-22)', () => {
  function draw() {
    const items = { setRead: vi.fn(), setSaved: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: ItemsService, useValue: items }] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = (cls: string) => el.querySelector<HTMLButtonElement>(`button.${cls}`)!;
    return { fixture, items, button };
  }

  it('draws the same icon, name and tooltip in the toolbar and on a row', () => {
    const { button } = draw();
    expect(button('bar-read').getAttribute('aria-label')).toBe('Mark read');
    expect(button('row-read').getAttribute('aria-label')).toBe('Mark read: Three chairs');
    expect(button('bar-read').title).toBe('Mark read');
    expect(button('row-read').title).toBe('Mark read');
    expect(button('bar-save').getAttribute('aria-label')).toBe('Save for later');
    expect(button('row-save').getAttribute('aria-label')).toBe('Save for later: Three chairs');
    for (const cls of ['bar-read', 'bar-save', 'row-read', 'row-save']) {
      expect(button(cls).type).toBe('button');
      expect(button(cls).querySelector('svg')).not.toBeNull();
    }
    // The same paths: one icon in both places.
    expect(button('row-save').querySelector('svg')!.innerHTML).toBe(
      button('bar-save').querySelector('svg')!.innerHTML,
    );
    expect(button('row-read').classList).toContain('small');
    expect(button('bar-read').classList).not.toContain('small');
    // Read has no pressed state (its name changes); Save is a toggle.
    expect(button('row-read').hasAttribute('aria-pressed')).toBe(false);
    expect(button('row-save').getAttribute('aria-pressed')).toBe('false');
  });

  it('follows the article’s state and presses through the service', () => {
    const { fixture, items, button } = draw();
    button('row-read').click();
    expect(items.setRead).toHaveBeenCalledWith('a', true);
    button('bar-save').click();
    expect(items.setSaved).toHaveBeenCalledWith('a', true);
    fixture.componentInstance.item.set(article(true, true));
    fixture.detectChanges();
    expect(button('row-read').getAttribute('aria-label')).toBe('Keep unread: Three chairs');
    expect(button('bar-read').getAttribute('aria-label')).toBe('Keep unread');
    expect(button('row-save').getAttribute('aria-pressed')).toBe('true');
    expect(button('bar-save').title).toBe('Saved for later; press to unsave');
    expect(button('bar-save').querySelector('app-icon')!.classList).toContain('filled');
    button('row-read').click();
    expect(items.setRead).toHaveBeenLastCalledWith('a', false);
    button('row-save').click();
    expect(items.setSaved).toHaveBeenLastCalledWith('a', false);
  });
});
