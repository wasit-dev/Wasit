import Link from "next/link";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { CopyButton } from "@/components/CopyButton";
import { CliDemo } from "@/components/CliDemo";
import { ClientLogo, MCP_CLIENTS } from "@/components/ClientLogo";
import { Crosshair } from "@/components/Crosshair";
import { FaqList, type FaqEntry } from "@/components/FaqList";
import { McpSession } from "@/components/McpSession";
import { SequenceFlow } from "@/components/SequenceFlow";
import { StackStrip } from "@/components/StackStrip";
import { StrokeText } from "@/components/StrokeText";
import { TechText } from "@/components/TechText";
import { ScrollReveal } from "@/components/ScrollReveal";
import { CHECK_COUNT, WASIT_VERSION } from "@/lib/site-facts";

// The one command on the page with a copy button, so it has to be the
// safe one. --read-only is not optional here: without it the payment
// checks X402-06..10 run as soon as a STELLAR_PRIVATE_KEY is in scope,
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
    with: "Settlement is read from the token contract's own transfer event via Stellar RPC, and from each chain's own record on Base, Ethereum and Solana testnets.",
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
    body: "The same checks as MCP tools, for Claude Code, Codex, Cursor, VS Code and any other MCP client.",
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

type McpTool = { name: string; checks: string; cost: string; warn?: boolean };

// The MCP server's tools, as packages/server/README.md lists them. The
// fourth is registered only with an explicit opt-in.
const MCP_TOOLS: McpTool[] = [
  { name: "wasit_x402_test", checks: "X402-01–10", cost: "06 settles a real testnet payment; 07–10 must be refused" },
  { name: "wasit_mpp_charge_test", checks: "MPP-01", cost: "Settles a testnet payment every call" },
  { name: "wasit_mpp_channel_test", checks: "MPP-10–12, 14", cost: "Free" },
  { name: "wasit_mpp_channel_test_with_close", checks: "+ MPP-13", cost: "Opt-in only · closes a channel for good", warn: true },
];

// Registers the server with Claude Code; nothing else is needed for the
// read-only x402 checks (docs/guides/mcp.md covers the keys for the rest).
const MCP_CMD = "claude mcp add --transport stdio wasit -- npx -y @wasit-dev/server";

const FAQ_ITEMS: FaqEntry[] = [
  {
    q: "Does it cost anything to run?",
    a: "Read-only checks are free. Checks that spend or mutate state are opt-in and clearly flagged before they run.",
  },
  {
    q: "Is this safe to point at a service I don't control?",
    a: "Destructive checks require an explicit flag and only run against a channel you name as disposable. Wasit is built for testnets: Stellar testnet first, and Base Sepolia, Ethereum Sepolia and Solana devnet for the x402 payment checks.",
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
function InstallTerminal({
  cmd = INSTALL_CMD,
  title = "~/your-service",
  children,
}: {
  cmd?: string;
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="terminal">
      <div className="terminal-bar">
        <span className="terminal-controls" aria-hidden="true">
          <span className="terminal-dot terminal-dot-red" />
          <span className="terminal-dot terminal-dot-yellow" />
          <span className="terminal-dot terminal-dot-green" />
        </span>
        <span className="terminal-title">{title}</span>
        <span>zsh</span>
      </div>
      <div className="cmdbox">
        <code className="mono">$ {cmd}</code>
        <CopyButton text={cmd} />
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
              <TechText text="WASIT" />
            </span>
            <span className="hero-word-outline hero-rise" style={{ "--rise-delay": "200ms" } as React.CSSProperties}>
              <StrokeText trigger="load">x402 / MPP</StrokeText>
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

        <StackStrip />

        <section id="comparison" className="band">
          <div className="frame">
            <SectionHead n="01" title="What changes" note="// same request, two verdicts" />
            <h2 className="display" data-reveal>
              A 200 OK is{" "}
              <StrokeText mode="block" className="display-hl">
                not a settlement.
              </StrokeText>
            </h2>
            {/* Two panels side by side: what a service's own response
                leaves unproven, struck through, and what Wasit checks
                instead, on the accent. Same rows, same order. */}
            <div className="versus" data-reveal>
              <div className="versus-panel versus-panel--without">
                <div className="versus-head">
                  <span>Without Wasit</span>
                  <span>[ 0/{COMPARE_ROWS.length} ]</span>
                </div>
                <ul>
                  {COMPARE_ROWS.map((row) => (
                    <li key={row.without}>
                      <span className="versus-mark" aria-hidden="true">–</span>
                      <s>{row.without}</s>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="versus-panel versus-panel--with">
                <div className="versus-head">
                  <span>With Wasit</span>
                  <span>
                    [ {COMPARE_ROWS.length}/{COMPARE_ROWS.length} ]
                  </span>
                </div>
                <ul>
                  {COMPARE_ROWS.map((row) => (
                    <li key={row.with}>
                      <span className="versus-mark" aria-hidden="true">+</span>
                      <span>{row.with}</span>
                    </li>
                  ))}
                </ul>
              </div>
              {/* A box walks request → pay → verify and starts over (CSS
                  only, see .versus-flow in globals.css). */}
              <div className="versus-flow" aria-hidden="true">
                <span className="versus-step">Request</span>
                <span className="versus-step">Pay</span>
                <span className="versus-step">Verify on-chain</span>
              </div>
            </div>
          </div>
        </section>

        {/* The one band in the second colour: the section the tool exists
            for, set apart the way a poster sets apart its headline. */}
        <section id="how-it-works" className="band band--signal">
          <div className="frame">
            <SectionHead n="02" title="How it works" note="// http + rpc" />
            <h2 className="display" data-reveal>
              It never trusts <StrokeText className="display-outline">the receipt.</StrokeText>
            </h2>
            <p className="section-lead" data-reveal>
              Wasit talks to two things: your service, over HTTP, and Stellar,
              over RPC. It <mark className="hl-ink">never trusts the first</mark> about
              what happened on the second.
            </p>
            <SequenceFlow />
            <p className="section-body" data-reveal>
              Steps 5 and 6 are the point of the tool: Wasit calls Stellar RPC
              directly and checks the transfer event itself, instead of
              trusting your service&apos;s receipt about what happened on chain.
              On Base, Ethereum and Solana testnets the x402 checks read that
              chain&apos;s RPC the same way.{" "}
              <Link href="/docs/overview/how-it-works">Full flow in the docs →</Link>
            </p>
          </div>
        </section>

        <section id="packages" className="band">
          <div className="frame">
            <SectionHead n="03" title="Three packages" note="// one core" />
            <h2 className="display" data-reveal>
              One suite. <StrokeText className="display-outline">Three ways in.</StrokeText>
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

        <section id="mcp" className="band">
          <div className="frame">
            <SectionHead n="04" title="MCP tools" note="// for agents" />
            <h2 className="display" data-reveal>
              Your agent <StrokeText className="display-outline">runs the checks.</StrokeText>
            </h2>
            <div className="mcp-grid">
              <div className="mcp-side" data-reveal>
                <p className="section-lead">
                  The MCP server puts the same checks in front of Claude Code, GitHub Copilot, Codex, Cursor,
                  VS Code and any other MCP client — as <mark className="hl">tools it can call</mark>, with the check catalogue as a
                  resource it can read first.
                </p>
                {/* Each client links to its own config in the MCP guide. */}
                <div className="mcp-clients">
                  <span className="mcp-clients-label">Works with</span>
                  <ul>
                    {MCP_CLIENTS.map((client) => (
                      <li key={client.name}>
                        <Link href={client.href}>
                          <ClientLogo mark={client.mark} className="mcp-client-mark" />
                          {client.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
                <ul className="mcp-tools">
                  {MCP_TOOLS.map((tool) => (
                    <li key={tool.name} className={tool.warn ? "is-warn" : undefined}>
                      <code>{tool.name}</code>
                      <span className="mcp-tools-checks">{tool.checks}</span>
                      <span className="mcp-tools-cost">{tool.cost}</span>
                    </li>
                  ))}
                </ul>
                <InstallTerminal cmd={MCP_CMD} title="~" />
              </div>
              <div data-reveal data-reveal-delay="120">
                <McpSession />
              </div>
            </div>
          </div>
        </section>

        <section id="faq" className="band">
          <div className="frame faq-grid">
            <div>
              <SectionHead n="05" title="FAQ" note="// before you run it" />
              <h2 className="display" data-reveal>
                Questions<StrokeText className="display-outline">.</StrokeText>
              </h2>
              <p className="section-lead" data-reveal>
                The things people usually ask <mark className="hl">before running it.</mark>
              </p>
            </div>
            <FaqList items={FAQ_ITEMS} />
          </div>
        </section>

        <section id="get-started" className="band cta">
          <div className="frame">
            <SectionHead n="06" title="Get started" note="// one command" />
            <div className="cta-grid">
              <h2 className="display display-xl" data-reveal>
                Point it at{" "}
                <StrokeText mode="block" className="display-hl">
                  your service.
                </StrokeText>
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
