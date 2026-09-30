import Image from "next/image"
import "./SequenceFlow.css"

type Actor = "service" | "wasit" | "stellar"

type Step = {
  n: string
  label: string
  from: Actor
  to: Actor
  /** A short aside printed after the label. */
  note?: string
}

// The six messages of a paid request, in order. 01–04 are the HTTP
// exchange with the service under test; 05–06 are Wasit going to Stellar
// itself, which is the whole point of the tool. "Transfer event" rather
// than a CAP number: Wasit reads both the CAP-46 and the CAP-67 forms.
const STEPS: Step[] = [
  { n: "01", label: "unpaid request", from: "wasit", to: "service" },
  { n: "02", label: "402 challenge", from: "service", to: "wasit" },
  { n: "03", label: "signed payment", from: "wasit", to: "service" },
  { n: "04", label: "2xx receipt", from: "service", to: "wasit", note: "the service's own claim" },
  { n: "05", label: "RPC: getTransaction", from: "wasit", to: "stellar" },
  { n: "06", label: "transfer event verified", from: "stellar", to: "wasit" },
]

const NAMES: Record<Actor, string> = { service: "your service", wasit: "Wasit", stellar: "Stellar" }

function StellarMark() {
  return (
    <svg viewBox="0 0 236.36 200" className="seq-logo seq-logo--stellar" aria-hidden="true">
      <path d="M203,26.16l-28.46,14.5-137.43,70a82.49,82.49,0,0,1-.7-10.69A81.87,81.87,0,0,1,158.2,28.6l16.29-8.3,2.43-1.24A100,100,0,0,0,18.18,100q0,3.82.29,7.61a18.19,18.19,0,0,1-9.88,17.58L0,129.57V150l25.29-12.89,0,0,8.19-4.18,8.07-4.11v0L186.43,55l16.28-8.29,33.65-17.15V9.14Z" />
      <path d="M236.36,50,49.78,145,33.5,153.31,0,170.38v20.41l33.27-16.95,28.46-14.5L199.3,89.24A83.45,83.45,0,0,1,200,100,81.87,81.87,0,0,1,78.09,171.36l-1,.53-17.66,9A100,100,0,0,0,218.18,100c0-2.57-.1-5.14-.29-7.68a18.2,18.2,0,0,1,9.87-17.58l8.6-4.38Z" />
    </svg>
  )
}

/**
 * "How it works" as a sequence diagram drawn in HTML and CSS: three
 * lifelines — your service, Wasit, Stellar — with Wasit in the middle, so
 * the HTTP exchange runs to its left and the RPC check to its right. The
 * geometry says what the tool is: it stands between a service and the
 * chain, and asks the chain rather than believing the service.
 *
 * Replaces a React Flow canvas. There is nothing to zoom or drag, so the
 * library bought nothing but weight. Each step is a real list item with
 * its route in words (visible on phones, where the lifelines give way to
 * a plain list), and the rows rise in with ScrollReveal. A square packet
 * runs along every arrow, tail to head; reduced motion stops it.
 */
export function SequenceFlow() {
  return (
    <div className="seq">
      <div className="seq-cols" aria-hidden="true">
        <div className="seq-col">
          <span className="seq-col-name">Your service</span>
          <small>the target</small>
        </div>
        <div className="seq-col seq-col--wasit">
          <Image src="/mark.png" alt="" width={316} height={256} className="seq-logo" />
          <span className="seq-col-name">Wasit</span>
          <small>the checker</small>
        </div>
        <div className="seq-col">
          <StellarMark />
          <span className="seq-col-name">Stellar</span>
          <small>the source of truth</small>
        </div>
      </div>

      <ol className="seq-rows">
        {STEPS.map((step, i) => {
          const side = step.from === "stellar" || step.to === "stellar" ? "right" : "left"
          // Which end of the arrow carries the head: the side of whoever receives.
          const head = step.to === "wasit" ? (side === "left" ? "right" : "left") : side
          return (
            <li
              key={step.n}
              className={`seq-row seq-row--${side}${side === "right" ? " seq-row--rpc" : ""}`}
              data-head={head}
              data-reveal
              data-reveal-delay={String(140 * i)}
            >
              <span className="seq-label">
                <b>{step.n}</b>
                {step.label}
                {step.note && <em>{step.note}</em>}
              </span>
              <span className="seq-route">
                {NAMES[step.from]} → {NAMES[step.to]}
              </span>
              <span className="seq-arrow" aria-hidden="true">
                <i className="seq-packet" style={{ animationDelay: `${i * 0.35}s` }} />
              </span>
            </li>
          )
        })}
      </ol>

      <div className="seq-foot">
        <div>01–04 · http · what the service says</div>
        <div>05–06 · rpc · what the chain recorded</div>
      </div>
    </div>
  )
}
