// Compile-time guard: schema output ≡ documented interface.
//
// `assertEqual<A, B>(true)` only typechecks when A and B are the *same* type, so
// a drift between a schema's `z.infer` and its hand-written interface (a
// renamed/added/removed field, a changed nullability) fails `tsc` — the
// build-time half of the contract that the runtime `parse` enforces
// dynamically. Every `schemas/<domain>.ts` module ends with a block of these;
// this is the single definition so the helper is never copied.

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export function assertEqual<_A, _B>(_proof: Equals<_A, _B> extends true ? true : never): void {}
