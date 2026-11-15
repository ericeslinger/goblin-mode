import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PageHeader } from './page-header';

@Component({
  imports: [PageHeader],
  template: `
    <app-page-header [title]="title()" [backLabel]="backLabel()" [backLink]="['/reader', 'feeds']">
      <button type="button" aria-label="Search articles">S</button>
      <a href="/reader/feeds" aria-label="Manage feeds">M</a>
    </app-page-header>
  `,
})
class Host {
  readonly title = signal<string | undefined>('Manage feeds');
  readonly backLabel = signal<string | undefined>('Reader');
}

async function render() {
  TestBed.configureTestingModule({ imports: [Host], providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('PageHeader (#286)', () => {
  it('has the leaf, then the title as the one h1', async () => {
    const { el } = await render();
    const header = el.querySelector('header')!;
    expect(header.querySelector('a[aria-label="Home"]')?.getAttribute('href')).toBe('/home');
    const h1s = el.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe('Manage feeds');
  });

  it('goes back to the parent as "‹ Label", named Back to Label', async () => {
    const { el } = await render();
    const back = el.querySelector('a.back')!;
    expect(back.getAttribute('aria-label')).toBe('Back to Reader');
    expect(back.textContent).toBe('Reader');
    expect(back.querySelector('app-icon')).not.toBeNull();
    expect(back.getAttribute('href')).toBe('/reader/feeds');
  });

  it('has no back link without a parent, nor an h1 without a title', async () => {
    const { fixture, el } = await render();
    fixture.componentInstance.backLabel.set(undefined);
    fixture.componentInstance.title.set(undefined);
    await fixture.whenStable();
    expect(el.querySelector('a.back')).toBeNull();
    expect(el.querySelector('h1')).toBeNull();
    // The leaf stays.
    expect(el.querySelector('a[aria-label="Home"]')).not.toBeNull();
  });

  it('puts the projected actions at the right, after the title', async () => {
    const { el } = await render();
    const actions = el.querySelector('header .actions')!;
    expect([...actions.children].map((c) => c.getAttribute('aria-label'))).toEqual([
      'Search articles',
      'Manage feeds',
    ]);
    const header = el.querySelector('header')!;
    expect(header.lastElementChild).toBe(actions);
    expect(actions.previousElementSibling?.tagName).toBe('H1');
  });
});
