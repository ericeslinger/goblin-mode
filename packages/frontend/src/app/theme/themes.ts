// The five style directions (UX Spec, Brand and style; Eric chose all
// five, switchable, 2026-10-06). This file is the only place colors,
// fonts and shapes are written down: ThemeService copies the active
// theme's tokens onto <html> as custom properties, and components read
// only those properties.

import { ThemeId } from '@mossgoblin/schema';

export { ThemeId };
/** The ids live in the schema, so stored settings and the rules agree. */
export const THEME_IDS = ThemeId.options;
export type Mode = 'light' | 'dark';

/** Colors as #rrggbb. Text pairs are held to WCAG AA by themes.spec.ts. */
export interface Palette {
  /** The page. */
  bg: string;
  /** Cards, inputs and sheets that sit on the page. */
  surface: string;
  /** Body text. */
  ink: string;
  /** Secondary text: dates, hints, metadata. */
  quiet: string;
  /** Hairlines and borders; decoration, not text. */
  rule: string;
  /** Links, the primary button, focus rings. */
  accent: string;
  /** Text on an accent fill. */
  onAccent: string;
  /** The direction's second color, for marks and fills only. */
  second: string;
  /** Status dots: synced. */
  good: string;
  /** Status dots: offline. */
  warn: string;
}

export interface Theme {
  id: ThemeId;
  name: string;
  /** One line for the picker. */
  mood: string;
  light: Palette;
  dark: Palette;
  fonts: { heading: string; body: string; mono: string };
  /** Corner radii: cards and sheets, inputs and buttons, chips and pills. */
  radius: { card: string; control: string; pill: string };
  /** Border width for controls and cards. */
  border: string;
}

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export const THEMES: readonly Theme[] = [
  {
    id: 'herbarium',
    name: 'Herbarium',
    mood: 'A naturalist’s field notebook: pressed paper, specimen labels',
    light: {
      bg: '#faf8f2',
      surface: '#fffdf8',
      ink: '#161616',
      quiet: '#595954',
      rule: '#d8d4c8',
      accent: '#b23a2e',
      onAccent: '#fffdf8',
      second: '#6f8f72',
      good: '#4f8156',
      warn: '#b7791f',
    },
    dark: {
      bg: '#121311',
      surface: '#1a1b18',
      ink: '#eae7de',
      quiet: '#a4a096',
      rule: '#34352f',
      accent: '#e07a6b',
      onAccent: '#121311',
      second: '#8fb092',
      good: '#8fc496',
      warn: '#e0a94f',
    },
    fonts: {
      heading: `"Source Serif 4 Variable", ${SERIF}`,
      body: `"Source Serif 4 Variable", ${SERIF}`,
      mono: `"IBM Plex Mono", ${MONO}`,
    },
    radius: { card: '0', control: '0', pill: '2px' },
    border: '1px',
  },
  {
    id: 'night',
    name: 'Night Garden',
    mood: 'Lofi dusk: rain, a lamp on, fireflies',
    light: {
      bg: '#eeeaf6',
      surface: '#f7f5fb',
      ink: '#24213a',
      quiet: '#59547a',
      rule: '#d3cde6',
      accent: '#5f52a6',
      onAccent: '#f7f5fb',
      second: '#e8b64c',
      good: '#3f8a63',
      warn: '#a87510',
    },
    dark: {
      bg: '#16152a',
      surface: '#1f1d38',
      ink: '#dad6ee',
      quiet: '#a09bc2',
      rule: '#34325a',
      accent: '#b3a8f0',
      onAccent: '#16152a',
      second: '#e8b64c',
      good: '#7fd1a4',
      warn: '#f0c060',
    },
    fonts: {
      heading: `"Nunito Variable", ${SANS}`,
      body: `"Nunito Variable", ${SANS}`,
      mono: `"JetBrains Mono Variable", ${MONO}`,
    },
    radius: { card: '16px', control: '10px', pill: '999px' },
    border: '1px',
  },
  {
    id: 'moss',
    name: 'Moss and Lantern',
    mood: 'Cottagecore: a kitchen garden, tea and lamplight',
    light: {
      bg: '#f6f0e1',
      surface: '#fbf7ec',
      ink: '#2b2a22',
      quiet: '#655e4d',
      rule: '#d9cfb6',
      accent: '#46703a',
      onAccent: '#fbf7ec',
      second: '#c98a2e',
      good: '#4e8a43',
      warn: '#b7791f',
    },
    dark: {
      bg: '#1e2119',
      surface: '#262a20',
      ink: '#ede6d3',
      quiet: '#aba48f',
      rule: '#3c4033',
      accent: '#9cc27f',
      onAccent: '#1e2119',
      second: '#e0a84e',
      good: '#8fcb8a',
      warn: '#e6b05a',
    },
    fonts: {
      heading: `"Fraunces Variable", ${SERIF}`,
      body: `"Literata Variable", ${SERIF}`,
      mono: `"JetBrains Mono Variable", ${MONO}`,
    },
    radius: { card: '12px', control: '8px', pill: '999px' },
    border: '1px',
  },
  {
    id: 'bog',
    name: 'Bog Goblin',
    mood: 'Goblincore: damp, earthy, a hoard of found treasures',
    light: {
      bg: '#e9e4d4',
      surface: '#f2eee2',
      ink: '#2a1f17',
      quiet: '#5a4f41',
      rule: '#cbc1a7',
      accent: '#4f6b1a',
      onAccent: '#f2eee2',
      second: '#a0522d',
      good: '#5f7f22',
      warn: '#b5652c',
    },
    dark: {
      bg: '#17130f',
      surface: '#211b15',
      ink: '#e4dcc6',
      quiet: '#a89d86',
      rule: '#3a3128',
      accent: '#b5c94a',
      onAccent: '#17130f',
      second: '#d08159',
      good: '#b5c94a',
      warn: '#e3a55b',
    },
    fonts: {
      heading: `"Bricolage Grotesque Variable", ${SANS}`,
      body: `"Atkinson Hyperlegible", ${SANS}`,
      mono: `"JetBrains Mono Variable", ${MONO}`,
    },
    radius: { card: '10px 6px 10px 4px', control: '6px 4px 6px 4px', pill: '999px' },
    border: '1.5px',
  },
  {
    id: 'pixel',
    name: 'Pixel Mossling',
    mood: 'A cozy 16-bit garden tended by a small sprite',
    light: {
      bg: '#f3f6e8',
      surface: '#fbfcf5',
      ink: '#1f2a1c',
      quiet: '#4e5a49',
      rule: '#bfc9ae',
      accent: '#2e7a3c',
      onAccent: '#fbfcf5',
      second: '#2f6fb8',
      good: '#3e9b4f',
      warn: '#a87510',
    },
    dark: {
      bg: '#141b12',
      surface: '#1c2519',
      ink: '#e3ead3',
      quiet: '#9fab93',
      rule: '#344230',
      accent: '#7bd389',
      onAccent: '#141b12',
      second: '#7fb2f0',
      good: '#7bd389',
      warn: '#f0c060',
    },
    fonts: {
      heading: `"Pixelify Sans Variable", ${MONO}`,
      body: `"Inter Variable", ${SANS}`,
      mono: `"JetBrains Mono Variable", ${MONO}`,
    },
    radius: { card: '0', control: '0', pill: '0' },
    border: '2px',
  },
];

/** The theme a new device starts on. */
export const DEFAULT_THEME: ThemeId = 'herbarium';

export function themeById(id: string | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
}

/** The custom properties one theme sets, in one mode. */
export function tokensFor(theme: Theme, mode: Mode): Record<string, string> {
  const p = theme[mode];
  return {
    '--bg': p.bg,
    '--surface': p.surface,
    '--ink': p.ink,
    '--quiet': p.quiet,
    '--rule': p.rule,
    '--accent': p.accent,
    '--on-accent': p.onAccent,
    '--second': p.second,
    '--good': p.good,
    '--warn': p.warn,
    '--font-heading': theme.fonts.heading,
    '--font-body': theme.fonts.body,
    '--font-mono': theme.fonts.mono,
    '--radius-card': theme.radius.card,
    '--radius-control': theme.radius.control,
    '--radius-pill': theme.radius.pill,
    '--border': theme.border,
  };
}

/** WCAG relative luminance of a #rrggbb color. */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio of two #rrggbb colors, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
