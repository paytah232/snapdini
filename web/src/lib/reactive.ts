/**
 * Name a dependency that `$:` cannot work out for itself.
 *
 * Svelte tracks a reactive statement's dependencies syntactically: only identifiers that appear in
 * the statement's own text are tracked, so state read inside a function the statement CALLS is
 * invisible to it. The fix is to mention the identifier in the statement — but a mention has to be
 * an expression, and the obvious spellings do not survive the toolchain:
 *
 *   - `void x;`     — `vitePreprocess()` strips TypeScript with esbuild, and esbuild deletes
 *                     side-effect-free expression statements. `void x` on a plain `let` binding is
 *                     provably side-effect-free, so the whole statement is gone BEFORE Svelte parses
 *                     the file, and the dependency is never recorded. (It survives by accident where
 *                     `x` is itself `$:`-declared: to esbuild those read as undeclared globals that
 *                     might throw, so it must keep them. Luck, not design.)
 *   - `(x, expr)`   — survives esbuild, but TypeScript rejects it: TS2695, "Left side of comma
 *                     operator is unused and has no side effects".
 *
 * A call is the one form both tools accept. esbuild cannot prove an imported function is pure, so
 * it keeps the call; TypeScript sees an ordinary void call and says nothing.
 *
 *     $: allRects = (dep(bounds, decorRects), posterRects());   // value-bearing statements
 *     $: { dep(view); resetArmed = false; }                     // statements with no value
 *
 * `reactiveDeps.test.ts` compiles every component through the real `vitePreprocess()` and asserts
 * these dependencies land in the emitted dirty mask, so a regression fails the suite rather than
 * shipping as an intermittent bug.
 */
export const dep = (..._deps: unknown[]): void => {};
