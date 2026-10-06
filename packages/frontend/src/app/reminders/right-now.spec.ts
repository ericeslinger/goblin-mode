import type { User } from 'firebase/auth';
import { reminderDoc } from '../testing/fakes';
import { RightNow } from './right-now';
import { HOUR, NOW, buttonNamed, renderWithReminders } from '../testing/reminders';

describe('RightNow', () => {
  it('lists every open reminder under its section, skipping empty ones', async () => {
    const { el, push } = await renderWithReminders(RightNow);
    await push([
      reminderDoc('a', { text: 'call the bank', dueAt: NOW - HOUR }),
      reminderDoc('b', { text: 'card for nephew', dueAt: NOW + 48 * HOUR }),
      reminderDoc('c', { text: 'learn the banjo' }),
    ]);
    const sections = [...el.querySelectorAll('section')].map((s) => [
      s.querySelector('h2')?.textContent,
      [...s.querySelectorAll('.text')].map((t) => t.textContent),
    ]);
    expect(sections).toEqual([
      ['Overdue', ['call the bank']],
      ['Soon', ['card for nephew']],
      ['Someday', ['learn the banjo']],
    ]);
  });

  it('says so when there is nothing at all', async () => {
    const { el, push } = await renderWithReminders(RightNow);
    await push([]);
    expect(el.textContent).toContain('Nothing to tend. The garden is quiet.');
  });

  it('adds a reminder from +, which then closes the form', async () => {
    const { el, api, fixture } = await renderWithReminders(RightNow);
    buttonNamed(el, 'Add a reminder')!.click();
    await fixture.whenStable();
    const text = el.querySelector<HTMLInputElement>('input[name="text"]')!;
    text.value = 'buy stamps';
    text.dispatchEvent(new Event('input'));
    const repeat = el.querySelector<HTMLSelectElement>('select[name="repeat"]')!;
    repeat.value = 'weekly';
    repeat.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(el.textContent).toContain('Starts at 9:00 am.');
    buttonNamed(el, 'Add')!.click();
    await fixture.whenStable();
    expect(api.set.mock.lastCall![2]).toMatchObject({
      text: 'buy stamps',
      recurrence: { freq: 'weekly', time: '09:00' },
    });
    expect(el.querySelector('form')).toBeNull();
  });

  it('waits for sign-in before Add, and shows only sign-in when signed out', async () => {
    const { el, auth, fixture } = await renderWithReminders(RightNow);
    auth.user.set(undefined);
    buttonNamed(el, 'Add a reminder')!.click();
    await fixture.whenStable();
    const text = el.querySelector<HTMLInputElement>('input[name="text"]')!;
    text.value = 'buy stamps';
    text.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(buttonNamed(el, 'Add')!.disabled).toBe(true);
    auth.user.set({ uid: 'u1' } as User);
    await fixture.whenStable();
    expect(buttonNamed(el, 'Add')!.disabled).toBe(false);

    auth.user.set(null);
    await fixture.whenStable();
    expect(el.querySelector('app-sign-in')).toBeTruthy();
    expect(el.querySelector('app-add-reminder')).toBeNull();
  });

  it('closes the form on Cancel without adding', async () => {
    const { el, api, fixture } = await renderWithReminders(RightNow);
    buttonNamed(el, 'Add a reminder')!.click();
    await fixture.whenStable();
    buttonNamed(el, 'Cancel')!.click();
    await fixture.whenStable();
    expect(el.querySelector('form')).toBeNull();
    expect(api.set).not.toHaveBeenCalled();
  });
});
