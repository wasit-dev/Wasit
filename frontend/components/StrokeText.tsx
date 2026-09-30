"use client";

import { Fragment, useEffect, useRef } from "react";

type Mode = "outline" | "block";

const DRAW_MS = 1800; // outline drawing
const STAGGER_MS = 120; // between words
const FILL_MS = 520; // the block's wipe, after the outline

/**
 * Text whose outline draws itself in, stroke by stroke — inspired by
 * reactbits.dev's Stroke Text, written here from scratch.
 *
 * `outline` text stays an outline once drawn (the purple outlined words in
 * the display headings). `block` text is drawn as a purple outline first,
 * then its accent block wipes in behind it and the letters fill dark —
 * the outline "becoming" the highlight.
 *
 * How: an outline cannot be drawn progressively in HTML, only in SVG, and
 * SVG text does not wrap. So each word keeps rendering as ordinary HTML
 * text — wrapping, sizing and final look all belong to the page's CSS
 * (`className`) — and only while the animation runs is an SVG copy of the
 * word laid exactly over it, its glyph outlines dash-drawn. When it ends
 * the copies are removed and the HTML text shows again, so there is
 * nothing to keep in sync on resize, and a page without scripts, or with
 * reduced motion, simply shows the finished state.
 *
 * `trigger="load"` starts at once (the hero); `"view"` waits until the
 * text scrolls into view, and keeps it hidden until then.
 */
export function StrokeText({
  children,
  className = "",
  mode = "outline",
  trigger = "view",
}: {
  children: string;
  className?: string;
  mode?: Mode;
  trigger?: "load" | "view";
}) {
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let cancelled = false;
    const timers: number[] = [];
    const overlays: SVGSVGElement[] = [];
    root.classList.add("st-pending");

    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#9d6bff";
    const measure = document.createElement("canvas").getContext("2d");

    const run = () => {
      if (cancelled) return;
      // Unhide before reading styles: while pending, the words' stroke
      // colour is forced transparent, and that is what would be copied.
      // Nothing paints in between — st-drawing hides them again below,
      // in the same task.
      root.classList.remove("st-pending");
      const words = Array.from(root.querySelectorAll<HTMLElement>(".st-word"));
      words.forEach((word, i) => {
        const cs = getComputedStyle(word);
        const rect = word.getBoundingClientRect();
        const size = parseFloat(cs.fontSize);
        const strokeWidth = parseFloat(cs.getPropertyValue("-webkit-text-stroke-width")) || Math.max(1.2, size * 0.012);
        const stroke = mode === "block" ? accent : cs.getPropertyValue("-webkit-text-stroke-color") || accent;
        let ascent = size * 0.8;
        if (measure) {
          measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          ascent = measure.measureText(word.textContent ?? "").fontBoundingBoxAscent || ascent;
        }

        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("class", "st-svg");
        svg.setAttribute("width", String(rect.width));
        svg.setAttribute("height", String(rect.height));
        svg.setAttribute("aria-hidden", "true");
        const text = document.createElementNS(ns, "text");
        text.setAttribute("x", "0");
        text.setAttribute("y", String(ascent));
        const content = word.textContent ?? "";
        text.textContent = cs.textTransform === "uppercase" ? content.toUpperCase() : content;
        Object.assign(text.style, {
          fontFamily: cs.fontFamily,
          fontWeight: cs.fontWeight,
          fontSize: cs.fontSize,
          fontStretch: cs.fontStretch,
          letterSpacing: cs.letterSpacing,
          stroke,
          strokeWidth: `${strokeWidth}px`,
        });
        // The dash must outrun the longest glyph outline (a heavy expanded
        // W or M runs to about 5-6em) or that glyph ends with a gap; any
        // longer and small glyphs finish in the first instant. 8em.
        text.style.setProperty("--st-len", String(Math.round(size * 8)));
        text.style.animationDelay = `${i * STAGGER_MS}ms`;
        svg.appendChild(text);
        word.appendChild(svg);
        overlays.push(svg);
      });

      root.classList.add("st-drawing");
      const drawn = DRAW_MS + STAGGER_MS * (words.length - 1);

      if (mode === "block") {
        timers.push(window.setTimeout(() => root.classList.add("st-filling"), drawn - 200));
      }
      timers.push(
        window.setTimeout(
          () => {
            overlays.forEach((svg) => svg.remove());
            root.classList.remove("st-drawing", "st-filling");
          },
          drawn + (mode === "block" ? FILL_MS : 0),
        ),
      );
    };

    let observer: IntersectionObserver | undefined;
    document.fonts.ready.then(() => {
      if (cancelled) return;
      if (trigger === "load") return run();
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect();
            run();
          }
        },
        { rootMargin: "0px 0px -15% 0px" },
      );
      observer.observe(root);
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      timers.forEach((t) => window.clearTimeout(t));
      overlays.forEach((svg) => svg.remove());
      root.classList.remove("st-pending", "st-drawing", "st-filling");
    };
  }, [mode, trigger]);

  const words = children.split(" ");
  return (
    <span ref={rootRef} className={`stroke-text stroke-text--${mode} ${className}`.trim()}>
      {words.map((word, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          <span className="st-word">{word}</span>
        </Fragment>
      ))}
    </span>
  );
}
