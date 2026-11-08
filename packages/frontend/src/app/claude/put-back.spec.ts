import { TestBed } from '@angular/core/testing';
import { ONLINE } from '../platform/platform';
import type { RunRecord } from './activity';
import { PUT_BACK_API, PutBack, type PutBackApi } from './put-back';

const run: RunRecord = {
  id: 'r1',
  at: 1,
  agent: 'Claude',
  tool: 'merge_notes',
  summary: 'Merged 2 notes into one',
  notes: [
    { id: 'm', title: 'Kiln' },
    { id: 'a', title: 'Kiln' },
    { id: 'b', title: 'Firing' },
  ],
  reminders: [],
};

async function render(opts: { online?: boolean; done?: boolean; api?: Partial<PutBackApi> } = {}) {
  let online = opts.online ?? true;
  const api = {
    revert: vi.fn(async (_runId: string) => ({
      status: 'done' as const,
      id: 'putback-r1',
      notes: 3,
    })),
    ...opts.api,
  };
  await TestBed.configureTestingModule({
    imports: [PutBack],
    providers: [
      { provide: PUT_BACK_API, useValue: api },
      { provide: ONLINE, useValue: () => online },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(PutBack);
  fixture.componentRef.setInput('run', run);
  fixture.componentRef.setInput('done', opts.done ?? false);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const button = (name: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent!.trim().startsWith(name))!;
  const text = () => el.textContent!.replace(/\s+/g, ' ').trim();
  return {
    el,
    api,
    fixture,
    button,
    text,
    goOffline: () => (online = false),
    async click(name: string) {
      button(name).click();
      await fixture.whenStable();
    },
  };
}

describe('PutBack (#154 step 1)', () => {
  it('asks in one line, then puts the run back and says how many notes', async () => {
    const { api, click, text, button } = await render();
    expect(button('Put back').getAttribute('aria-label')).toBe('Put back: Merged 2 notes into one');
    await click('Put back');
    expect(text()).toContain('Put back 3 notes?');
    expect(api.revert).not.toHaveBeenCalled();
    await click('Yes');
    expect(api.revert).toHaveBeenCalledWith('r1');
    expect(text()).toContain('Put back 3 notes.');
  });

  it('says No without calling, and Already put back when the server says so', async () => {
    const { api, click, text } = await render({
      api: { revert: vi.fn(async () => ({ status: 'already' as const, id: 'x', notes: 0 })) },
    });
    await click('Put back');
    await click('No');
    expect(text()).not.toContain('?');
    expect(api.revert).not.toHaveBeenCalled();
    await click('Put back');
    await click('Yes');
    expect(text()).toContain('Already put back.');
  });

  it('says why the server refused', async () => {
    const { click, text } = await render({
      api: {
        revert: vi.fn(async () => {
          throw new Error('Its notes have changed since.');
        }),
      },
    });
    await click('Put back');
    await click('Yes');
    expect(text()).toContain('Could not put back: Its notes have changed since.');
  });

  it('says it needs the network when offline, without calling', async () => {
    const { api, click, text, goOffline } = await render();
    goOffline();
    await click('Put back');
    expect(text()).toContain('Putting back needs the network.');
    expect(text()).not.toContain('?');
    expect(api.revert).not.toHaveBeenCalled();
  });

  it('shows a run already put back as done, with no button', async () => {
    const { el, text } = await render({ done: true });
    expect(el.querySelector('button')).toBeNull();
    expect(text()).toBe('Put back');
  });
});
