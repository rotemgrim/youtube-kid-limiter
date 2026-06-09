// Generates a math problem the parent must solve to change protected settings.
//
// Config-driven: the parent chooses which operations are allowed and the range the
// ANSWER must land in. The generator works backwards from a target answer inside that
// range, so the answer is always within [minAnswer, maxAnswer] regardless of operation.
//
//   mathConfig = { operations: ['add'], minAnswer: 8, maxAnswer: 14 }
//
// Adding a new operation later is just one more entry in OPS.
(function () {
  const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

  // Each op knows its display symbol and how to build a problem whose answer is in [lo, hi].
  const OPS = {
    add: {
      label: 'Add',
      symbol: '+',
      gen(lo, hi) {
        const answer = rnd(lo, hi);
        const a = rnd(0, answer);
        return { text: `${a} + ${answer - a}`, answer };
      },
    },
    sub: {
      label: 'Subtract',
      symbol: '−',
      gen(lo, hi) {
        const answer = rnd(lo, hi);
        const b = rnd(0, hi); // subtrahend capped at hi keeps both operands modest
        return { text: `${answer + b} − ${b}`, answer };
      },
    },
    mul: {
      label: 'Multiply',
      symbol: '×',
      gen(lo, hi) {
        // Enumerate factor pairs whose product falls in range, then pick one.
        const pairs = [];
        for (let a = 1; a <= hi; a++) {
          for (let b = a; b <= hi; b++) {
            const p = a * b;
            if (p >= lo && p <= hi) pairs.push([a, b]);
          }
        }
        // No product fits the range (e.g. range 8–14 admits few) — fall back to add so a
        // problem is always produced.
        if (!pairs.length) return OPS.add.gen(lo, hi);
        const [a, b] = pairs[rnd(0, pairs.length - 1)];
        return { text: `${a} × ${b}`, answer: a * b };
      },
    },
  };

  const DEFAULT_CONFIG = { operations: ['add'], minAnswer: 8, maxAnswer: 14 };

  // Legacy `difficulty` strings → config, so settings saved before this change still work.
  const LEGACY = {
    easy: { operations: ['add'], minAnswer: 2, maxAnswer: 18 },
    medium: { operations: ['add', 'sub', 'mul'], minAnswer: 10, maxAnswer: 99 },
    hard: { operations: ['mul'], minAnswer: 100, maxAnswer: 800 },
  };

  // Coerce whatever is stored (object, legacy string, or junk) into a valid config.
  function normalizeConfig(cfg) {
    if (typeof cfg === 'string') cfg = LEGACY[cfg] || {};
    cfg = cfg || {};
    let ops = Array.isArray(cfg.operations) ? cfg.operations.filter((o) => OPS[o]) : [];
    if (!ops.length) ops = [...DEFAULT_CONFIG.operations];
    let lo = Number.isFinite(cfg.minAnswer) ? Math.round(cfg.minAnswer) : DEFAULT_CONFIG.minAnswer;
    let hi = Number.isFinite(cfg.maxAnswer) ? Math.round(cfg.maxAnswer) : DEFAULT_CONFIG.maxAnswer;
    lo = Math.max(0, lo);
    hi = Math.max(lo, hi);
    return { operations: ops, minAnswer: lo, maxAnswer: hi };
  }

  function generateProblem(cfg) {
    const { operations, minAnswer, maxAnswer } = normalizeConfig(cfg);
    const op = operations[rnd(0, operations.length - 1)];
    return OPS[op].gen(minAnswer, maxAnswer);
  }

  window.MathLock = { generateProblem, normalizeConfig, DEFAULT_CONFIG, OPS };
})();
