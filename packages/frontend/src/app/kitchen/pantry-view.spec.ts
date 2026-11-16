import { TestBed } from '@angular/core/testing';
import { PantryView } from './pantry-view';

async function render(body: string) {
  TestBed.configureTestingModule({ imports: [PantryView] });
  const fixture = TestBed.createComponent(PantryView);
  fixture.componentRef.setInput('body', body);
  const edits: string[] = [];
  fixture.componentInstance.edited.subscribe((b) => {
    edits.push(b);
    fixture.componentRef.setInput('body', b);
  });
  let texts = 0;
  fixture.componentInstance.editText.subscribe(() => texts++);
  await fixture.whenStable();
  return { el: fixture.nativeElement as HTMLElement, fixture, edits, texts: () => texts };
}

const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim();
const headings = (el: HTMLElement) => [...el.querySelectorAll('h2')].map(text);

describe('On hand, to read (#288)', () => {
  const body = '## Produce\n\n## Butcher\n\n## Dry goods\n- rice\n- salt: always\n';

  it('hides a heading with nothing under it, and offers every section to add to', async () => {
    const { el } = await render(body);
    expect(headings(el)).toEqual(['Dry goods']);
    expect([...el.querySelectorAll('ul[aria-label="Dry goods"] li')].map(text)).toEqual([
      'rice',
      'salt: always',
    ]);
    const options = [...el.querySelectorAll('select option')].map(text);
    expect(options).toEqual(['Produce', 'Butcher', 'Dry goods', 'Other']);
  });

  it('adds an item under an empty section, writing only its line', async () => {
    const { el, fixture, edits } = await render(body);
    el.querySelector<HTMLInputElement>('input[name="item"]')!.value = 'limes: 3';
    el.querySelector<HTMLSelectElement>('select')!.value = 'Produce';
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(edits).toEqual([
      '## Produce\n\n- limes: 3\n\n## Butcher\n\n## Dry goods\n- rice\n- salt: always\n',
    ]);
    expect(headings(el)).toEqual(['Produce', 'Dry goods']);
    expect(text(el.querySelector('[role="status"]'))).toBe('Added limes to Produce.');
    expect(el.querySelector<HTMLInputElement>('input[name="item"]')!.value).toBe('');
  });

  it('says an item is on hand already, and changes nothing', async () => {
    const { el, fixture, edits } = await render(body);
    el.querySelector<HTMLInputElement>('input[name="item"]')!.value = 'Rice';
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(edits).toEqual([]);
    expect(text(el.querySelector('[role="status"]'))).toBe('Rice is on hand already.');
  });

  it('shows the lines that are not items, with the way to the text', async () => {
    const { el, fixture, texts } = await render('- [ ] buy more rice\n## Produce\n');
    expect(text(el.querySelector('p.muted'))).toBe('Nothing on hand yet.');
    const extras = el.querySelector('section.extras')!;
    expect([...extras.querySelectorAll('li')].map(text)).toEqual(['buy more rice']);
    extras.querySelector('button')!.click();
    await fixture.whenStable();
    expect(texts()).toBe(1);
  });
});
