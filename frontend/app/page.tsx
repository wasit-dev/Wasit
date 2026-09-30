import type { CSSProperties } from "react";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { CopyButton } from "@/components/CopyButton";
import { HowItWorksFlow } from "@/components/HowItWorksFlow";
import { CliDemo } from "@/components/CliDemo";

// The one command on the page with a copy button, so it has to be the
// safe one. --read-only is not optional here: without it the payment
// checks X402-06/07 run as soon as a STELLAR_PRIVATE_KEY is in scope,
// and the CLI loads .env from whatever directory it was run in — so a
// reader who has followed the configuration docs would settle a real
// testnet payment from what the homepage sells as a first look. Matches
// README.md's own install snippet for the same reason.
const INSTALL_CMD = "npx @wasit-dev/cli test --target <your-service-url> --read-only";
const GITHUB_URL = "https://github.com/wasit-dev/wasit";

// Pixel grid for the closing CTA headline's hover reveal (see
// .cta-swap in globals.css) — inspired by
// reactbits.dev/animations/pixel-swap, rebuilt in plain CSS/no new
// dependency rather than pulled from there, since that component is
// part of React Bits' paid Pro collection. (i * 7) % count is a fixed,
// deterministic shuffle (7 and 50 share no common factor, so it
// visits every index exactly once) — not Math.random(), which would
// make the server-rendered stagger order differ from the client's and
// fail hydration. Tuned to a short ~340ms total sweep (see .cta-pixel
// in globals.css) so a normal hover always lands on full coverage
// rather than getting caught mid-wipe.
const CTA_PIXEL_COLS = 10;
const CTA_PIXEL_ROWS = 5;
const CTA_PIXEL_COUNT = CTA_PIXEL_COLS * CTA_PIXEL_ROWS;
const CTA_PIXEL_ORDER = Array.from({ length: CTA_PIXEL_COUNT }, (_, i) => (i * 7) % CTA_PIXEL_COUNT);

type CompareRow = { without: string; with: string };

// Same three ideas the old Features grid made in isolation, reframed
// side by side — "before" is the failure mode Wasit exists to catch,
// "after" is the specific mechanism that catches it. No new claims,
// just the existing facts (on-chain settlement read, the check
// catalogue, the two-interface split) paired up instead of listed flat.
const COMPARE_ROWS: CompareRow[] = [
  {
    without: "A 200 OK is the whole signal — nothing confirms the payment actually settled.",
    with: "Settlement is read from the token contract's own transfer event via Stellar RPC.",
  },
  {
    without: "Payment and channel bugs surface in production, the first time a real payer hits them.",
    with: "The same flow runs ahead of time, including the cases a service is supposed to reject.",
  },
  {
    without: "“It works” means someone tried it once and it didn't error.",
    with: "Every result traces to a specific check and spec clause in the Check Catalogue.",
  },
];

type FaqItem = { q: string; a: string };

const FAQ_ITEMS: FaqItem[] = [
  {
    q: "Does it cost anything to run?",
    a: "Read-only checks are free. Checks that spend or mutate state are opt-in and clearly flagged before they run.",
  },
  {
    q: "Is this safe to point at a service I don't control?",
    a: "Destructive checks require an explicit flag and only run against a channel you name as disposable. Wasit is built for Stellar testnet.",
  },
  {
    q: "What's the difference between the CLI and the MCP server?",
    a: "Same core, two interfaces. The CLI runs from your terminal or a CI job; the MCP server exposes the same checks as tools an agent like Claude Code can call directly.",
  },
  {
    q: "Do I need to sign up or configure anything first?",
    a: "No signup. Run the install command directly with npx — a private key is only needed for checks that touch a payment or channel.",
  },
  {
    q: "Where can I see exactly what each check verifies?",
    a: "The Check Catalogue in the docs lists every check, what it asserts, and which spec or SDK version it was verified against.",
  },
  {
    q: "Is the source available?",
    a: "Yes — Apache-2.0, full source and Check Catalogue on GitHub.",
  },
];

export default function Home() {
  return (
    <>
      <Nav />

      {/* The actual scrolling viewport for everything below Nav — see
          .landing-scroll in globals.css for why this is its own
          overflow region (CSS scroll-snap) rather than plain page
          scroll: it's what makes each scroll gesture land on exactly
          one section instead of an arbitrary position. */}
      <div className="landing-scroll">
        <div className="hero">
          <div className="wrap hero-grid">
            <div className="hero-copy">
              <div className="label hero-kicker">x402 / MPP compliance testing</div>
              <h1 className="hero-heading">
                Independent protocol-compliance testing for <b>x402</b> and{" "}
                <b>MPP</b> on Stellar.
              </h1>
              <p className="tagline">
                Wasit runs the real payment flow against your service, not a
                schema check against its response — and verifies settlement
                on-chain, from the token contract&rsquo;s own transfer event.
              </p>
              <div className="hero-cta-row">
                <Link href="/docs/start/try-it" className="cta-primary">
                  Get started
                </Link>
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="cta-secondary"
                >
                  View on GitHub
                </a>
              </div>
              <div className="hero-trust">
                Open source · Testnet only · No signup required ·{" "}
                <Link href="/docs/overview/why">Why we built this</Link>
              </div>
            </div>

            {/* .terminal/.terminal-bar/.cmdbox keep their existing look
                untouched — only their position in the layout changed,
                from stacked under the copy to its own column beside it.
                CliDemo is new: it continues below .cmdbox, inside the
                same terminal frame, streaming what a real `wasit test`
                run actually prints (see CliDemo.tsx for why the text
                itself is pulled from the real checks rather than
                invented). The CTA section's terminal further down
                deliberately does NOT get this — it stays the plain
                copy-paste install command only. */}
            <div className="hero-visual">
              <div className="label">Try it now</div>
              <div className="terminal">
                <div className="terminal-bar">
                  <span className="terminal-dot terminal-dot-red" />
                  <span className="terminal-dot terminal-dot-yellow" />
                  <span className="terminal-dot terminal-dot-green" />
                </div>
                <div className="cmdbox">
                  <code className="mono">$ {INSTALL_CMD}</code>
                  <CopyButton text={INSTALL_CMD} />
                </div>
                <CliDemo />
              </div>
            </div>
          </div>
        </div>

        {/* Replaces the old flat "Features" grid — same underlying
            facts, framed as what changes when Wasit is in the loop
            instead of a list read in isolation. */}
        <section id="comparison">
          <div className="wrap">
            <h2>What changes with Wasit</h2>
            <p className="section-lead">The same request, checked two different ways.</p>
            <div className="compare-grid">
              <div className="compare-col compare-col--without">
                <h3>Without Wasit</h3>
                <ul>
                  {COMPARE_ROWS.map((row) => (
                    <li key={row.without}>{row.without}</li>
                  ))}
                </ul>
              </div>
              <div className="compare-col compare-col--with">
                <h3>With Wasit</h3>
                <ul>
                  {COMPARE_ROWS.map((row) => (
                    <li key={row.with}>{row.with}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section id="how-it-works">
          <div className="wrap">
            <h2>How it works</h2>
            <p className="section-lead">
              Wasit talks to two things: your service, over HTTP, and Stellar,
              over RPC. It never trusts the first about what happened on the
              second.
            </p>
            <HowItWorksFlow />
            <p className="section-body">
              Steps 5 and 6 are the point of the tool: Wasit calls Stellar RPC
              directly and checks the transfer event itself, instead of
              trusting your service&apos;s receipt about what happened on chain.{" "}
              <Link href="/docs/overview/how-it-works">
                Full flow in the docs →
              </Link>
            </p>
          </div>
        </section>

        <section id="faq">
          <div className="wrap">
            <h2>Frequently asked questions</h2>
            <p className="section-lead">The things people usually ask before running it.</p>
            <div className="faq-list">
              {FAQ_ITEMS.map((item) => (
                <details className="faq-item" key={item.q}>
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section id="get-started" className="cta-section">
          <div className="wrap cta-wrap">
            <div className="cta-card">
              {/* Hover reveal, headline + subtext only — an instant
                  (no stagger, no wipe delay) purple swap, not an
                  animated sweep, in the site's own accent. The code
                  snippet below is deliberately OUTSIDE this zone: it
                  was inside it before, and hovering the card would
                  cover the copy button and make it uncopiable exactly
                  while the mouse was over that area. Keeping the
                  terminal (and its copy button) fully outside .cta-swap
                  means it's never covered, faded, or blocked — always
                  clickable. */}
              <div className="cta-swap">
                <div className="cta-swap-face">
                  <h2>Ready to test your x402 or MPP integration?</h2>
                  <p className="section-lead cta-card-lead">
                    Point it at your service and get a pass/fail report
                    backed by on-chain verification. No signup, no config
                    file required to start.
                  </p>
                </div>

                <div className="cta-pixels" aria-hidden="true">
                  {CTA_PIXEL_ORDER.map((delayRank, i) => (
                    <span
                      key={i}
                      className="cta-pixel"
                      style={{ "--i": delayRank } as unknown as CSSProperties}
                    />
                  ))}
                </div>

                <div className="cta-swap-hover">
                  <span className="cta-swap-hover-eyebrow">One command.</span>
                  <span className="cta-swap-hover-eyebrow">Verified on-chain.</span>
                </div>
              </div>

              {/* Same .terminal/.terminal-bar/.cmdbox chrome as the hero
                  — reused as-is, not a lookalike, so the two stay
                  pixel-identical by construction. Outside .cta-swap on
                  purpose (see comment above) — always visible, copy
                  button always clickable, hover or not. */}
              <div className="terminal cta-terminal">
                <div className="terminal-bar">
                  <span className="terminal-dot terminal-dot-red" />
                  <span className="terminal-dot terminal-dot-yellow" />
                  <span className="terminal-dot terminal-dot-green" />
                </div>
                <div className="cmdbox">
                  <code className="mono">$ {INSTALL_CMD}</code>
                  <CopyButton text={INSTALL_CMD} />
                </div>
              </div>

              <Link href="/docs/start/try-it" className="cta-primary cta-card-button">
                Start testing <span aria-hidden="true">→</span>
              </Link>

              <p className="cta-card-caption">Open source · Testnet only · No signup required</p>
            </div>
          </div>
        </section>

        <Footer />
      </div>
    </>
  );
}
