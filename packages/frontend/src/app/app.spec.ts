import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { AuthService } from './auth.service';
import { configFor, isLocalHost } from './firebase';
import { NoteKeyService } from './notes/note-key.service';
import { FakeAuthService } from './testing/fakes';

describe('App', () => {
  it('creates', async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        // The key-wait line asks whether the key service is set up (2026-11-15).
        { provide: NoteKeyService, useValue: { unconfigured: signal(false) } },
        // The rail (#289) asks whether anyone is signed in.
        { provide: AuthService, useValue: new FakeAuthService() },
      ],
    }).compileComponents();
    expect(TestBed.createComponent(App).componentInstance).toBeTruthy();
  });
});

describe('isLocalHost', () => {
  it('treats only loopback hosts as local', () => {
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('notes.example.com')).toBe(false);
    expect(isLocalHost('localhost.example.com')).toBe(false);
  });
});

describe('configFor', () => {
  it('uses the demo emulator project on localhost', () => {
    expect(configFor('localhost').projectId).toBe('demo-mossgoblin');
    expect(configFor('127.0.0.1').projectId).toBe('demo-mossgoblin');
  });

  it('uses the real project everywhere else', () => {
    const deployed = { projectId: 'someones-goblin', apiKey: 'k' };
    expect(configFor('notes.example.com', deployed)).toBe(deployed);
  });

  it('refuses to start a build with no deployed config off localhost', () => {
    expect(() => configFor('notes.example.com', null)).toThrow(/no Firebase config/);
  });
});
