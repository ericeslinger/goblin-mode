import { TestBed } from '@angular/core/testing';
import { ThemePicker } from './theme-picker';
import { PREFERS_DARK, ThemeService } from './theme.service';

async function render() {
  localStorage.clear();
  await TestBed.configureTestingModule({
    imports: [ThemePicker],
    providers: [{ provide: PREFERS_DARK, useValue: null }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ThemePicker);
  await fixture.whenStable();
  return { el: fixture.nativeElement as HTMLElement, fixture };
}

const radio = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll('label')]
    .find((l) => l.textContent?.includes(name))!
    .querySelector('input') as HTMLInputElement;

describe('ThemePicker', () => {
  afterEach(() => localStorage.clear());

  it('offers the five themes and three modes, with the current ones checked', async () => {
    const { el } = await render();
    const names = [...el.querySelectorAll('.name')].map((n) => n.textContent?.trim());
    expect(names).toEqual([
      'Herbarium',
      'Night Garden',
      'Moss and Lantern',
      'Bog Goblin',
      'Pixel Mossling',
    ]);
    expect(radio(el, 'Herbarium').checked).toBe(true);
    expect(radio(el, 'Follow the system').checked).toBe(true);
  });

  it('switches the theme and the mode', async () => {
    const { el, fixture } = await render();
    const service = TestBed.inject(ThemeService);
    radio(el, 'Bog Goblin').click();
    radio(el, 'Dark').click();
    await fixture.whenStable();
    expect(service.theme()).toBe('bog');
    expect(service.mode()).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('bog');
  });
});
