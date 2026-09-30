"use client";

import { useEffect, useRef } from "react";

// Anything the pointer can act on. Over one of these the lines switch to
// --accent-2, so the crosshair doubles as a hover signal.
const INTERACTIVE = "a, button, summary, input, [role='button']";

const pad = (n: number) => String(Math.max(0, Math.round(n))).padStart(4, "0");

/**
 * Full-viewport crosshair that trails the pointer: one horizontal and one
 * vertical hairline in the accent, and a readout of the pointer's
 * position beside it. Inspired by reactbits.dev's Crosshair, written here
 * from scratch with no animation library.
 *
 * The lines sit BEHIND the page content (z-index 0; every landing band is
 * lifted to 1 in globals.css), so they run through the empty space and
 * never across a word. The readout stays on top: it is small, and it is
 * the part meant to be read. Neither intercepts a click.
 *
 * The native cursor stays: this is decoration, not the pointer. It only
 * runs on a fine pointer (touch has nothing to follow), and eases toward
 * the pointer with a rAF loop that stops once it catches up. Reduced
 * motion drops the easing; the lines then jump with the pointer.
 */
export function Crosshair() {
  const rootRef = useRef<HTMLDivElement>(null);
  const hRef = useRef<HTMLSpanElement>(null);
  const vRef = useRef<HTMLSpanElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const h = hRef.current;
    const v = vRef.current;
    const readout = readoutRef.current;
    if (!root || !h || !v || !readout || !window.matchMedia("(pointer: fine)").matches) return;

    const ease = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 0.2;
    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;
    let frame = 0;
    let shown = false;

    const draw = () => {
      x += (targetX - x) * ease;
      y += (targetY - y) * ease;
      h.style.transform = `translate3d(0, ${y}px, 0)`;
      v.style.transform = `translate3d(${x}px, 0, 0)`;
      // Beside the crossing, flipped to the other side near the right
      // and bottom edges so it never runs off screen.
      const flipX = x > window.innerWidth - 200;
      const flipY = y > window.innerHeight - 70;
      readout.style.transform = `translate3d(${flipX ? x - 18 : x + 18}px, ${flipY ? y - 18 : y + 18}px, 0) translate(${flipX ? "-100%" : "0"}, ${flipY ? "-100%" : "0"})`;
      readout.textContent = `x ${pad(targetX)} · y ${pad(targetY)}`;
      frame = Math.abs(targetX - x) + Math.abs(targetY - y) > 0.3 ? requestAnimationFrame(draw) : 0;
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      targetX = event.clientX;
      targetY = event.clientY;
      if (!shown) {
        x = targetX;
        y = targetY;
        shown = true;
        root.dataset.shown = readout.dataset.shown = "true";
      }
      const target = event.target instanceof Element ? event.target : null;
      root.dataset.active = target?.closest(INTERACTIVE) ? "true" : "false";
      if (!frame) frame = requestAnimationFrame(draw);
    };

    const onLeave = () => {
      shown = false;
      root.dataset.shown = readout.dataset.shown = "false";
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(frame);
    };
  }, []);

  // Two separate fixed layers: a fixed element is its own stacking
  // context, so the readout could not rise above the page from inside the
  // lines' container.
  return (
    <>
      <div ref={rootRef} className="crosshair" aria-hidden="true" data-shown="false">
        <span ref={hRef} className="crosshair-line crosshair-h" />
        <span ref={vRef} className="crosshair-line crosshair-v" />
      </div>
      <span ref={readoutRef} className="crosshair-readout" aria-hidden="true" data-shown="false" />
    </>
  );
}
