import { TestBed } from '@angular/core/testing';
import { pantryItems } from '@mossgoblin/schema';
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

  it('shows a heading holding only lines that are not items, with them (2026-11-16)', async () => {
    const { el, fixture, texts } = await render(
      '## Freezer\n- [ ] defrost bread\n## Produce\n## Notes\n---\n',
    );
    // Freezer shows with its line; Produce, with nothing, does not;
    // Notes holds only a rule, so it shows and the rule is counted.
    expect(headings(el)).toEqual(['Freezer', 'Notes']);
    expect([...el.querySelectorAll('ul[aria-label="Freezer"] li')].map(text)).toEqual([
      'defrost bread',
    ]);
    const more = el.querySelector('p.wordless')!;
    expect(text(more)).toBe('1 more line without words · Edit as text');
    more.querySelector('button')!.click();
    await fixture.whenStable();
    expect(texts()).toBe(1);
    // Add to still offers Produce.
    expect([...el.querySelectorAll('select option')].map(text)).toContain('Produce');
  });

  // What Add to writes reads back as the same item and amount: both
  // split at the last colon (`itemText`), a colon left in the name a
  // space, as update_pantry writes it (2026-11-16).
  const TYPED: [typed: string, item: string, amount: string | undefined, always: boolean][] = [
    ['limes', 'limes', undefined, false],
    ['rice: half a bag', 'rice', 'half a bag', false],
    ['rice: half: a bag', 'rice half', 'a bag', false],
    ['salt: always', 'salt', undefined, true],
    ['tea: green: always', 'tea green', undefined, true],
  ];
  it.each(TYPED)('reads back what Add to wrote for “%s”', async (typed, item, amount, always) => {
    const { el, fixture, edits } = await render('## Dry goods\n');
    el.querySelector<HTMLInputElement>('input[name="item"]')!.value = typed;
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    const [read] = pantryItems(edits[0]);
    expect({ item: read.item, amount: read.amount, always: read.always }).toEqual({
      item,
      amount,
      always,
    });
    expect(text(el.querySelector('[role="status"]'))).toBe(`Added ${item} to Dry goods.`);
  });
});
