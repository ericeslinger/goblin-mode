import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FIREBASE } from '../firebase';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { ONLINE } from '../platform/platform';
import { FakeNotes, fakeFirebase, noteRecord } from '../testing/fakes';
import { SHARES_API, type SharedDoc, ShareControls, shareLink } from './share-controls';
import { SharedLinks } from './shared-links';

const SHARE = 'AbCdEfGhIjKlMnOpQrStUvWxYz012-_9';

/** A stand-in share listener: `push` is the share's document as the device has it. */
function sharesApi() {
  let next: (shared: SharedDoc) => void = () => undefined;
  const api = {
    watched: [] as string[],
    stopped: 0,
    watch: vi.fn((_db: unknown, path: string, fn: (shared: SharedDoc) => void) => {
      api.watched.push(path);
      next = fn;
      return () => void api.stopped++;
    }),
    push: (shared: SharedDoc) => next(shared),
  };
  return api;
}

async function render(note: NoteRecord, { online = true } = {}) {
  const notes = new FakeNotes();
  notes.offline = !online;
  notes.signIn([note]);
  const api = sharesApi();
  TestBed.configureTestingModule({
    imports: [ShareControls],
    providers: [
      { provide: NotesService, useValue: notes },
      { provide: SHARES_API, useValue: api },
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: ONLINE, useValue: () => online },
    ],
  });
  const fixture = TestBed.createComponent(ShareControls);
  fixture.componentRef.setInput('note', note);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  /** The note as the notes now hold it, given to the controls again. */
  const refresh = async () => {
    fixture.componentRef.setInput('note', notes.find(note.id)!);
    await fixture.whenStable();
  };
  const button = (name: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  return { el, notes, api, fixture, refresh, button };
}

const glaze = (): NoteRecord => ({ ...noteRecord('n1', 'Glaze\nTwo parts'), title: 'Glaze' });

describe('ShareControls (2026-11-26)', () => {
  it('offers Share a copy, saying what goes and what does not', async () => {
    const { el, notes, button, refresh } = await render(glaze());
    expect(el.textContent).toContain('only people you send it to can find');
    expect(el.textContent).toContain('Not its tags, links, history');
    button('Share a copy')!.click();
    expect(notes.share).toHaveBeenCalledWith('n1');
    await refresh();
    expect(el.textContent).toContain('Anyone with the link can read this copy');
    expect(el.textContent).toContain('It is not listed anywhere.');
    expect(button('Copy link')).toBeTruthy();
    expect(button('Stop sharing')).toBeTruthy();
  });

  it('says why a note cannot be shared, with no button', async () => {
    const { el, notes, button, fixture } = await render(glaze());
    notes.shareRefusal.mockReturnValue(
      'This note is sealed and its key is not on this device yet.',
    );
    fixture.componentRef.setInput('note', { ...glaze() });
    await fixture.whenStable();
    expect(el.textContent).toContain('This note is sealed and its key is not on this device yet.');
    expect(button('Share a copy')).toBeUndefined();
  });

  it('shows the link on this origin, and watches the copy', async () => {
    const { el, api } = await render({ ...glaze(), shareId: SHARE });
    const link = el.querySelector<HTMLAnchorElement>('a[aria-label="The shared link"]')!;
    expect(link.href).toBe(shareLink(location.origin, SHARE));
    expect(link.href).toMatch(new RegExp(`/s/${SHARE}$`));
    expect(link.rel).toBe('noopener noreferrer');
    expect(api.watched).toEqual([`shares/${SHARE}`]);
  });

  it('offers Update the shared copy only when the note says something the copy does not', async () => {
    const { el, api, notes, button, fixture } = await render({ ...glaze(), shareId: SHARE });
    api.push({ kind: 'note', title: 'Glaze', body: 'Two parts' });
    await fixture.whenStable();
    expect(button('Update the shared copy')!.disabled).toBe(true);
    expect(el.textContent).toContain('Later edits stay here until you update it.');
    // Edited since: the copy still shows it as it was.
    fixture.componentRef.setInput('note', {
      ...glaze(),
      body: 'Glaze\nThree parts',
      shareId: SHARE,
    });
    await fixture.whenStable();
    expect(button('Update the shared copy')!.disabled).toBe(false);
    expect(el.textContent).toContain('the copy shows it as it was');
    button('Update the shared copy')!.click();
    expect(notes.updateShare).toHaveBeenCalledWith('n1');
    await fixture.whenStable();
    expect(el.textContent).toContain('The shared copy now shows the note as it is.');
  });

  it('stops sharing, saying a new share is a new link', async () => {
    const { el, notes, button, refresh } = await render({ ...glaze(), shareId: SHARE });
    button('Stop sharing')!.click();
    expect(notes.stopShare).toHaveBeenCalledWith('n1');
    await refresh();
    expect(el.textContent).toContain('sharing again makes a new link');
    expect(button('Share a copy')).toBeTruthy();
  });

  it('says a share made offline works once the server has it', async () => {
    const { el, button, refresh } = await render(glaze(), { online: false });
    button('Share a copy')!.click();
    await refresh();
    expect(el.textContent).toContain('the link works once this device is back online');
  });

  it('never says an offline stop is done: the copy is still public until the server has it (review of #343)', async () => {
    const { el, notes, button, refresh, fixture } = await render(
      { ...glaze(), shareId: SHARE },
      { online: false },
    );
    button('Stop sharing')!.click();
    await refresh();
    expect(el.textContent).toContain('Still public.');
    expect(el.textContent).toContain('until this device is back online');
    expect(el.textContent).not.toContain('answers nothing');
    expect(button('Share a copy')).toBeUndefined();
    // The server has it: now it is said to be stopped.
    notes.sharesWaiting.set({});
    await fixture.whenStable();
    expect(el.textContent).toContain('Stopped. The link answers nothing now');
    expect(el.textContent).not.toContain('Still public.');
  });

  it('never says an offline update is shown yet', async () => {
    const { el, notes, button, fixture, api } = await render(
      { ...glaze(), body: 'Glaze\nThree parts', shareId: SHARE },
      { online: false },
    );
    api.push({ kind: 'note', title: 'Glaze', body: 'Two parts' });
    await fixture.whenStable();
    button('Update the shared copy')!.click();
    await fixture.whenStable();
    expect(el.textContent).toContain('the link still shows the copy as it was');
    expect(el.textContent).not.toContain('now shows the note as it is');
    notes.sharesWaiting.set({});
    await fixture.whenStable();
    expect(el.textContent).toContain('The shared copy now shows the note as it is.');
  });

  it('says a copy it cannot read could not be read, never that it is gone', async () => {
    const { el, api, fixture, button } = await render({ ...glaze(), shareId: SHARE });
    api.push('gone');
    await fixture.whenStable();
    expect(el.textContent).toContain('This copy could not be read here.');
    expect(el.textContent).not.toMatch(/not there any more|answers nothing/);
    expect(button('Copy link')).toBeUndefined();
    expect(button('Stop sharing')).toBeTruthy();
  });

  it('copies the link, or says it when the clipboard refuses', async () => {
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    const { el, button, fixture } = await render({ ...glaze(), shareId: SHARE });
    button('Copy link')!.click();
    await fixture.whenStable();
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith(shareLink(location.origin, SHARE));
    await fixture.whenStable();
    expect(el.textContent).toContain('Link copied.');
  });
});

describe('SharedLinks (Settings, 2026-11-26)', () => {
  async function renderList(list: NoteRecord[]) {
    const notes = new FakeNotes();
    notes.signIn(list);
    TestBed.configureTestingModule({
      imports: [SharedLinks],
      providers: [provideRouter([]), { provide: NotesService, useValue: notes }],
    });
    const fixture = TestBed.createComponent(SharedLinks);
    await fixture.whenStable();
    return { el: fixture.nativeElement as HTMLElement, notes, fixture };
  }

  it('lists every shared note with its link and Stop sharing', async () => {
    const { el, notes, fixture } = await renderList([
      { ...glaze(), shareId: SHARE },
      { ...noteRecord('n2', 'Private'), title: 'Private' },
    ]);
    const items = [...el.querySelectorAll('li')];
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Glaze');
    expect(items[0].textContent).toContain(`/s/${SHARE}`);
    expect(el.textContent).not.toContain('Private');
    el.querySelector<HTMLButtonElement>('button[aria-label="Stop sharing Glaze"]')!.click();
    expect(notes.stopShare).toHaveBeenCalledWith('n1');
    await fixture.whenStable();
    expect(el.textContent).toContain('Stopped sharing Glaze.');
    expect(el.textContent).toContain('Nothing is shared.');
  });

  it('lists a stop the server does not have yet as still public (review of #343)', async () => {
    const { el, notes, fixture } = await renderList([{ ...glaze(), shareId: SHARE }]);
    notes.offline = true;
    el.querySelector<HTMLButtonElement>('button[aria-label="Stop sharing Glaze"]')!.click();
    await fixture.whenStable();
    expect(el.textContent).toContain('Still public');
    expect(el.textContent).toContain(`/s/${SHARE}`);
    expect(el.textContent).not.toContain('Stopped sharing Glaze.');
    expect(el.textContent).not.toContain('Nothing is shared.');
    notes.sharesWaiting.set({});
    await fixture.whenStable();
    expect(el.textContent).toContain('Stopped sharing Glaze.');
    expect(el.textContent).not.toContain('Still public');
  });

  it('says when nothing is shared', async () => {
    const { el } = await renderList([glaze()]);
    expect(el.textContent).toContain('Nothing is shared.');
  });
});

describe('PublicPageRoute: /s/<id> is the Worker’s, never the app’s', () => {
  it('hands the address back to the network past the service worker, once', async () => {
    const { PublicPageRoute, leaveFor } = await import('./public-page-route');
    const left = vi.spyOn(leaveFor, 'run').mockImplementation(() => undefined);
    history.replaceState(null, '', `/s/${SHARE}`);
    TestBed.configureTestingModule({ imports: [PublicPageRoute] });
    let fixture = TestBed.createComponent(PublicPageRoute);
    await fixture.whenStable();
    expect(left).toHaveBeenCalledWith(`/s/${SHARE}?ngsw-bypass=1`);
    expect(fixture.nativeElement.textContent).toContain('Opening the shared copy');
    // Answered by the app again: it says so, and does not go round.
    left.mockClear();
    history.replaceState(null, '', `/s/${SHARE}?ngsw-bypass=1`);
    fixture = TestBed.createComponent(PublicPageRoute);
    await fixture.whenStable();
    expect(left).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('It opens on the app');
    history.replaceState(null, '', '/');
    left.mockRestore();
  });
});

describe('shareCopyOf', () => {
  it('shows the title once: a first line that is the title is left out of the body', async () => {
    const { shareCopyOf, withoutTitleLine } = await import('./share-copy');
    expect(withoutTitleLine('Glaze\nTwo parts', 'Glaze')).toBe('Two parts');
    expect(withoutTitleLine('# Glaze\n\nTwo parts', 'Glaze')).toBe('Two parts');
    expect(withoutTitleLine('Glazes\nTwo parts', 'Glaze')).toBe('Glazes\nTwo parts');
    expect(shareCopyOf({ ...glaze(), body: 'Glaze\n[[Feldspar]] two parts' })).toEqual({
      kind: 'note',
      title: 'Glaze',
      body: 'Feldspar two parts',
    });
    expect(shareCopyOf({ ...glaze(), kind: 'concept' })).toBeUndefined();
    expect(shareCopyOf({ ...glaze(), locked: true })).toBeUndefined();
  });
});
