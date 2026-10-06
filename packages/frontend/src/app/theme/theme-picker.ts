import { Component, inject } from '@angular/core';
import { type ModeChoice, ThemeService } from './theme.service';
import { THEMES, type Theme } from './themes';

/**
 * The Appearance section of Settings: five themes, each previewed in its
 * own colors and fonts, and light, dark or follow the system. Kept on
 * this device for now; #24 saves it per user.
 */
@Component({
  selector: 'app-theme-picker',
  template: `
    <fieldset>
      <legend>Theme</legend>
      @for (theme of themes; track theme.id) {
        <label class="option" [style]="preview(theme)">
          <input
            type="radio"
            name="theme"
            [value]="theme.id"
            [checked]="service.theme() === theme.id"
            (change)="service.set(theme.id)"
          />
          <span class="name">{{ theme.name }}</span>
          <span class="mood">{{ theme.mood }}</span>
          <span class="marks" aria-hidden="true">
            <span class="mark" [style.background]="palette(theme).accent"></span>
            <span class="mark" [style.background]="palette(theme).second"></span>
          </span>
        </label>
      }
    </fieldset>
    <fieldset>
      <legend>Mode</legend>
      @for (mode of modes; track mode.id) {
        <label class="mode">
          <input
            type="radio"
            name="mode"
            [value]="mode.id"
            [checked]="service.mode() === mode.id"
            (change)="service.set(service.theme(), mode.id)"
          />
          {{ mode.label }}
        </label>
      }
    </fieldset>
  `,
  styles: `
    fieldset {
      border: 0;
      margin: 0 0 var(--space-3);
      padding: 0;
    }
    legend {
      font-weight: 600;
      margin-bottom: var(--space-2);
    }
    .option {
      display: grid;
      grid-template-columns: auto 1fr auto;
      grid-template-areas: 'radio name marks' 'radio mood marks';
      column-gap: var(--space-2);
      align-items: center;
      padding: var(--space-2) var(--space-3);
      margin: 0 0 var(--space-2);
      border: var(--option-border) solid var(--option-rule);
      border-radius: var(--option-radius);
      color: var(--option-ink);
      background: var(--option-bg);
      font-family: var(--option-body);
      cursor: pointer;
    }
    .option:has(input:checked) {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .option input {
      grid-area: radio;
      accent-color: var(--option-accent);
    }
    .name {
      grid-area: name;
      font-family: var(--option-heading);
      font-weight: 600;
    }
    .mood {
      grid-area: mood;
      font-size: 14px;
    }
    .marks {
      grid-area: marks;
      display: flex;
      gap: var(--space-1);
    }
    .mark {
      width: 14px;
      height: 14px;
      border-radius: var(--option-radius);
    }
    .mode {
      display: inline-flex;
      gap: var(--space-1);
      margin-right: var(--space-3);
    }
  `,
})
export class ThemePicker {
  protected readonly service = inject(ThemeService);
  protected readonly themes = THEMES;
  protected readonly modes: { id: ModeChoice; label: string }[] = [
    { id: 'system', label: 'Follow the system' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];

  protected palette(theme: Theme) {
    return theme[this.service.shown()];
  }

  /** Each option is drawn in its own theme, in the mode now shown. */
  protected preview(theme: Theme): Record<string, string> {
    const p = this.palette(theme);
    return {
      '--option-bg': p.bg,
      '--option-ink': p.ink,
      '--option-rule': p.rule,
      '--option-accent': p.accent,
      '--option-heading': theme.fonts.heading,
      '--option-body': theme.fonts.body,
      '--option-radius': theme.radius.card,
      '--option-border': theme.border,
    };
  }
}
