"use client";

import { useEffect, useRef } from "react";

const HOLD_MS = 1900; // how long each letter stays selected
const START_MS = 1500; // let the hero finish rising first
const SWAP_MS = 260; // letter turns to its dashed outline as the box lands

// Canvas takes font-stretch as a keyword, not a percentage.
const STRETCH: [number, string][] = [
  [50, "ultra-condensed"], [62.5, "extra-condensed"], [75, "condensed"], [87.5, "semi-condensed"],
  [100, "normal"], [112.5, "semi-expanded"], [125, "expanded"], [150, "extra-expanded"], [200, "ultra-expanded"],
];
const stretchKeyword = (percent: string) => {
  const value = parseFloat(percent) || 100;
  return STRETCH.reduce((best, cur) => (Math.abs(cur[0] - value) < Math.abs(best[0] - value) ? cur : best))[1];
};

/**
 * A design-tool selection that inspects one letter at a time — inspired
 * by reactbits.dev's Tech Text, written here from scratch. A box with
 * corner handles moves from letter to letter, labelled with the letter
 * and its measured size, and the selected letter shows as a dashed
 * outline instead of solid. A referee measuring the word, in short.
 *
 * The box fits the glyph's ink, from canvas text metrics: cap height
 * vertically, and horizontally too where the browser's canvas takes a
 * font-stretch (the hero word is expanded); elsewhere it falls back to
 * the letter's advance. The dashed outline is an SVG copy
 * of the letter laid over it while selected, the same technique as
 * StrokeText, so the HTML letter is untouched otherwise.
 *
 * Decorative (the hero word is aria-hidden). It only runs while on
 * screen, and not at all with reduced motion.
 */
export function TechText({ text }: { text: string }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const box = boxRef.current;
    const label = labelRef.current;
    if (!root || !box || !label || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const letters = Array.from(root.querySelectorAll<HTMLElement>(".tt-letter"));
    const measure = document.createElement("canvas").getContext("2d");
    let index = -1;
    let overlay: SVGSVGElement | null = null;
    let selected: HTMLElement | null = null;
    let timers: number[] = [];
    let visible = false;
    let running = false;

    const clearGlyph = () => {
      overlay?.remove();
      overlay = null;
      selected?.classList.remove("is-selected");
      selected = null;
    };

    const place = (letter: HTMLElement, swapGlyph: boolean) => {
      const cs = getComputedStyle(letter);
      const r = letter.getBoundingClientRect();
      const rr = root.getBoundingClientRect();
      const size = parseFloat(cs.fontSize);
      let ascent = size * 0.9;
      let inkTop = size * 0.2;
      let inkBottom = size * 0.9;
      let inkLeft = 0;
      let inkWidth = r.width;
      if (measure) {
        measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const stretchable = "fontStretch" in measure;
        if (stretchable) measure.fontStretch = stretchKeyword(cs.fontStretch) as CanvasFontStretch;
        const m = measure.measureText(letter.textContent ?? "");
        ascent = m.fontBoundingBoxAscent || ascent;
        inkTop = ascent - (m.actualBoundingBoxAscent || ascent * 0.75);
        inkBottom = ascent + (m.actualBoundingBoxDescent || 0);
        if (stretchable && m.actualBoundingBoxRight) {
          inkLeft = -m.actualBoundingBoxLeft;
          inkWidth = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
        }
      }
      const left = r.left - rr.left + inkLeft;
      const top = r.top - rr.top + inkTop;
      const width = inkWidth;
      const height = inkBottom - inkTop;
      box.style.transform = `translate(${left}px, ${top}px)`;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      label.textContent = `${letter.textContent} ${Math.round(width)} × ${Math.round(height)}`;

      if (!swapGlyph) return;
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("class", "tt-svg");
      svg.setAttribute("width", String(r.width));
      svg.setAttribute("height", String(r.height));
      const glyph = document.createElementNS(ns, "text");
      glyph.setAttribute("x", "0");
      glyph.setAttribute("y", String(ascent));
      glyph.textContent = letter.textContent;
      Object.assign(glyph.style, {
        fontFamily: cs.fontFamily,
        fontWeight: cs.fontWeight,
        fontSize: cs.fontSize,
        fontStretch: cs.fontStretch,
        strokeWidth: `${Math.max(1.5, size * 0.006)}px`,
        strokeDasharray: `${Math.round(size * 0.035)} ${Math.round(size * 0.028)}`,
      });
      svg.appendChild(glyph);
      letter.appendChild(svg);
      letter.classList.add("is-selected");
      overlay = svg;
      selected = letter;
    };

    const step = () => {
      index = (index + 1) % letters.length;
      const letter = letters[index]!;
      clearGlyph();
      place(letter, false);
      root.dataset.active = "true";
      timers.push(window.setTimeout(() => place(letter, true), SWAP_MS));
      timers.push(window.setTimeout(step, HOLD_MS));
    };

    const start = () => {
      if (running) return;
      running = true;
      timers.push(window.setTimeout(step, index < 0 ? START_MS : 0));
    };
    const stop = () => {
      running = false;
      timers.forEach((t) => window.clearTimeout(t));
      timers = [];
      clearGlyph();
      root.dataset.active = "false";
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start();
      else stop();
    });
    observer.observe(root);

    // A resize moves the letters: redo the current selection in place.
    const onResize = () => {
      if (!running || index < 0) return;
      clearGlyph();
      place(letters[index]!, true);
    };
    window.addEventListener("resize", onResize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      stop();
    };
  }, []);

  return (
    <span ref={rootRef} className="tech-text" data-active="false">
      {[...text].map((ch, i) => (
        <span key={i} className="tt-letter">
          {ch}
        </span>
      ))}
      <span ref={boxRef} className="tt-box" aria-hidden="true">
        <span ref={labelRef} className="tt-label" />
        <i className="tt-handle tt-handle--tl" />
        <i className="tt-handle tt-handle--tr" />
        <i className="tt-handle tt-handle--bl" />
        <i className="tt-handle tt-handle--br" />
      </span>
    </span>
  );
}
