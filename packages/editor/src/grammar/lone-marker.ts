// A lone `-`, `*` or `+` is an empty list item, even under a line of
// text (#118). CommonMark says an empty item cannot interrupt a
// paragraph, so `- Monday\n  -` kept the `-` as text in Monday's
// paragraph; in a note that line is always a list item being typed.
//
// micromark's list construct refuses an empty item only while it is
// interrupting (`self.interrupt`), and for a bullet that is the only
// thing `interrupt` changes. So this construct runs the built-in list
// with `interrupt` cleared, restoring it if no item starts. It parses
// the text as typed: nothing is rewritten, so every offset stays true.
import type { Construct, Effects, State, TokenizeContext } from 'micromark-util-types';

const DASH = 45;
const STAR = 42;
const PLUS = 43;

/** The built-in list construct this one wraps, from the parser itself. */
function builtInList(context: TokenizeContext): Construct {
  const found = ([] as Construct[])
    .concat(context.parser.constructs.document?.[DASH] ?? [])
    .find((c) => c.name === 'list' && c !== bulletItem);
  if (!found) throw new Error('micromark has no list construct');
  return found;
}

const bulletItem: Construct = {
  // Named as the list is, so disabling `list` disables this too.
  name: 'list',
  tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State) {
    const interrupt = this.interrupt;
    this.interrupt = undefined;
    return builtInList(this).tokenize.call(this, effects, ok, (code) => {
      this.interrupt = interrupt;
      return nok(code);
    });
  },
  continuation: {
    tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State) {
      return builtInList(this).continuation!.tokenize.call(this, effects, ok, nok);
    },
  },
  exit(this: TokenizeContext, effects: Effects) {
    return builtInList(this).exit!.call(this, effects);
  },
};

/** micromark extension: a bare bullet marker starts an empty item. */
export const loneMarker = {
  document: { [DASH]: bulletItem, [STAR]: bulletItem, [PLUS]: bulletItem },
};
