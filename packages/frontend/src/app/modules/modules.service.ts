import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { type ModuleId, ModuleSetting, moduleOn, paths } from '@mossgoblin/schema';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { SETTINGS_API } from '../theme/theme-sync.service';

type Stored = Partial<Record<ModuleId, ModuleSetting>>;

/**
 * The modules switched on (#126, Eric 2026-10-18), from the gardener's
 * `settings/modules` doc, so every device agrees. Until the doc is read
 * each module is at its default (Projects on). A switch is written
 * through the persistent cache and never awaited, so it works offline.
 */
@Injectable({ providedIn: 'root' })
export class ModulesService {
  private readonly fb = inject(FIREBASE);
  private readonly api = inject(SETTINGS_API);
  private readonly auth = inject(AuthService);
  private readonly stored = signal<Stored | undefined>(undefined);
  private uid?: string;
  private stop?: () => void;

  /** Projects: types, the pill, the lens, items and stages (#41, #122). */
  readonly projects = computed(() => moduleOn(this.stored(), 'projects'));

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid;
      if (uid === this.uid) return;
      this.stop?.();
      this.stop = undefined;
      this.uid = uid;
      this.stored.set(undefined);
      if (!uid) return;
      this.stop = this.api.listen(
        this.fb.db,
        paths.modules(uid),
        (data) => this.stored.set(data ? read(data) : undefined),
        (err) => console.error('modules listener', err),
      );
    });
    inject(DestroyRef).onDestroy(() => this.stop?.());
  }

  on(id: ModuleId): boolean {
    return moduleOn(this.stored(), id);
  }

  /** Switches a module on or off, keeping its configuration. */
  set(id: ModuleId, enabled: boolean): void {
    if (!this.uid) return;
    const next: Stored = { ...this.stored(), [id]: { ...this.stored()?.[id], enabled } };
    this.stored.set(next);
    this.api
      .set(this.fb.db, paths.modules(this.uid), { ...next, updatedAt: this.api.now() })
      .catch((err) => console.error('modules write failed', err));
  }
}

/** The modules this version knows, as stored; anything malformed is left out. */
function read(data: Record<string, unknown>): Stored {
  const out: Stored = {};
  const projects = ModuleSetting.safeParse(data['projects']);
  if (projects.success) out.projects = projects.data;
  return out;
}
