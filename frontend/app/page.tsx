import Link from "next/link";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { CopyButton } from "@/components/CopyButton";
import { HowItWorksFlow } from "@/components/HowItWorksFlow";
import { CliDemo } from "@/components/CliDemo";
import { Crosshair } from "@/components/Crosshair";
import { ScrollReveal } from "@/components/ScrollReveal";
import { CHECK_COUNT, WASIT_VERSION } from "@/lib/site-facts";

// The one command on the page with a copy button, so it has to be the
// safe one. --read-only is not optional here: without it the payment
// checks X402-06/07 run as soon as a STELLAR_PRIVATE_KEY is in scope,
// and the CLI loads .env from whatever directory it was run in — so a
// reader who has followed the configuration docs would settle a real
// testnet payment from what the homepage sells as a first look. Matches
// README.md's own install snippet for the same reason.
const INSTALL_CMD = "npx @wasit-dev/cli test --target <your-service-url> --read-only";
const GITHUB_URL = "https://github.com/wasit-dev/wasit";

// Words for the ticker band under the hero. Every item is a fact the page
// makes elsewhere; the band repeats them, it does not add to them. Set in
// capitals here rather than by CSS, which would also capitalise "x402".
const TICKER_ITEMS = [
  "VERIFY THE SETTLEMENT",
  "x402",
  "MPP",
  "STELLAR TESTNET",
  `${CHECK_COUNT} CHECKS`,
  "CLI · MCP · CORE",
  "APACHE-2.0",
];

type CompareRow = { without: string; with: string };

// "Without" is the failure mode Wasit exists to catch, "with" is the
// specific mechanism that catches it. No new claims, just the existing
// facts (on-chain settlement read, the check catalogue, the negative
// checks) paired up.
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

type PackageCard = { tag: string; name: string; body: string; href: string; cmd: string };

// The three published packages, as each package's own README describes
// them. The CLI and the server are thin adapters over core, which is why
// the cards say "the same checks" rather than listing three feature sets.
const PACKAGES: PackageCard[] = [
  {
    tag: "CLI",
    name: "@wasit-dev/cli",
    body: "The wasit command, for a local run or a CI job. Exit codes separate a failed check from one that could not run.",
    href: "/docs/cli/overview",
    cmd: "npx @wasit-dev/cli checks",
  },
  {
    tag: "MCP",
    name: "@wasit-dev/server",
    body: "The same checks as MCP tools, for Claude Code, Claude Desktop and any other MCP-compatible agent.",
    href: "/docs/mcp/overview",
    cmd: "npx -y @wasit-dev/server",
  },
  {
    tag: "CORE",
    name: "@wasit-dev/core",
    body: "The check suite itself, for building your own tooling on top. The CLI and the server both run it.",
    href: "/docs/core/overview",
    cmd: "npm install @wasit-dev/core",
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

/** The numbered rule that opens every section: "■ 01  TITLE ──── // NOTE". */
function SectionHead({ n, title, note }: { n: string; title: string; note: string }) {
  return (
    <div className="section-head" data-reveal>
      <span className="section-head-n">{n}</span>
      <span className="section-head-title">{title}</span>
      <span className="section-head-rule" aria-hidden="true" />
      <span className="section-head-note">{note}</span>
    </div>
  );
}

/**
 * A terminal frame around the install command; the hero adds CliDemo under
 * it. The three squares are the window controls every terminal on the
 * site carries (docs code blocks too, components/code-block.tsx).
 */
function InstallTerminal({ children }: { children?: React.ReactNode }) {
  return (
    <div className="terminal">
      <div className="terminal-bar">
        <span className="terminal-controls" aria-hidden="true">
          <span className="terminal-dot terminal-dot-red" />
          <span className="terminal-dot terminal-dot-yellow" />
          <span className="terminal-dot terminal-dot-green" />
        </span>
        <span className="terminal-title">~/your-service</span>
        <span>zsh</span>
      </div>
      <div className="cmdbox">
        <code className="mono">$ {INSTALL_CMD}</code>
        <CopyButton text={INSTALL_CMD} />
      </div>
      {children}
    </div>
  );
}

export default function Home() {
  return (
    <>
      <Nav />
      <Crosshair />
      <ScrollReveal />

      <main className="landing">
        <section className="hero" aria-labelledby="hero-title">
          <div className="frame hero-top hero-rise">
            <div className="chip">
              <span className="chip-square" aria-hidden="true" />v{WASIT_VERSION} — {CHECK_COUNT} checks / 3 packages
            </div>
            <div className="hero-meta" aria-hidden="true">
              <span>{CHECK_COUNT} checks</span>
              <span>2 protocols</span>
              <span className="hero-meta-accent">1 rule: verify on-chain</span>
            </div>
          </div>

          {/* Decorative: the h1 below carries the same statement in words. */}
          <div className="frame hero-word" aria-hidden="true">
            <span className="hero-word-solid hero-rise" style={{ "--rise-delay": "80ms" } as React.CSSProperties}>
              WASIT
            </span>
            <span className="hero-word-outline hero-rise" style={{ "--rise-delay": "200ms" } as React.CSSProperties}>
              x402 / MPP
            </span>
          </div>

          <div className="frame hero-bottom">
            <div className="hero-copy hero-rise" style={{ "--rise-delay": "320ms" } as React.CSSProperties}>
              <h1 id="hero-title" className="hero-heading">
                Independent protocol-compliance testing for <mark className="hl">x402</mark> and{" "}
                <mark className="hl">MPP</mark> on Stellar.
              </h1>
              <p className="tagline">
                Wasit runs the real payment flow against your service, not a
                schema check against its response — and verifies settlement{" "}
                <mark className="hl-2">on-chain</mark>, from the token
                contract&rsquo;s own transfer event.
              </p>
              <div className="btn-row">
                <Link href="/docs/start/try-it" className="btn btn-primary">
                  <span aria-hidden="true">▸</span> Get started
                </Link>
                <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener" className="btn btn-ghost">
                  <span aria-hidden="true">↗</span> View on GitHub
                </a>
              </div>
              <p className="hero-trust">
                Open source · Testnet only · No signup ·{" "}
                <Link href="/docs/overview/why">Why we built this</Link>
              </p>
            </div>

            {/* CliDemo streams what a real `wasit test` run prints; see
                CliDemo.tsx for why its text comes from the checks
                themselves. The closing section's terminal stays the plain
                copy-paste command only. */}
            <div className="hero-visual hero-rise" style={{ "--rise-delay": "440ms" } as React.CSSProperties}>
              <InstallTerminal>
                <CliDemo />
              </InstallTerminal>
            </div>
          </div>
        </section>

        <div className="ticker" aria-hidden="true">
          <div className="ticker-track">
            {[0, 1].map((copy) => (
              <div className="ticker-group" key={copy}>
                {TICKER_ITEMS.map((item) => (
                  <span className="ticker-item" key={item}>
                    {item}
                    <span className="ticker-square" />
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>

        <section id="comparison" className="band">
          <div className="frame">
            <SectionHead n="01" title="What changes" note="// same request, two verdicts" />
            <h2 className="display" data-reveal>
              A 200 OK is <span className="display-outline">not a settlement.</span>
            </h2>
            <div className="compare" role="table" aria-label="Without Wasit and with Wasit">
              <div className="compare-row compare-row--head" role="row" data-reveal>
                <span className="compare-n" role="columnheader" aria-label="Row" />
                <span className="compare-cell" role="columnheader">Without Wasit</span>
                <span className="compare-cell compare-cell--with" role="columnheader">
                  <mark className="hl">With Wasit</mark>
                </span>
              </div>
              {COMPARE_ROWS.map((row, i) => (
                <div className="compare-row" role="row" key={row.with} data-reveal data-reveal-delay={String(90 * (i + 1))}>
                  <span className="compare-n" role="cell">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="compare-cell" role="cell">
                    {row.without}
                  </span>
                  <span className="compare-cell compare-cell--with" role="cell">
                    {row.with}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* The one band in the second colour: the section the tool exists
            for, set apart the way a poster sets apart its headline. */}
        <section id="how-it-works" className="band band--signal" data-crosshair="light">
          <div className="frame">
            <SectionHead n="02" title="How it works" note="// http + rpc" />
            <h2 className="display" data-reveal>
              It never trusts <span className="display-outline">the receipt.</span>
            </h2>
            <p className="section-lead" data-reveal>
              Wasit talks to two things: your service, over HTTP, and Stellar,
              over RPC. It <mark className="hl-ink">never trusts the first</mark> about
              what happened on the second.
            </p>
            <div data-reveal>
              <HowItWorksFlow />
            </div>
            <p className="section-body" data-reveal>
              Steps 5 and 6 are the point of the tool: Wasit calls Stellar RPC
              directly and checks the transfer event itself, instead of
              trusting your service&apos;s receipt about what happened on chain.{" "}
              <Link href="/docs/overview/how-it-works">Full flow in the docs →</Link>
            </p>
          </div>
        </section>

        <section id="packages" className="band">
          <div className="frame">
            <SectionHead n="03" title="Three packages" note="// one core" />
            <h2 className="display" data-reveal>
              One suite. <span className="display-outline">Three ways in.</span>
            </h2>
            <div className="packages">
              {PACKAGES.map((pkg, i) => (
                <Link href={pkg.href} className="package" key={pkg.name} data-reveal data-reveal-delay={String(110 * i)}>
                  <div className="package-top">
                    <span>{String(i + 1).padStart(2, "0")}</span>
                    <span>{pkg.tag}</span>
                  </div>
                  <h3 className="package-name">{pkg.name}</h3>
                  <p className="package-body">{pkg.body}</p>
                  <code className="package-cmd">$ {pkg.cmd}</code>
                  <span className="package-more">
                    Read the guide <span aria-hidden="true">→</span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section id="faq" className="band">
          <div className="frame faq-grid">
            <div>
              <SectionHead n="04" title="FAQ" note="// before you run it" />
              <h2 className="display" data-reveal>
                Questions<span className="display-outline">.</span>
              </h2>
              <p className="section-lead" data-reveal>
                The things people usually ask <mark className="hl">before running it.</mark>
              </p>
            </div>
            <div className="faq-list">
              {FAQ_ITEMS.map((item, i) => (
                <details className="faq-item" key={item.q} data-reveal data-reveal-delay={String(70 * i)}>
                  <summary>
                    <span className="faq-n">{String(i + 1).padStart(2, "0")}</span>
                    <span className="faq-q">{item.q}</span>
                  </summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section id="get-started" className="band cta">
          <div className="frame">
            <SectionHead n="05" title="Get started" note="// one command" />
            <div className="cta-grid">
              <h2 className="display display-xl" data-reveal>
                Point it at <span className="display-outline">your service.</span>
              </h2>
              <div className="cta-side" data-reveal data-reveal-delay="120">
                <p className="section-lead">
                  Get a pass/fail report backed by on-chain verification.{" "}
                  <mark className="hl-2">No signup, no config file</mark> required to start.
                </p>
                <InstallTerminal />
                <div className="btn-row">
                  <Link href="/docs/start/try-it" className="btn btn-primary">
                    <span aria-hidden="true">▸</span> Start testing
                  </Link>
                  <Link href="/docs/overview/wasit" className="btn btn-ghost">
                    <span aria-hidden="true">→</span> Read the docs
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
