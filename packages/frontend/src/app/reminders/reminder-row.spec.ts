import { TestBed } from '@angular/core/testing';
import { sectionOf } from '@mossgoblin/schema';
import { ReminderRow, SWIPE_PX } from './reminder-row';
import type { PlacedReminder } from './reminders.service';
import { HOUR, NOW, buttonNamed, renderWithReminders } from '../testing/reminders';

function renderRow(r: Partial<PlacedReminder> & { text: string }) {
  const placed: PlacedReminder = {
    id: 'r1',
    status: 'open',
    createdBy: 'user',
    ...r,
    due: r.dueAt,
    section: sectionOf(r.dueAt, NOW, 'America/New_York'),
  };
  return renderWithReminders(ReminderRow, ({ fixture }) => {
    fixture.componentRef.setInput('reminder', placed);
  });
}

function pointer(el: Element, type: string, x: number, y = 10): void {
  el.dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true }),
  );
}

describe('ReminderRow', () => {
  it('shows the text, its time, its repeat, and a mark when Claude added it', async () => {
    const { el } = await renderRow({
      text: 'journal',
      dueAt: Date.parse('2026-10-07T01:00:00Z'),
      createdBy: 'claude',
      recurrence: { freq: 'daily', time: '21:00', tz: 'America/New_York' },
    });
    expect(el.querySelector('.text')?.textContent).toBe('journal');
    expect(el.querySelector('[aria-label="from Claude"]')).toBeTruthy();
    expect(el.querySelector('.when')?.textContent).toMatch(/9:00\sPM · daily/);
  });

  it('shows only the time for something overdue from earlier today', async () => {
    const { el } = await renderRow({ text: 'call the bank', dueAt: NOW - HOUR });
    expect(el.querySelector('.when')?.textContent).toMatch(/^9:00\sAM$/);
  });

  it('links to its note when it has one', async () => {
    const { el } = await renderRow({ text: 'reply to Vikas', noteId: 'n1' });
    expect(el.querySelector('a.text')?.getAttribute('href')).toBe('/?note=n1');
  });

  it('marks done from the button', async () => {
    const { el, reminders } = await renderRow({ text: 'stretch', dueAt: NOW });
    const done = vi.spyOn(reminders, 'done');
    buttonNamed(el, 'Done: stretch')!.click();
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }));
  });

  it('snoozes to a quick choice or a picked time', async () => {
    const { el, reminders, fixture } = await renderRow({ text: 'stretch', dueAt: NOW });
    const snooze = vi.spyOn(reminders, 'snooze');
    const toggle = buttonNamed(el, 'Snooze: stretch')!;
    toggle.click();
    await fixture.whenStable();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect([...el.querySelectorAll('.snooze .pill')].map((b) => b.textContent?.trim())).toEqual([
      'In an hour',
      'Tonight',
      'Tomorrow',
      'Snooze until then',
    ]);
    buttonNamed(el, 'In an hour')!.click();
    expect(snooze).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'r1' }), NOW + HOUR);
    await fixture.whenStable();
    expect(el.querySelector('.snooze')).toBeNull();

    toggle.click();
    await fixture.whenStable();
    const input = el.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    input.value = '2026-10-09T08:30';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    buttonNamed(el, 'Snooze until then')!.click();
    expect(snooze).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'r1' }),
      new Date('2026-10-09T08:30').getTime(),
    );
  });

  it('swallows the click a mouse fires at the end of a swipe', async () => {
    const { el, reminders } = await renderRow({ text: 'stretch', dueAt: NOW });
    const done = vi.spyOn(reminders, 'done');
    const row = el.querySelector('.row')!;
    pointer(row, 'pointerdown', 100);
    pointer(row, 'pointermove', 120);
    pointer(row, 'pointerup', 120);
    buttonNamed(el, 'Done: stretch')!.click();
    expect(done).not.toHaveBeenCalled();
  });

  it('swipes right for done and left for snooze, but not for a short or vertical drag', async () => {
    const { el, reminders, fixture } = await renderRow({ text: 'stretch', dueAt: NOW });
    const done = vi.spyOn(reminders, 'done');
    const row = el.querySelector('.row')!;

    pointer(row, 'pointerdown', 100);
    pointer(row, 'pointermove', 100 + SWIPE_PX / 2);
    pointer(row, 'pointerup', 100 + SWIPE_PX / 2);
    pointer(row, 'pointerdown', 100);
    pointer(row, 'pointermove', 130, 200);
    pointer(row, 'pointerup', 130, 200);
    expect(done).not.toHaveBeenCalled();

    pointer(row, 'pointerdown', 100);
    pointer(row, 'pointermove', 100 + SWIPE_PX);
    pointer(row, 'pointerup', 100 + SWIPE_PX);
    expect(done).toHaveBeenCalledTimes(1);

    pointer(row, 'pointerdown', 200);
    pointer(row, 'pointermove', 200 - SWIPE_PX);
    pointer(row, 'pointerup', 200 - SWIPE_PX);
    await fixture.whenStable();
    expect(el.querySelector('.snooze')).toBeTruthy();

    // On touch no click follows a swipe; the next tap must still work.
    const snooze = vi.spyOn(reminders, 'snooze');
    await new Promise((r) => setTimeout(r));
    buttonNamed(el, 'In an hour')!.click();
    expect(snooze).toHaveBeenCalled();
    TestBed.resetTestingModule();
  });
});
