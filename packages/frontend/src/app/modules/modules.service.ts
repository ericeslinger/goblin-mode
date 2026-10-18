import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  type KitchenConfig,
  MODULES,
  type ModuleId,
  ModuleSetting,
  kitchenConfig,
  moduleOn,
  paths,
} from '@mossgoblin/schema';
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
  /** Kitchen: recipes, the meal plan, the grocery list, on hand (#125). */
  readonly kitchen = computed(() => moduleOn(this.stored(), 'kitchen'));
  /** Kitchen's configuration (#129): week start, meals, the fish's day. */
  readonly kitchenConfig = computed(() => kitchenConfig(this.stored()?.kitchen?.config));
  /** Whether the stored settings have been read, so a plan is made to them. */
  readonly loaded = computed(() => this.read());
  private readonly read = signal(false);

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid;
      if (uid === this.uid) return;
      this.stop?.();
      this.stop = undefined;
      this.uid = uid;
      this.stored.set(undefined);
      this.read.set(false);
      if (!uid) return;
      this.stop = this.api.listen(
        this.fb.db,
        paths.modules(uid),
        (data) => {
          this.stored.set(data ? read(data) : undefined);
          this.read.set(true);
        },
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
    this.write({ ...this.stored(), [id]: { ...this.stored()?.[id], enabled } });
  }

  /** Changes Kitchen's configuration (#129), keeping whether it is on. */
  configureKitchen(change: Partial<KitchenConfig>): void {
    const current = this.stored()?.kitchen;
    const config = { ...current?.config, ...this.kitchenConfig(), ...change };
    this.write({
      ...this.stored(),
      kitchen: { enabled: current?.enabled ?? this.kitchen(), config },
    });
  }

  private write(next: Stored): void {
    if (!this.uid) return;
    this.stored.set(next);
    this.api
      .set(this.fb.db, paths.modules(this.uid), { ...next, updatedAt: this.api.now() })
      .catch((err) => console.error('modules write failed', err));
  }
}

/** The modules this version knows, as stored; anything malformed is left out. */
function read(data: Record<string, unknown>): Stored {
  const out: Stored = {};
  for (const { id } of MODULES) {
    const setting = ModuleSetting.safeParse(data[id]);
    if (setting.success) out[id] = setting.data;
  }
  return out;
}
