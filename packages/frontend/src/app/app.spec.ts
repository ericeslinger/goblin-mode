import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { configFor, isLocalHost } from './firebase';

describe('App', () => {
  it('creates', async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
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
