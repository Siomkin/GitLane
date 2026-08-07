// Close the menu, then run the write (GL-359).
//
// Every menu does this, and three of them defined the same four-line `act`
// helper to say so — byte-identical, imported from neither. Closing first is the
// point: the write is async, and a menu left open over a repaint would render
// the previous subject against a moved graph.

/** Bind a menu's `close` and its op runner (`useBranchOp`) into the verb every
 * row calls: dismiss, then run. */
export function menuAction(
  close: () => void,
  run: (op: () => Promise<string>) => void,
) {
  return (op: () => Promise<string>) => {
    close();
    void run(op);
  };
}
