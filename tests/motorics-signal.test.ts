import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SIGNAL_TIMINGS,
  SIGNAL_COLORS,
  TARGET_COLOR,
  accuracy,
  classifyReaction,
  classifyTimeout,
  countBy,
  falseStart,
  planNextStimulus,
  reactionTimes,
  type TrialResult,
} from '../src/modules/motorics-signal';

const seeded = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
};

describe('planNextStimulus', () => {
  it('пауза всегда в границах minGapMs..maxGapMs', () => {
    const rnd = seeded(1);
    for (let i = 0; i < 500; i++) {
      const { gapMs } = planNextStimulus(DEFAULT_SIGNAL_TIMINGS, rnd);
      expect(gapMs).toBeGreaterThanOrEqual(DEFAULT_SIGNAL_TIMINGS.minGapMs);
      expect(gapMs).toBeLessThanOrEqual(DEFAULT_SIGNAL_TIMINGS.maxGapMs);
    }
  });

  it('цвет всегда из общего списка', () => {
    const rnd = seeded(7);
    for (let i = 0; i < 500; i++) {
      const { color } = planNextStimulus(DEFAULT_SIGNAL_TIMINGS, rnd);
      expect(SIGNAL_COLORS).toContain(color);
    }
  });

  it('доля зелёного близка к targetShare на большой выборке', () => {
    const rnd = seeded(42);
    let greens = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      if (planNextStimulus(DEFAULT_SIGNAL_TIMINGS, rnd).color === TARGET_COLOR) greens++;
    }
    expect(greens / n).toBeCloseTo(DEFAULT_SIGNAL_TIMINGS.targetShare, 1);
  });

  it('при targetShare=0 зелёный не выпадает вовсе', () => {
    const rnd = seeded(3);
    const t = { ...DEFAULT_SIGNAL_TIMINGS, targetShare: 0 };
    for (let i = 0; i < 300; i++) {
      expect(planNextStimulus(t, rnd).color).not.toBe(TARGET_COLOR);
    }
  });

  it('при targetShare=1 всегда зелёный', () => {
    const rnd = seeded(9);
    const t = { ...DEFAULT_SIGNAL_TIMINGS, targetShare: 1 };
    for (let i = 0; i < 300; i++) {
      expect(planNextStimulus(t, rnd).color).toBe(TARGET_COLOR);
    }
  });
});

describe('разбор попытки', () => {
  it('клик по зелёному в окне — hit с реакцией signalShownAt→pointerDownAt', () => {
    const r = classifyReaction(0, 'green', 1000, 1230);
    expect(r.outcome).toBe('hit');
    expect(r.isTarget).toBe(true);
    expect(r.reactionMs).toBe(230);
  });

  it('клик по не-зелёному в окне — falseAlarm без времени реакции', () => {
    const r = classifyReaction(0, 'red', 1000, 1120);
    expect(r.outcome).toBe('falseAlarm');
    expect(r.isTarget).toBe(false);
    expect(r.reactionMs).toBeNull();
  });

  it('зелёный без реакции в своё окно — miss', () => {
    const r = classifyTimeout(0, 'green');
    expect(r.outcome).toBe('miss');
    expect(r.reactionMs).toBeNull();
  });

  it('не-зелёный без реакции — correctIgnore', () => {
    const r = classifyTimeout(0, 'blue');
    expect(r.outcome).toBe('correctIgnore');
  });

  it('клик до появления стимула — falseStart, цвет не привязан', () => {
    const r = falseStart(0);
    expect(r.outcome).toBe('falseStart');
    expect(r.color).toBeNull();
    expect(r.reactionMs).toBeNull();
  });
});

describe('агрегаты сессии', () => {
  const trials: TrialResult[] = [
    classifyReaction(0, 'green', 0, 250), // hit, 250
    classifyReaction(1, 'green', 0, 400), // hit, 400
    classifyTimeout(2, 'green'), // miss
    classifyReaction(3, 'red', 0, 100), // falseAlarm
    classifyTimeout(4, 'blue'), // correctIgnore
    falseStart(5), // falseStart
  ];

  it('reactionTimes берёт только hit', () => {
    expect(reactionTimes(trials).sort((a, b) => a - b)).toEqual([250, 400]);
  });

  it('countBy считает по каждому исходу', () => {
    expect(countBy(trials, 'hit')).toBe(2);
    expect(countBy(trials, 'miss')).toBe(1);
    expect(countBy(trials, 'falseAlarm')).toBe(1);
    expect(countBy(trials, 'correctIgnore')).toBe(1);
    expect(countBy(trials, 'falseStart')).toBe(1);
  });

  it('accuracy — доля hit+correctIgnore от предъявленных стимулов, falseStart не в знаменателе', () => {
    // Предъявлено 5 стимулов (без falseStart): 2 hit + 1 correctIgnore = 3 верных из 5.
    expect(accuracy(trials)).toBeCloseTo(3 / 5, 6);
  });

  it('пустой список — accuracy null, не NaN', () => {
    expect(accuracy([])).toBeNull();
  });

  it('только falseStart — accuracy тоже null (предъявленных стимулов не было)', () => {
    expect(accuracy([falseStart(0), falseStart(1)])).toBeNull();
  });
});
