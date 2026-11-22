import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { HABIT_CHOICE_MAX, HABIT_TEXT_MAX } from '@mossgoblin/schema';
import { type HabitRecord, HabitsService } from './habits.service';

/**
 * A tick's answer, asked for in place (#324 step 6, 2026-11-22), on
 * Right Now's row and the Habits screen's Today or Yesterday row: a
 * choice habit's choices as buttons, one tap answering it and marking
 * it done; a text habit's one line, saved by Enter or Done, empty
 * meaning done with no answer, and kept on this device as it is typed
 * so a reload does not lose it. Cancel, or Escape, logs nothing. The
 * first choice, or the line, takes the focus as it opens.
 */
@Component({
  selector: 'app-habit-ask',
  template: `
    @let h = habit();
    @if (h.answer === 'choice') {
      <div class="choices" role="group" [attr.aria-label]="label()" (keydown.escape)="cancel()">
        @for (c of h.choices ?? []; track c) {
          <button type="button" class="choice" (click)="answer(c)">{{ c }}</button>
        }
        <button type="button" class="link" (click)="cancel()">Cancel</button>
      </div>
    } @else {
      <form class="line" [attr.aria-label]="label()" (submit)="save($event)">
        <input
          type="text"
          autocomplete="off"
          enterkeyhint="done"
          [attr.maxlength]="textMax"
          [attr.aria-label]="label()"
          [value]="text()"
          (input)="typed($any($event.target).value)"
          (keydown.escape)="cancel()"
        />
        <button type="submit">Done</button>
        <button type="button" class="link" (click)="cancel()">Cancel</button>
      </form>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .choices,
    .line {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2, 8px);
      margin-top: 6px;
    }
    .choice {
      font-size: 14px;
      border-radius: var(--radius-pill);
    }
    .line input {
      flex: 1;
      min-width: 10em;
      box-sizing: border-box;
      padding: 6px 8px;
      font: inherit;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
    }
  `,
})
export class HabitAsk {
  readonly habit = input.required<HabitRecord>();
  /** The day shown, as the row that asked meant it. */
  readonly day = input.required<string>();
  /** "today" or "yesterday", for the words. */
  readonly when = input('today');
  /** Answered (logged done), or put away with nothing logged. */
  readonly closed = output<'answered' | 'cancelled'>();
  private readonly habits = inject(HabitsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly textMax = HABIT_TEXT_MAX;
  protected readonly text = signal('');

  protected readonly label = computed(() => {
    const h = this.habit();
    return h.answer === 'choice'
      ? `${h.name} ${this.when()}: choose one`
      : `${h.name} ${this.when()}: a line of text`;
  });

  constructor() {
    afterNextRender(() => {
      this.text.set(this.habits.draft(this.habit().id, this.day()));
      const first = this.host.nativeElement.querySelector<HTMLElement>('input, button');
      first?.focus();
    });
  }

  protected typed(value: string): void {
    this.text.set(value);
    this.habits.setDraft(this.habit().id, this.day(), value);
  }

  protected answer(choice: string): void {
    if (choice.length > HABIT_CHOICE_MAX) return;
    this.habits.log(this.habit(), this.day(), 'done', { text: choice });
    this.closed.emit('answered');
  }

  protected save(event: Event): void {
    event.preventDefault();
    this.habits.log(this.habit(), this.day(), 'done', { text: this.text() });
    this.closed.emit('answered');
  }

  protected cancel(): void {
    this.habits.dropDraft(this.habit().id, this.day());
    this.closed.emit('cancelled');
  }
}
