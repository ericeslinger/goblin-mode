import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { EditorView } from '@codemirror/view';
import { AttachmentsService } from '../attachments/attachments.service';
import { FakeAttachments } from '../testing/fakes';
import { EditorModeService } from './editor-mode.service';
import { keyLabel, NoteEditorComponent } from './note-editor';

@Component({
  imports: [NoteEditorComponent],
  template: `<app-note-editor
    [text]="text()"
    [noteId]="noteId()"
    [base]="base()"
    label="New note"
    autofocus
    (textChange)="changes.push($event)"
  />`,
})
class Host {
  readonly text = signal('- [ ] eggs\n');
  readonly noteId = signal('a');
  readonly base = signal<string | undefined>(undefined);
  readonly changes: string[] = [];
}

async function render() {
  localStorage.clear();
  await TestBed.configureTestingModule({
    imports: [Host],
    providers: [{ provide: AttachmentsService, useValue: new FakeAttachments() }],
  }).compileComponents();
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const content = fixture.nativeElement.querySelector('.cm-content') as HTMLElement;
  return { fixture, content };
}

describe('keyLabel', () => {
  it('names the key the way this keyboard shows it', () => {
    expect(keyLabel('Mod+B', false)).toBe('Ctrl+B');
    expect(keyLabel('Mod+B', true)).toBe('⌘B');
  });
});

// The test DOM has no layout: CodeMirror measures ranges when it scrolls
// to an inserted image.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

describe('NoteEditorComponent', () => {
  it('puts a chosen photo in the note before its file is kept (#44)', async () => {
    const { fixture } = await render();
    const fake = TestBed.inject(AttachmentsService) as unknown as FakeAttachments;
    let keep!: () => void;
    fake.attach.mockImplementation(() => new Promise<void>((done) => (keep = done)));
    const input = fixture.nativeElement.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File(['x'], 'menu.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(fake.attach).toHaveBeenCalled());
    // In the note once its bytes are read, while the file is still being kept.
    expect(fixture.componentInstance.changes.at(-1)).toContain('![menu](attachment:img1)');
    expect(fake.attach).toHaveBeenCalledWith(file, 'img1', 'image/png', 'a');
    keep();
  });

  it('gives a mouse a toolbar with one tab stop, moved by arrow keys', async () => {
    const { fixture } = await render();
    fixture.detectChanges();
    const buttons = [
      ...fixture.nativeElement.querySelectorAll('[role=toolbar] button'),
    ] as HTMLButtonElement[];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toContain('Bulleted list');
    expect(buttons.map((b) => b.tabIndex)).toEqual(buttons.map((_, i) => (i === 0 ? 0 : -1)));
    buttons[0].focus();
    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    fixture.detectChanges();
    const last = buttons.length - 1;
    expect(document.activeElement).toBe(buttons[last]);
    expect(buttons[last].tabIndex).toBe(0);
    expect(buttons[0].tabIndex).toBe(-1);
  });

  it('shows the text, labelled, with focus', async () => {
    const { content } = await render();
    expect(content.getAttribute('aria-label')).toBe('New note');
    expect(content.textContent).toContain('eggs');
    expect(document.activeElement).toBe(content);
  });

  it('emits the full text when a widget edits it', async () => {
    const { fixture } = await render();
    const box = fixture.nativeElement.querySelector('input.mg-checkbox') as HTMLInputElement;
    expect(box).toBeTruthy();
    box.click();
    expect(fixture.componentInstance.changes.at(-1)).toBe('- [x] eggs\n');
  });

  it('reloads when another note opens, even with the same text', async () => {
    const { fixture, content } = await render();
    const host = fixture.componentInstance;
    host.text.set('');
    host.noteId.set('b');
    await fixture.whenStable();
    expect(content.textContent).toBe('');

    // Type into note b. The text input stays '' (it changes only when a
    // note is opened), then an empty note c opens: only the id changes.
    const editor = fixture.debugElement.query(By.directive(NoteEditorComponent))
      .componentInstance as unknown as { editor: { view: EditorView } };
    editor.editor.view.dispatch({ changes: { from: 0, insert: 'typed' } });
    expect(content.textContent).toBe('typed');
    host.noteId.set('c');
    await fixture.whenStable();
    expect(content.textContent).toBe('');
  });

  it('shows a note loaded ahead of its inputs, and keeps what is typed before they arrive', async () => {
    const { fixture, content } = await render();
    const host = fixture.componentInstance;
    const editor = fixture.debugElement.query(By.directive(NoteEditorComponent))
      .componentInstance as unknown as {
      load: (id: string, text: string) => void;
      editor: { view: EditorView };
    };
    editor.load('b', '');
    expect(content.textContent).toBe('');
    // A key lands before the next render brings the inputs for b.
    editor.editor.view.dispatch({ changes: { from: 0, insert: 'F' } });
    host.text.set('');
    host.noteId.set('b');
    await fixture.whenStable();
    expect(content.textContent).toBe('F');
  });

  it('merges a change from elsewhere in place, keeping keys typed since', async () => {
    const { fixture, content } = await render();
    const host = fixture.componentInstance;
    const editor = fixture.debugElement.query(By.directive(NoteEditorComponent))
      .componentInstance as unknown as { editor: { view: EditorView } };
    const view = editor.editor.view;
    // The host merged a remote line into '- [ ] eggs\n', but a key was
    // typed at the end before the editor heard of it.
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'm' } });
    const cursor = view.state.selection.main.head;
    host.base.set('- [ ] eggs\n');
    host.text.set('- [ ] bread\n- [ ] eggs\n');
    await fixture.whenStable();
    expect(content.textContent).toContain('bread');
    expect(view.state.doc.toString()).toBe('- [ ] bread\n- [ ] eggs\nm');
    expect(view.state.selection.main.head).toBe(cursor + '- [ ] bread\n'.length);
    expect(host.changes.at(-1)).toBe('- [ ] bread\n- [ ] eggs\nm');
  });

  it('follows the app-wide mode', async () => {
    const { fixture } = await render();
    TestBed.inject(EditorModeService).set('source');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('input.mg-checkbox')).toBeNull();
  });
});
