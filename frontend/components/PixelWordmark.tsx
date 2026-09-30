/**
 * "WASIT" as a 5x7 dot-matrix, the way a terminal or an LED panel draws
 * type: every cell of every glyph is a square, lit or unlit. Drawn as SVG
 * rects rather than set in a pixel font, so it is crisp at any width and
 * needs no extra font download.
 *
 * Hovering a lit cell turns it --accent-2 at once and lets it fade back
 * slowly (see .pixel-on in globals.css), so a pointer sweeping across the
 * word leaves a short trail. Decorative: the footer names the brand in
 * its logo above, so the whole SVG is hidden from assistive tech.
 */

// Classic 5x7 bitmaps, one string per row, "1" = lit.
const GLYPHS: Record<string, string[]> = {
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
};

const WORD = "WASIT";
const CELL = 10; // grid pitch in SVG units
const DOT = 8.4; // lit square inside each cell; the rest is the gap
const LETTER_GAP = 1; // blank columns between glyphs

export function PixelWordmark() {
  const cols = WORD.length * 5 + (WORD.length - 1) * LETTER_GAP;
  const cells: { x: number; y: number; on: boolean }[] = [];

  [...WORD].forEach((letter, li) => {
    const x0 = li * (5 + LETTER_GAP);
    GLYPHS[letter]!.forEach((row, y) => {
      [...row].forEach((bit, x) => cells.push({ x: x0 + x, y, on: bit === "1" }));
    });
  });

  const inset = (CELL - DOT) / 2;
  return (
    <svg
      className="pixel-wordmark"
      viewBox={`0 0 ${cols * CELL} ${7 * CELL}`}
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      {cells.map((c) => (
        <rect
          key={`${c.x}-${c.y}`}
          className={c.on ? "pixel-on" : "pixel-off"}
          x={c.x * CELL + inset}
          y={c.y * CELL + inset}
          width={DOT}
          height={DOT}
        />
      ))}
    </svg>
  );
}
