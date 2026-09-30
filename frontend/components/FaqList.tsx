"use client";

import { useRef, type MouseEvent } from "react";

export type FaqEntry = { q: string; a: string };

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * One FAQ entry: a native <details>, so it stays keyboard-operable and
 * readable with scripts off, with its open and close animated. A
 * <details> snaps between states on its own, so the summary's click is
 * taken over — the answer's height is animated with the Web Animations
 * API, and `open` is set before opening and cleared only once closing has
 * finished, so the content is there for the whole animation.
 *
 * data-state flips at the click rather than at the end, so the +/−
 * marker turns with the motion. Reduced motion skips the animation.
 */
function FaqItem({ entry, index, delay }: { entry: FaqEntry; index: number; delay: number }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const running = useRef<Animation | null>(null);

  const toggle = (event: MouseEvent) => {
    const details = detailsRef.current;
    const body = bodyRef.current;
    if (!details || !body) return;
    event.preventDefault();

    const opening = details.dataset.state !== "open";
    details.dataset.state = opening ? "open" : "closed";
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      details.open = opening;
      return;
    }

    const from = running.current ? body.getBoundingClientRect().height : opening ? 0 : body.scrollHeight;
    running.current?.cancel();
    if (opening) details.open = true;
    const to = opening ? body.scrollHeight : 0;

    const animation = body.animate(
      [
        { height: `${from}px`, opacity: opening ? 0 : 1 },
        { height: `${to}px`, opacity: opening ? 1 : 0 },
      ],
      { duration: opening ? 420 : 320, easing: EASE },
    );
    running.current = animation;
    animation.onfinish = () => {
      running.current = null;
      if (!opening) details.open = false;
    };
  };

  return (
    <details
      ref={detailsRef}
      className="faq-item"
      data-state="closed"
      data-reveal
      data-reveal-delay={String(delay)}
      // Keeps the marker right when the browser opens it without a click
      // (find-in-page reveals a matching answer, for one).
      onToggle={(event) => {
        if (!running.current) event.currentTarget.dataset.state = event.currentTarget.open ? "open" : "closed";
      }}
    >
      <summary onClick={toggle}>
        <span className="faq-n">{String(index + 1).padStart(2, "0")}</span>
        <span className="faq-q">{entry.q}</span>
        <span className="faq-mark" aria-hidden="true" />
      </summary>
      <div ref={bodyRef} className="faq-body">
        <p>{entry.a}</p>
      </div>
    </details>
  );
}

export function FaqList({ items }: { items: FaqEntry[] }) {
  return (
    <div className="faq-list">
      {items.map((entry, i) => (
        <FaqItem key={entry.q} entry={entry} index={i} delay={70 * i} />
      ))}
    </div>
  );
}
