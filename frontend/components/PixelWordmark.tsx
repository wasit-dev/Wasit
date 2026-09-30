/**
 * "WASIT" in the ANSI Shadow block-letter style a terminal banner uses:
 * solid █ cells for the letters, and the thin double-line box-drawing
 * characters (╗ ║ ╝ ═ ╚ ╔) that trail each stroke as its shadow.
 *
 * Drawn as SVG from the character grid below rather than set as text, so
 * every cell lands exactly on the grid whatever font is installed: a █
 * becomes a filled cell (its thin seam left visible, the way a terminal
 * shows its cells) and each box-drawing character becomes the two lines
 * it stands for. Decorative — the footer names the brand in its logo —
 * so the whole SVG is hidden from assistive tech.
 */

// Figlet "ANSI Shadow" for WASIT, 38 columns by 6 rows.
const ART = [
  "██╗    ██╗ █████╗ ███████╗██╗████████╗",
  "██║    ██║██╔══██╗██╔════╝██║╚══██╔══╝",
  "██║ █╗ ██║███████║███████╗██║   ██║   ",
  "██║███╗██║██╔══██║╚════██║██║   ██║   ",
  "╚███╔███╔╝██║  ██║███████║██║   ██║   ",
  " ╚══╝╚══╝ ╚═╝  ╚═╝╚══════╝╚═╝   ╚═╝   ",
];

// One terminal cell is twice as tall as it is wide, so "██" is square.
const W = 10;
const H = 20;

/** The two strokes of a double-line box-drawing character, as SVG path data. */
function boxPath(ch: string, x: number, y: number): string | null {
  const a = x + 3.5; // left vertical
  const b = x + 6.5; // right vertical
  const c = y + 8.5; // upper horizontal
  const d = y + 11.5; // lower horizontal
  const r = x + W;
  const bottom = y + H;
  switch (ch) {
    case "═":
      return `M${x} ${c}H${r}M${x} ${d}H${r}`;
    case "║":
      return `M${a} ${y}V${bottom}M${b} ${y}V${bottom}`;
    case "╗":
      return `M${x} ${c}H${b}V${bottom}M${x} ${d}H${a}V${bottom}`;
    case "╔":
      return `M${r} ${c}H${a}V${bottom}M${r} ${d}H${b}V${bottom}`;
    case "╝":
      return `M${x} ${d}H${b}V${y}M${x} ${c}H${a}V${y}`;
    case "╚":
      return `M${r} ${d}H${a}V${y}M${r} ${c}H${b}V${y}`;
    default:
      return null;
  }
}

export function PixelWordmark() {
  const cols = Math.max(...ART.map((row) => [...row].length));
  const blocks: { x: number; y: number }[] = [];
  let shadow = "";

  ART.forEach((row, ry) => {
    [...row].forEach((ch, cx) => {
      const x = cx * W;
      const y = ry * H;
      if (ch === "█") blocks.push({ x, y });
      else shadow += boxPath(ch, x, y) ?? "";
    });
  });

  return (
    <svg
      className="pixel-wordmark"
      viewBox={`-1 -1 ${cols * W + 2} ${ART.length * H + 2}`}
      aria-hidden="true"
      focusable="false"
    >
      <path className="pixel-shadow" d={shadow} />
      {blocks.map((b) => (
        <rect key={`${b.x}-${b.y}`} className="pixel-block" x={b.x} y={b.y} width={W} height={H} />
      ))}
    </svg>
  );
}
