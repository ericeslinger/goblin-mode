import { describe, expect, it } from 'vitest';
import { FEELINGS_TEMPLATE, moodLine, moodTargets, moodsOf, suggestMoods } from './journal';
import { templateParts } from './templates';

describe('the feelings journal', () => {
  it('knows a Moods line however it is written', () => {
    expect(moodLine('Moods: calm')).toBe('calm');
    expect(moodLine('- *Mood:* sad')).toBe('sad');
    expect(moodLine('moods:')).toBe('');
    expect(moodLine('My moods: none of your business')).toBeUndefined();
  });

  it('takes the linked moods as moods, and lists every mood named', () => {
    const body = 'Feelings\n\nMoods: [[calm]], [[Sad|sad]], tired\n\nI mention [[Kiln]].';
    expect(moodTargets(body)).toEqual(['calm', 'Sad']);
    expect(moodsOf(body)).toEqual(['calm', 'Sad', 'tired']);
    expect(moodsOf('no moods here')).toEqual([]);
  });

  it('is a template whose entries start with an empty Moods line', () => {
    const { skeleton, instructions } = templateParts(FEELINGS_TEMPLATE);
    expect(skeleton.split('\n')).toContain('Moods: ');
    expect(instructions).toContain('type mood');
  });
});

describe('suggestMoods', () => {
  it('offers live moods, those starting with the query first', () => {
    const mood = (title: string, archived = false) => ({
      kind: 'concept',
      conceptType: 'mood',
      title,
      archived,
    });
    const notes = [
      mood('uncalm'),
      { kind: 'concept', conceptType: 'other', title: 'Calming tea' },
      mood('calm'),
      mood('cal', true),
      { kind: 'text', title: 'calm day' },
    ];
    expect(suggestMoods('cal', notes)).toEqual(['calm', 'uncalm']);
    expect(suggestMoods('', notes)).toEqual(['uncalm', 'calm']);
  });
});
