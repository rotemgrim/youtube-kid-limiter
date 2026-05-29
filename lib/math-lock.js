// Generates a math problem the parent must solve to change protected settings.
(function () {
  const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

  function generateProblem(difficulty) {
    if (difficulty === 'easy') {
      const a = rnd(1, 9), b = rnd(1, 9);
      return { text: `${a} + ${b}`, answer: a + b };
    }
    if (difficulty === 'hard') {
      const a = rnd(11, 29), b = rnd(11, 29);
      return { text: `${a} × ${b}`, answer: a * b };
    }
    // medium: 2-digit add/subtract or single-digit multiply
    const roll = Math.random();
    if (roll < 0.34) { const a = rnd(20, 89), b = rnd(10, 49); return { text: `${a} + ${b}`, answer: a + b }; }
    if (roll < 0.67) { const a = rnd(40, 99), b = rnd(10, 39); return { text: `${a} − ${b}`, answer: a - b }; }
    const a = rnd(3, 9), b = rnd(3, 9); return { text: `${a} × ${b}`, answer: a * b };
  }

  window.MathLock = { generateProblem };
})();
