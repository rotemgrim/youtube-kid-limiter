// Generates a math problem the parent must solve to change protected settings.
//
// Config-driven: the parent chooses which operations are allowed and, for EACH
// operation, the range the ANSWER must land in. The generator works backwards from a
// target answer inside that op's range, so the answer is always within the op's
// [min, max] regardless of operation.
//
//   mathConfig = {
//     operations: ['add', 'sub'],
//     ranges: { add: { min: 8, max: 14 }, sub: { min: 2, max: 9 }, mul: { min: 10, max: 50 } },
//   }
//
// Older shapes are still accepted (see normalizeConfig):
//   - flat:   { operations: [...], minAnswer: 8, maxAnswer: 14 }  → that range used for every op
//   - legacy: 'easy' | 'medium' | 'hard' string
//
// Adding a new operation later is just one more entry in OPS and OP_KEYS.
(function () {
  const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

  // Each op knows its display symbol and how to build a problem whose answer is in [lo, hi].
  const OPS = {
    add: {
      label: 'Add',
      symbol: '+',
      gen(lo, hi) {
        const answer = rnd(lo, hi);
        // Keep both operands ≥ 1 so we never produce a trivial "0 + n". Only
        // possible when the answer is at least 2; otherwise fall back.
        const a = answer >= 2 ? rnd(1, answer - 1) : rnd(0, answer);
        return { text: `${a} + ${answer - a}`, answer };
      },
    },
    sub: {
      label: 'Subtract',
      symbol: '−',
      gen(lo, hi) {
        const answer = rnd(lo, hi);
        const b = rnd(1, Math.max(1, hi)); // subtrahend ≥ 1 (no trivial "n − 0"), capped at hi
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

  const OP_KEYS = Object.keys(OPS); // ['add', 'sub', 'mul']
  const DEFAULT_RANGE = { min: 8, max: 14 };
  const DEFAULT_CONFIG = {
    operations: ['add'],
    ranges: { add: { min: 8, max: 14 }, sub: { min: 8, max: 14 }, mul: { min: 8, max: 14 } },
  };

  // Legacy `difficulty` strings → flat config, so settings saved before this change still work.
  const LEGACY = {
    easy: { operations: ['add'], minAnswer: 2, maxAnswer: 18 },
    medium: { operations: ['add', 'sub', 'mul'], minAnswer: 10, maxAnswer: 99 },
    hard: { operations: ['mul'], minAnswer: 100, maxAnswer: 800 },
  };

  // Coerce one {min,max} into valid bounds (rounded, non-negative, min ≤ max).
  function normalizeRange(r, fallback) {
    r = r || {};
    let lo = Number.isFinite(r.min) ? Math.round(r.min) : fallback.min;
    let hi = Number.isFinite(r.max) ? Math.round(r.max) : fallback.max;
    lo = Math.max(0, lo);
    hi = Math.max(lo, hi);
    return { min: lo, max: hi };
  }

  // Coerce whatever is stored (new per-op object, flat object, legacy string, or junk)
  // into the canonical { operations, ranges } shape.
  function normalizeConfig(cfg) {
    if (typeof cfg === 'string') cfg = LEGACY[cfg] || {};
    cfg = cfg || {};
    let ops = Array.isArray(cfg.operations) ? cfg.operations.filter((o) => OPS[o]) : [];
    if (!ops.length) ops = [...DEFAULT_CONFIG.operations];

    // A flat minAnswer/maxAnswer (old shape or legacy) seeds every op that lacks its own range.
    const flat = (Number.isFinite(cfg.minAnswer) || Number.isFinite(cfg.maxAnswer))
      ? { min: cfg.minAnswer, max: cfg.maxAnswer }
      : null;
    const src = cfg.ranges || {};
    const ranges = {};
    for (const op of OP_KEYS) {
      ranges[op] = normalizeRange(src[op] || flat, DEFAULT_RANGE);
    }
    return { operations: ops, ranges };
  }

  function generateProblem(cfg) {
    const { operations, ranges } = normalizeConfig(cfg);
    const op = operations[rnd(0, operations.length - 1)];
    const { min, max } = ranges[op];
    return OPS[op].gen(min, max);
  }

  window.MathLock = { generateProblem, normalizeConfig, DEFAULT_CONFIG, OPS };
})();
