import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { neighborhood } from '@mossgoblin/schema';
import { map } from 'rxjs';
import { LinksService } from '../links/links.service';
import { NotesService } from '../notes/notes.service';
import { radial } from './layout';

const SIZE = 600;

/**
 * The neighborhood of a note or concept (#32): what it links and what
 * links it, two links out, drawn as rings. Every node opens its note at
 * /n/<id>, so back returns here; the same notes are listed under the
 * drawing for keyboards and screen readers. Lazy-loaded: capture never
 * pays for it.
 */
@Component({
  selector: 'app-neighborhood-map',
  imports: [RouterLink],
  template: `
    <main class="page wide">
      <a [routerLink]="['/n', id()]">Back to the note</a>
      <h1>Around {{ title(id()) }}</h1>
      @if (placed().length <= 1) {
        <p class="muted">Nothing links here yet. Link a name with [[ to grow the map.</p>
      } @else {
        <svg [attr.viewBox]="viewBox()" aria-hidden="true" class="map">
          @for (e of lines(); track e.key) {
            <line [attr.x1]="e.x1" [attr.y1]="e.y1" [attr.x2]="e.x2" [attr.y2]="e.y2" />
          }
          @for (n of placed(); track n.id) {
            <g
              class="node"
              [class.center]="n.hop === 0"
              [class.concept]="isConcept(n.id)"
              (click)="open(n.id)"
            >
              <circle [attr.cx]="n.x" [attr.cy]="n.y" [attr.r]="radius(n)" />
              <text [attr.x]="n.x" [attr.y]="n.y + radius(n) + 16">{{ short(n.id) }}</text>
            </g>
          }
        </svg>
        <section aria-labelledby="nearby">
          <h2 id="nearby">Nearby</h2>
          <h3 id="direct">Linked directly</h3>
          <ul aria-labelledby="direct">
            @for (n of ring(1); track n.id) {
              <li>
                <a [routerLink]="['/n', n.id]">{{ title(n.id) }}</a>
              </li>
            }
          </ul>
          @if (ring(2).length > 0) {
            <h3 id="two-away">Two links away</h3>
            <ul aria-labelledby="two-away">
              @for (n of ring(2); track n.id) {
                <li>
                  <a [routerLink]="['/n', n.id]">{{ title(n.id) }}</a>
                  <span class="muted via">through {{ title(n.via!) }}</span>
                </li>
              }
            </ul>
          }
        </section>
      }
    </main>
  `,
  styles: `
    .wide {
      max-width: 760px;
    }
    .map {
      width: 100%;
      height: auto;
      display: block;
    }
    line {
      stroke: var(--rule);
      stroke-width: 1.5;
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
      fill: var(--chip-bg);
      stroke: var(--accent);
    }
    .node.center circle {
      fill: var(--accent);
      stroke: var(--accent);
    }
    text {
      fill: var(--ink);
      font-size: 14px;
      text-anchor: middle;
      /* A halo in the page color keeps labels clear of the lines. */
      stroke: var(--bg);
      stroke-width: 4px;
      paint-order: stroke;
    }
    .via {
      margin-left: var(--space-2);
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    li {
      padding: var(--space-1) 0;
    }
    h3 {
      font-size: 14px;
      color: var(--quiet);
      margin: var(--space-3) 0 var(--space-1);
    }
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
  `,
})
export class NeighborhoodMap {
  private readonly notes = inject(NotesService);
  private readonly links = inject(LinksService);
  private readonly router = inject(Router);
  protected readonly id = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((p) => p.get('id') ?? '')),
    { initialValue: '' },
  );

  private readonly hood = computed(() => neighborhood(this.id(), this.links.graph()));
  protected readonly placed = computed(() => radial(this.hood().nodes, SIZE));
  /**
   * The drawing's frame: the nodes and their labels with a margin, but
   * never smaller than a full ring's frame, so a small neighborhood is
   * not blown up.
   */
  protected readonly viewBox = computed(() => {
    const placed = this.placed();
    const xs = placed.map((p) => p.x);
    const ys = placed.map((p) => p.y);
    const left = Math.min(...xs) - 90;
    const top = Math.min(...ys) - 30;
    const w = Math.max(Math.max(...xs) + 90 - left, SIZE);
    const h = Math.max(Math.max(...ys) + 40 - top, SIZE * 0.6);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2 + 5;
    return `${cx - w / 2} ${cy - h / 2} ${w} ${h}`;
  });

  protected readonly lines = computed(() => {
    const at = new Map(this.placed().map((p) => [p.id, p]));
    return this.hood().edges.map(([a, b]) => ({
      key: `${a}>${b}`,
      x1: at.get(a)!.x,
      y1: at.get(a)!.y,
      x2: at.get(b)!.x,
      y2: at.get(b)!.y,
    }));
  });

  protected ring(hop: 1 | 2) {
    return this.hood().nodes.filter((n) => n.hop === hop);
  }

  protected title(id: string): string {
    return this.notes.find(id)?.title || 'Untitled';
  }

  protected short(id: string): string {
    const t = this.title(id);
    return t.length > 18 ? `${t.slice(0, 17)}…` : t;
  }

  protected isConcept(id: string): boolean {
    return this.notes.find(id)?.kind === 'concept';
  }

  protected radius(n: { hop: number; id: string }): number {
    return n.hop === 0 ? 18 : this.isConcept(n.id) ? 12 : 9;
  }

  protected open(id: string): void {
    void this.router.navigate(['/n', id]);
  }
}
