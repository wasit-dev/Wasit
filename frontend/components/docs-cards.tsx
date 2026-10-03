import Link from "next/link"
import type { LucideIcon } from "lucide-react"
import {
  Info,
  Rocket,
  Download,
  Workflow,
  SquareTerminal,
  Cable,
  Package,
  Settings2,
  ListChecks,
  ShieldCheck,
  ArrowUpRight,
} from "lucide-react"

/**
 * The card index of the whole documentation set, and the two calls to
 * action above it.
 *
 * This used to be the /docs landing page in its own right. It now runs
 * at the bottom of Overview -> Wasit instead, so the sidebar's first
 * entry and the docs' front door are one page rather than two that say
 * much the same thing; /docs redirects there (see next.config.ts).
 *
 * Rendered as children of DocsArticle, after that page's markdown, so
 * the cards sit under the prose rather than replacing it. Each section
 * heading is a real <h2 id="..."> so the right-hand DocsToc picks them
 * up exactly as it does markdown headings — it scans rendered DOM, not
 * the markdown source.
 */

type DocCardData = {
  href: string
  icon: LucideIcon
  title: string
  description: string
}

type DocSection = {
  id: string
  title: string
  cards: DocCardData[]
}

const SECTIONS: DocSection[] = [
  {
    id: "overview",
    title: "Overview",
    cards: [
      {
        href: "/docs/overview/wasit",
        icon: Info,
        title: "Wasit",
        description: "What the tool is, what it checks, and what it deliberately does not.",
      },
      {
        href: "/docs/overview/how-it-works",
        icon: Workflow,
        title: "How It Works",
        description: "The conceptual flow behind every check Wasit runs.",
      },
    ],
  },
  {
    id: "getting-started",
    title: "Getting Started",
    cards: [
      {
        href: "/docs/start/requirements",
        icon: ListChecks,
        title: "Requirements",
        description: "Node version, testnet keys, and which AI clients can run the MCP server.",
      },
      {
        href: "/docs/start/try-it",
        icon: Rocket,
        title: "Try it in one command",
        description: "One npx line. No install, no keys, nothing settles on-chain.",
      },
      {
        href: "/docs/start/quick-setup",
        icon: SquareTerminal,
        title: "Quick setup",
        description: "Install the CLI and fund a testnet wallet, on macOS, Linux, or Windows.",
      },
      {
        href: "/docs/install/packages",
        icon: Download,
        title: "Install",
        description: "The three npm packages, running from source, and verifying it worked.",
      },
    ],
  },
  {
    id: "guides",
    title: "Guides",
    cards: [
      {
        href: "/docs/cli/overview",
        icon: SquareTerminal,
        title: "CLI Guide",
        description: "Every command, flag, and exit code for the wasit CLI.",
      },
      {
        href: "/docs/mcp/overview",
        icon: Cable,
        title: "MCP Guide",
        description: "Wire Wasit into Claude Code, Copilot, Codex, Cursor, VS Code, or any MCP client.",
      },
      {
        href: "/docs/core/overview",
        icon: Package,
        title: "Core Guide",
        description: "The check-suite library the CLI and MCP server both run on — build your own tooling on top of it.",
      },
    ],
  },
  {
    id: "reference",
    title: "Reference",
    cards: [
      {
        href: "/docs/configuration/overview",
        icon: Settings2,
        title: "Configuration",
        description: "Networks, testnet keys, and what each check needs to run.",
      },
      {
        href: "/docs/checks/overview",
        icon: ListChecks,
        title: "Check Catalogue",
        description: "Every compliance check Wasit runs, x402 and MPP alike.",
      },
      {
        href: "/docs/security/overview",
        icon: ShieldCheck,
        title: "Security Policy",
        description: "Testnet-only guarantees, authorization rules, and how to report a vulnerability.",
      },
    ],
  },
]

function DocCard({ href, icon: Icon, title, description }: DocCardData) {
  return (
    <Link href={href} className="docs-cards-card">
      <Icon className="docs-cards-card-icon" aria-hidden />
      <div className="docs-cards-card-body">
        <div className="docs-cards-card-title">{title}</div>
        <div className="docs-cards-card-desc">{description}</div>
      </div>
      <ArrowUpRight className="docs-cards-card-arrow" aria-hidden />
    </Link>
  )
}

export function DocsCards() {
  return (
    <>
      <div className="docs-cards-cta">
        <Link href="/docs/start/try-it" className="docs-cards-cta-primary">
          Try it in one command
        </Link>
        <Link href="/docs/install/packages" className="docs-cards-cta-secondary">
          Install
        </Link>
      </div>

      {SECTIONS.map((section) => (
        <section key={section.id} className="docs-cards-section">
          <h2 id={section.id}>{section.title}</h2>
          <div className="docs-cards-grid">
            {section.cards.map((card) => (
              <DocCard key={card.href} {...card} />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}
