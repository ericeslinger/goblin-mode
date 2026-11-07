import { Component, input } from '@angular/core';

/**
 * The end of a shelf (Eric, 2026-11-07): a heading, a line naming the
 * shelf, and a goblin opening an empty box with a fly leaving it. The
 * caught-up page shows it, and so does the article's next pane at the
 * last article, so the slide lands on what it showed. Drawn by hand in
 * the theme's tokens, so it follows light and dark.
 */
@Component({
  selector: 'app-reader-caught-up',
  template: `
    <h1>You are all caught up</h1>
    <p class="line">Nothing more in {{ shelf() }}.</p>
    <svg
      class="goblin"
      role="img"
      aria-label="A goblin opens an empty box, and a fly buzzes out of it"
      viewBox="0 0 240 200"
      width="240"
      height="200"
    >
      <!-- The goblin, behind the box: shoulders and arms, ears, head. -->
      <path class="skin" d="M80 126 C 82 94, 158 94, 160 126 Z" />
      <path class="arm" d="M92 106 L 56 88" />
      <path class="arm" d="M150 108 L 174 126" />
      <path class="arm-skin" d="M92 106 L 56 88" />
      <path class="arm-skin" d="M150 108 L 174 126" />
      <path class="skin" d="M96 64 L 58 46 L 92 82 Z" />
      <path class="skin" d="M144 64 L 182 46 L 148 82 Z" />
      <circle class="skin" cx="120" cy="72" r="30" />
      <circle class="eye" cx="108" cy="66" r="10" />
      <circle class="eye" cx="132" cy="66" r="10" />
      <circle class="pupil" cx="110" cy="68" r="4.5" />
      <circle class="pupil" cx="134" cy="68" r="4.5" />
      <path class="grin" d="M104 84 Q 120 98, 136 84" />
      <path class="tooth" d="M114 87.5 L 117 92 L 120 88.5 Z" />
      <!-- The box: its empty inside, its front and side, its lid held up. -->
      <path class="inside" d="M70 132 L 82 120 L 180 120 L 170 132 Z" />
      <path class="box" d="M70 132 L 170 132 L 170 186 L 70 186 Z" />
      <path class="box" d="M170 132 L 180 120 L 180 172 L 170 186 Z" />
      <path class="box" d="M70 132 L 82 120 L 60 80 L 46 92 Z" />
      <path class="tape" d="M120 132 L 120 186" />
      <!-- Its hands: one on the lid, one on the rim. -->
      <circle class="skin" cx="54" cy="88" r="7" />
      <circle class="skin" cx="174" cy="126" r="7" />
      <!-- The fly's way out of the box, a dashed loop, and the fly at its end. -->
      <path
        class="trail"
        d="M128 126 C 170 118, 214 110, 210 80 C 206 52, 176 64, 186 82 C 196 98, 222 70, 216 44 C 213 32, 220 24, 224 20"
      />
      <g class="fly">
        <ellipse class="wing" cx="221" cy="10" rx="5" ry="3" transform="rotate(-30 221 10)" />
        <ellipse class="wing" cx="230" cy="10" rx="5" ry="3" transform="rotate(30 230 10)" />
        <ellipse class="bug" cx="225" cy="16" rx="4" ry="5" />
      </g>
    </svg>
  `,
  styles: `
    :host {
      display: block;
    }
    h1 {
      overflow-wrap: anywhere;
    }
    .line {
      color: var(--quiet);
    }
    .goblin {
      display: block;
      max-width: 100%;
      height: auto;
      margin: var(--space-4) auto 0;
      color: var(--ink);
      stroke: currentColor;
      stroke-width: 2.5;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .skin {
      fill: color-mix(in srgb, var(--accent) 28%, var(--surface, transparent));
    }
    .eye {
      fill: var(--surface, transparent);
    }
    .pupil,
    .bug {
      fill: currentColor;
      stroke: none;
    }
    .grin,
    .trail,
    .arm,
    .arm-skin {
      fill: none;
    }
    .arm {
      stroke-width: 10;
    }
    .arm-skin {
      stroke: color-mix(in srgb, var(--accent) 28%, var(--surface, transparent));
      stroke-width: 5;
    }
    .tooth {
      fill: var(--surface, transparent);
      stroke-width: 1.5;
    }
    .inside {
      fill: color-mix(in srgb, var(--ink) 55%, var(--surface, transparent));
    }
    .box {
      fill: color-mix(in srgb, var(--quiet) 22%, var(--surface, transparent));
    }
    .tape {
      stroke: var(--quiet);
      stroke-width: 6;
      opacity: 0.4;
    }
    .trail {
      stroke: var(--quiet);
      stroke-width: 1.5;
      stroke-dasharray: 4 5;
      animation: trail 1.2s linear infinite;
    }
    .wing {
      fill: color-mix(in srgb, var(--quiet) 30%, transparent);
      stroke-width: 1;
    }
    .fly {
      animation: buzz 1.6s ease-in-out infinite alternate;
    }
    @keyframes trail {
      to {
        stroke-dashoffset: -18;
      }
    }
    @keyframes buzz {
      from {
        transform: translate(0, 0);
      }
      to {
        transform: translate(-3px, 4px);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .trail,
      .fly {
        animation: none;
      }
    }
  `,
})
export class CaughtUp {
  /** The shelf's name, as its list's heading shows it. */
  readonly shelf = input.required<string>();
}
