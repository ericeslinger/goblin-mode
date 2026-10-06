import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { EditorView } from '@codemirror/view';
import { EditorModeService } from './editor-mode.service';
import { NoteEditorComponent } from './note-editor';

@Component({
  imports: [NoteEditorComponent],
  template: `<app-note-editor
    [text]="text()"
    [noteId]="noteId()"
    label="New note"
    autofocus
    (textChange)="changes.push($event)"
  />`,
})
class Host {
  readonly text = signal('- [ ] eggs\n');
  readonly noteId = signal('a');
  readonly changes: string[] = [];
}

async function render() {
  localStorage.clear();
  await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const content = fixture.nativeElement.querySelector('.cm-content') as HTMLElement;
  return { fixture, content };
}

describe('NoteEditorComponent', () => {
  it('shows the text, labelled, with focus', async () => {
    const { content } = await render();
    expect(content.getAttribute('aria-label')).toBe('New note');
    expect(content.textContent).toContain('eggs');
    expect(document.activeElement).toBe(content);
  });

  it('emits the full text when a widget edits it', async () => {
    const { fixture } = await render();
    const box = fixture.nativeElement.querySelector('input.gm-checkbox') as HTMLInputElement;
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

  it('follows the app-wide mode', async () => {
    const { fixture } = await render();
    TestBed.inject(EditorModeService).set('source');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('input.gm-checkbox')).toBeNull();
  });
});
