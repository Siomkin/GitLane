// Close the menu, then run the write — the `act` verb three menus each defined
// byte-identically and imported from none (GL-359). Closing first is the point:
// the write is async, and a menu left open over a repaint would render the
// previous subject against a moved graph.
export function menuAction(close: () => void, run: (op: () => Promise<string>) => void) {
  return (op: () => Promise<string>) => {
    close();
    void run(op);
  };
}
