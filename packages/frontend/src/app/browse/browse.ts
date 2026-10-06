import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NoteList } from './note-list';

/** All notes and search, on its own screen (the phone). */
@Component({
  selector: 'app-browse',
  imports: [RouterLink, NoteList],
  template: `
    <main class="page">
      <a routerLink="/">Back</a>
      <h1>Notes</h1>
      <app-note-list />
    </main>
  `,
})
export class Browse {}
