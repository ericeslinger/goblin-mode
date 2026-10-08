import { describe, expect, it } from 'vitest';
import { canParent, childrenOf, selfAndDescendants, withProjectSections } from './projects';

describe('withProjectSections', () => {
  it('puts existing text under Overview, word for word, then the other sections', () => {
    expect(withProjectSections('skeleton built, need to run scriptgen\n\nPart of [[x]].')).toBe(
      [
        '## Overview',
        '',
        'skeleton built, need to run scriptgen',
        '',
        'Part of [[x]].',
        '',
        '## Working notes',
        '',
        '## Tasks',
        '',
        '## Ideas',
        '',
        '## Open questions',
        '',
        '## Decisions',
        '',
        '## Links',
        '',
      ].join('\n'),
    );
  });

  it('gives an empty project just the headings', () => {
    expect(withProjectSections('').startsWith('## Overview\n\n## Working notes')).toBe(true);
  });

  it('adds only the missing sections at the end, and leaves a full page alone', () => {
    const some = '## Overview\nA game.\n\n## Ideas\n- hats\n';
    const out = withProjectSections(some);
    expect(out.startsWith(some.trimEnd())).toBe(true);
    expect(out).toContain('## Working notes');
    expect(out.match(/## Ideas/g)).toHaveLength(1);
    expect(withProjectSections(out)).toBe(out);
  });
});

describe('project tree', () => {
  const tree = [
    { id: 'armature' },
    { id: 'site', parent: 'armature' },
    { id: 'rules', parent: 'armature' },
    { id: 'rules-ch1', parent: 'rules' },
    { id: 'old', parent: 'armature', archived: true },
    { id: 'sprout' },
  ];

  it('lists a project’s live children', () => {
    expect(childrenOf('armature', tree).map((p) => p.id)).toEqual(['site', 'rules']);
  });

  it('never lets a project sit under itself or its own descendants', () => {
    expect([...selfAndDescendants('armature', tree)].sort()).toEqual(
      ['armature', 'old', 'rules', 'rules-ch1', 'site'].sort(),
    );
    expect(canParent('armature', 'rules-ch1', tree)).toBe(false);
    expect(canParent('armature', 'armature', tree)).toBe(false);
    expect(canParent('rules-ch1', 'site', tree)).toBe(true);
    expect(canParent('sprout', 'armature', tree)).toBe(true);
  });
});
