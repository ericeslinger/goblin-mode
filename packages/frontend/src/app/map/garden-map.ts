import { DatePipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { LinksService } from '../links/links.service';
import { NotesService } from '../notes/notes.service';
import { bedGrid, beds, lanes, plant } from './garden';

const CELL = 240;
const SHOWN_PER_BED = 20;
const LANE_H = 56;
const LEFT = 170;
const WIDTH = 760;

/**
 * The whole garden at /map (#33), two ways: Garden, every concept a bed
 * with the notes that link it planted around it, and Timeline
 * (/map/timeline), notes along when they were made in a lane per
 * concept, filterable to one (?concept=<id>). Every dot opens its note;
 * the same notes are listed under the drawing for keyboards and screen
 * readers. Lazy-loaded.
 */
@Component({
  selector: 'app-garden-map',
  imports: [RouterLink, DatePipe],
  template: `
    <main class="page wide">
      <a routerLink="/">Back</a>
      <h1>Map</h1>
      <nav aria-label="Layouts">
        <a routerLink="/map" [attr.aria-current]="layout() === 'garden' ? 'page' : null">Garden</a>
        <a routerLink="/map/timeline" [attr.aria-current]="layout() === 'timeline' ? 'page' : null"
          >Timeline</a
        >
      </nav>
      @if (!notes.loaded()) {
        <p class="muted" role="status">Loading…</p>
      } @else if (layout() === 'garden') {
        @if (garden().length === 0) {
          <p class="muted">The garden is empty. Plant a note on the launch screen.</p>
        } @else {
          <svg [attr.viewBox]="gardenBox()" aria-hidden="true" class="map">
            @for (bed of placedBeds(); track bed.id) {
              <g class="bed">
                <circle class="plot" [attr.cx]="bed.x" [attr.cy]="bed.y" r="100" />
                @for (p of bed.plants; track p.id) {
                  <g class="node" (click)="open(p.id)">
                    <title>{{ p.title }}</title>
                    <circle class="hit" [attr.cx]="p.x" [attr.cy]="p.y" r="14" />
                    <circle [attr.cx]="p.x" [attr.cy]="p.y" r="6" />
                  </g>
                }
                @if (bed.id) {
                  <g class="node concept" (click)="open(bed.id)">
                    <title>{{ bed.title }}</title>
                    <circle class="hit" [attr.cx]="bed.x" [attr.cy]="bed.y" r="22" />
                    <circle [attr.cx]="bed.x" [attr.cy]="bed.y" r="13" />
                  </g>
                }
                <text class="bed-label" [attr.x]="bed.x" [attr.y]="bed.y + 124">
                  {{ bed.label }}
                </text>
              </g>
            }
          </svg>
          <section aria-labelledby="beds">
            <h2 id="beds">Beds</h2>
            @for (bed of garden(); track bed.id; let i = $index) {
              <h3 [id]="'bed-' + i">
                @if (bed.id) {
                  <a [routerLink]="['/n', bed.id]">{{ bed.title }}</a>
                } @else {
                  {{ bed.title }}
                }
                <span class="muted">{{ bed.notes.length }}</span>
              </h3>
              <ul [attr.aria-labelledby]="'bed-' + i">
                @for (n of bed.notes; track n.id) {
                  <li>
                    <a [routerLink]="['/n', n.id]">{{ n.title || 'Untitled' }}</a>
                  </li>
                }
              </ul>
            }
          </section>
        }
      } @else {
        <label class="filter">
          Show
          <select #pick (change)="filter(pick.value)">
            <option value="" [selected]="!concept()">Every concept</option>
            @for (bed of garden(); track bed.id) {
              @if (bed.id) {
                <option [value]="bed.id" [selected]="bed.id === concept()">{{ bed.title }}</option>
              }
            }
          </select>
        </label>
        @if (timeline().length === 0) {
          <p class="muted">Nothing to show yet.</p>
        } @else {
          <svg
            [attr.viewBox]="'0 0 ' + width + ' ' + timelineHeight()"
            aria-hidden="true"
            class="map"
          >
            @for (lane of placedLanes(); track lane.id) {
              <line
                class="lane"
                [attr.x1]="left"
                [attr.x2]="width - 20"
                [attr.y1]="lane.y"
                [attr.y2]="lane.y"
              />
              <text class="lane-label" x="8" [attr.y]="lane.y + 5">{{ lane.label }}</text>
              @for (d of lane.dots; track d.id) {
                <g class="node" (click)="open(d.id)">
                  <title>{{ d.title }}</title>
                  <circle class="hit" [attr.cx]="d.x" [attr.cy]="lane.y" r="12" />
                  <circle [attr.cx]="d.x" [attr.cy]="lane.y" r="6" />
                </g>
              }
            }
            <text class="axis" [attr.x]="left" [attr.y]="timelineHeight() - 6">
              {{ span().from | date: 'mediumDate' }}
            </text>
            <text class="axis end" [attr.x]="width - 20" [attr.y]="timelineHeight() - 6">
              {{ span().to | date: 'mediumDate' }}
            </text>
          </svg>
          <section aria-labelledby="lanes">
            <h2 id="lanes">Over time</h2>
            @for (lane of timeline(); track lane.id; let i = $index) {
              <h3 [id]="'lane-' + i">{{ lane.title }}</h3>
              <ul [attr.aria-labelledby]="'lane-' + i">
                @for (d of lane.notes; track d.note.id) {
                  <li>
                    <a [routerLink]="['/n', d.note.id]">{{ d.note.title || 'Untitled' }}</a>
                    <span class="muted">{{ d.at | date: 'mediumDate' }}</span>
                  </li>
                }
              </ul>
            }
          </section>
        }
      }
    </main>
  `,
  styles: `
    .wide {
      max-width: 760px;
    }
    nav {
      display: flex;
      gap: var(--space-1);
      margin-bottom: var(--space-3);
    }
    nav a {
      padding: var(--space-1) var(--space-2);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-pill);
      color: var(--ink);
      text-decoration: none;
      font-size: 14px;
    }
    nav a[aria-current='page'] {
      border-color: var(--accent);
      background: var(--chip-bg);
    }
    .map {
      width: 100%;
      height: auto;
      display: block;
    }
    .plot {
      fill: var(--chip-bg);
      stroke: var(--rule);
    }
    .node {
      cursor: pointer;
    }
    .node circle {
      fill: var(--surface);
      stroke: var(--quiet);
      stroke-width: 1.5;
    }
    .node.concept circle {
      fill: var(--accent);
      stroke: var(--accent);
    }
    .node circle.hit {
      fill: transparent;
      stroke: none;
    }
    .lane {
      stroke: var(--rule);
    }
    text {
      fill: var(--ink);
      font-size: 14px;
      text-anchor: middle;
      stroke: var(--bg);
      stroke-width: 4px;
      paint-order: stroke;
    }
    .bed-label {
      font-size: 17px;
    }
    .lane-label,
    .axis {
      text-anchor: start;
    }
    .lane-label {
      font-size: 20px;
    }
    .axis {
      fill: var(--quiet);
      font-size: 18px;
    }
    .axis.end {
      text-anchor: end;
    }
    .filter select {
      font: inherit;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      padding: var(--space-1) var(--space-2);
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 0 0 var(--space-2);
    }
    li {
      padding: 2px 0;
    }
    h3 {
      font-size: 15px;
      margin: var(--space-3) 0 var(--space-1);
    }
    .muted {
      color: var(--quiet);
      font-size: 14px;
      margin-left: var(--space-2);
    }
  `,
})
export class GardenMap {
  protected readonly notes = inject(NotesService);
  private readonly links = inject(LinksService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly width = WIDTH;
  protected readonly left = LEFT;

  protected readonly layout = toSignal(
    this.route.data.pipe(map((d) => (d['layout'] === 'timeline' ? 'timeline' : 'garden'))),
    { initialValue: 'garden' as const },
  );
  protected readonly concept = toSignal(
    this.route.queryParamMap.pipe(map((q) => q.get('concept') ?? undefined)),
  );

  protected readonly garden = computed(() => beds(this.links.graph()));

  protected readonly placedBeds = computed(() => {
    const list = this.garden();
    const grid = bedGrid(list.length, CELL);
    return list.map((bed, i) => {
      const { x, y } = grid[i];
      const shown = bed.notes.slice(0, SHOWN_PER_BED);
      const more = bed.notes.length - shown.length;
      const name = bed.title.length > 22 ? `${bed.title.slice(0, 21)}…` : bed.title;
      return {
        id: bed.id,
        title: bed.title,
        label: more > 0 ? `${name} (+${more})` : name,
        x,
        y,
        plants: shown.map((n, k) => ({
          id: n.id,
          title: n.title || 'Untitled',
          ...plant(k, x, y),
        })),
      };
    });
  });

  protected readonly gardenBox = computed(() => {
    const grid = bedGrid(this.garden().length, CELL);
    const cols = grid[0]?.cols ?? 1;
    const rows = Math.ceil(this.garden().length / cols);
    return `0 0 ${cols * CELL} ${rows * CELL + 12}`;
  });

  protected readonly timeline = computed(() => lanes(this.links.graph(), 6, this.concept()));

  protected readonly span = computed(() => {
    const times = this.timeline().flatMap((l) => l.notes.map((d) => d.at));
    const from = Math.min(...times);
    const to = Math.max(...times);
    return { from, to: to > from ? to : from + 1 };
  });

  protected readonly placedLanes = computed(() => {
    const { from, to } = this.span();
    const scale = (t: number) => LEFT + ((t - from) / (to - from)) * (WIDTH - 20 - LEFT);
    return this.timeline().map((lane, i) => ({
      id: lane.id,
      label: lane.title.length > 13 ? `${lane.title.slice(0, 12)}…` : lane.title,
      y: 40 + i * LANE_H,
      dots: lane.notes.map((d) => ({
        id: d.note.id,
        title: d.note.title || 'Untitled',
        x: scale(d.at),
      })),
    }));
  });

  protected readonly timelineHeight = computed(() => 40 + this.timeline().length * LANE_H + 14);

  protected open(id: string): void {
    void this.router.navigate(['/n', id]);
  }

  protected filter(concept: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { concept: concept || null },
    });
  }
}
