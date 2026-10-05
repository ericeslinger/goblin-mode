import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { isLocalHost } from './firebase';

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
    expect(isLocalHost('mossgoblin.garden')).toBe(false);
    expect(isLocalHost('localhost.mossgoblin.garden')).toBe(false);
  });
});
