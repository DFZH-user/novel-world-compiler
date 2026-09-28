import { describe, expect, it } from 'vitest';
import { detectChineseTimeExpressions } from '../../electron/worker/timeline-service';

describe('Chinese timeline time-expression detection', () => {
  it('separates exact, relative, duration, frequency, age and era expressions', () => {
    const text = '二〇二四年三月五日下午三点半，十八岁的林月抵达。三日后，她持续两年每天修行，直到康熙二十年。';
    const expressions = detectChineseTimeExpressions(text);
    expect(expressions.map((item) => [item.surfaceText, item.expressionType])).toEqual([
      ['二〇二四年三月五日', 'calendar'],
      ['下午三点半', 'clock'],
      ['十八岁', 'age'],
      ['三日后', 'relative'],
      ['持续两年', 'duration'],
      ['每天', 'frequency'],
      ['康熙二十年', 'era'],
    ]);
    expect(expressions[0].normalizedValue).toBe('2024-03-05');
    expect(expressions[3].normalizedValue).toBe('RELATIVE:AFTER:三日');
  });

  it('keeps narrative signals as relative relations instead of inventing dates', () => {
    const expressions = detectChineseTimeExpressions('此前他从未离城。与此同时，山门打开。翌日众人启程。');
    expect(expressions.map((item) => item.normalizedValue)).toEqual([
      'RELATIVE:BEFORE', 'RELATIVE:SIMULTANEOUS', 'RELATIVE:NEXT_DAY',
    ]);
  });
});
