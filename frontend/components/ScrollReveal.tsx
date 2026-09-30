"use client";

import { useEffect } from "react";

/**
 * Fades and lifts every `[data-reveal]` element into place as it scrolls
 * into view — inspired by reactbits.dev's AnimatedContent, done with one
 * IntersectionObserver instead of an animation library, and without a
 * wrapper element per block so grid and flex layouts are left alone.
 * `data-reveal-delay` (ms) staggers siblings.
 *
 * Content is never hidden before this runs: the hidden starting state in
 * globals.css applies only under html[data-reveal="on"], which is set
 * here, after anything already on screen has been marked as shown. So a
 * page whose script fails to load renders fully visible, and nothing the
 * reader is already looking at blinks out and back in on hydration.
 * Reduced motion skips all of it.
 */
export function ScrollReveal() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.documentElement;
    const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));

    for (const el of elements) {
      const delay = el.dataset.revealDelay;
      if (delay) el.style.setProperty("--reveal-delay", `${delay}ms`);
      if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add("is-revealed");
    }
    root.dataset.reveal = "on";

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-revealed");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    for (const el of elements) if (!el.classList.contains("is-revealed")) observer.observe(el);

    return () => {
      observer.disconnect();
      delete root.dataset.reveal;
    };
  }, []);

  return null;
}
