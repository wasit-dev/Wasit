"use client";

import { useEffect, useRef } from "react";

// Anything the pointer can act on. Over one of these the lines switch to
// --accent-2, so the crosshair doubles as a hover signal.
const INTERACTIVE = "a, button, summary, input, [role='button']";

/**
 * Full-viewport crosshair that trails the pointer: one horizontal and one
 * vertical hairline in the accent. Inspired by reactbits.dev's Crosshair,
 * written here from scratch with no animation library, the same way the
 * site's other effects are.
 *
 * The native cursor stays: the lines are decoration, not the pointer. They
 * only run on a fine pointer (touch has nothing to follow), sit above the
 * page with pointer-events: none so they never intercept a click, and ease
 * toward the pointer with a rAF loop that stops once they catch up.
 * Reduced motion drops the easing; the lines then jump with the pointer.
 * Over a section marked data-crosshair="light" the colours swap for ones
 * that show on a light ground.
 */
export function Crosshair() {
  const rootRef = useRef<HTMLDivElement>(null);
  const hRef = useRef<HTMLSpanElement>(null);
  const vRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const h = hRef.current;
    const v = vRef.current;
    if (!root || !h || !v || !window.matchMedia("(pointer: fine)").matches) return;

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
        root.dataset.shown = "true";
      }
      const target = event.target instanceof Element ? event.target : null;
      root.dataset.active = target?.closest(INTERACTIVE) ? "true" : "false";
      // A section drawn in --accent-2 marks itself data-crosshair="light";
      // yellow lines would vanish on it, so they switch to dark there.
      root.dataset.surface = target?.closest("[data-crosshair='light']") ? "light" : "dark";
      if (!frame) frame = requestAnimationFrame(draw);
    };

    const onLeave = () => {
      shown = false;
      root.dataset.shown = "false";
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={rootRef} className="crosshair" aria-hidden="true" data-shown="false">
      <span ref={hRef} className="crosshair-line crosshair-h" />
      <span ref={vRef} className="crosshair-line crosshair-v" />
    </div>
  );
}
