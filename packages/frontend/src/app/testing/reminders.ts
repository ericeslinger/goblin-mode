// Spec-support for the reminder components; never imported from
// production code.
import type { Type } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FakeAuthService, FakeRemindersApi, remindersTestProviders } from './fakes';
import { RemindersService } from '../reminders/reminders.service';

export const HOUR = 60 * 60 * 1000;
/** 2026-10-06 10:00 in New York, a Tuesday. */
export const NOW = Date.parse('2026-10-06T14:00:00Z');

/**
 * Renders a component over the real service and a fake Firestore seam.
 * `before` runs ahead of the first render, to push data or set inputs.
 */
export async function renderWithReminders<T>(
  component: Type<T>,
  before?: (ctx: {
    api: FakeRemindersApi;
    reminders: RemindersService;
    fixture: ComponentFixture<T>;
  }) => void,
) {
  const api = new FakeRemindersApi();
  const auth = new FakeAuthService();
  auth.user.set({ uid: 'u1' } as User);
  await TestBed.configureTestingModule({
    imports: [component],
    providers: [
      provideRouter([]),
      ...remindersTestProviders(api, () => NOW),
      { provide: AuthService, useValue: auth },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(component);
  document.body.appendChild(fixture.nativeElement);
  const reminders = TestBed.inject(RemindersService);
  before?.({ api, reminders, fixture });
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    el,
    auth,
    api,
    reminders,
    /** Delivers a snapshot and waits for the view. */
    async push(docs: Parameters<FakeRemindersApi['push']>[0]) {
      api.push(docs);
      await fixture.whenStable();
    },
  };
}

export function buttonNamed(el: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name,
  );
}
