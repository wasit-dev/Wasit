import {
  Info,
  Rocket,
  Download,
  SquareTerminal,
  Cable,
  Package,
  Settings2,
  ListChecks,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react"

/**
 * The full site map for /docs, as plain data — no filesystem access, so
 * this is safe to import from both server components (routing, content
 * lookup) and client components (the sidebar, the breadcrumb). It only
 * describes *structure*: titles, icons, and slugs. The actual markdown
 * for each page is resolved separately, server-side only, in
 * lib/content.ts — which imports this file to know how many pages each
 * group needs and in what order (see assertDocsInSync there).
 *
 * Every group's pages[0] is a synthetic "Overview" page (the source
 * file's own intro, before its first "##"); pages[1..] mirror that
 * file's "##" sections in file order. Titles here are a cosmetic shadow
 * of each file's real heading text (run through the same em-dash cleanup
 * as lib/content.ts's cleanHeadingText) — keep them in sync by eye; a
 * mismatch is a stale sidebar label, not a broken page (assertDocsInSync
 * only checks *counts*).
 *
 * "Overview", "Getting Started" and "Install" are the exceptions: their
 * pages are hand-authored (lib/docs-pages.ts) or pulled from a single
 * named section of README.md (see lib/content.ts's resolveDocMarkdown
 * and getHowItWorksMarkdown), not a whole file split by "##", so they
 * are exempt from assertDocsInSync's count check. Nothing mechanical
 * keeps them true — see the note at the top of lib/docs-pages.ts.
 */

export type DocNavPage = { title: string; slug: string[] }

export type DocNavGroup = {
  kind: "group"
  title: string
  icon: LucideIcon
  pages: DocNavPage[]
}

export type DocNavLink = {
  kind: "link"
  title: string
  icon: LucideIcon
  page: DocNavPage
}

export type DocNavEntry = DocNavGroup | DocNavLink

export const DOCS_NAV: DocNavEntry[] = [
  {
    kind: "group",
    title: "Overview",
    icon: Info,
    pages: [
      { title: "Wasit", slug: ["overview", "wasit"] },
      { title: "Why Wasit Exists", slug: ["overview", "why"] },
      { title: "How It Works", slug: ["overview", "how-it-works"] },
    ],
  },
  {
    kind: "group",
    title: "Getting Started",
    icon: Rocket,
    pages: [
      { title: "Requirements", slug: ["start", "requirements"] },
      { title: "Try it in one command", slug: ["start", "try-it"] },
      { title: "Quick setup", slug: ["start", "quick-setup"] },
    ],
  },
  {
    kind: "group",
    title: "Install",
    icon: Download,
    pages: [
      { title: "Packages", slug: ["install", "packages"] },
      { title: "From source", slug: ["install", "from-source"] },
      { title: "Verify the install", slug: ["install", "verify"] },
    ],
  },
  {
    kind: "group",
    title: "CLI Guide",
    icon: SquareTerminal,
    pages: [
      { title: "Overview", slug: ["cli", "overview"] },
      { title: "Interactive mode", slug: ["cli", "interactive"] },
      { title: "Wallet setup", slug: ["cli", "wallet"] },
      { title: "Exit codes", slug: ["cli", "exit-codes"] },
      { title: "Check Catalogue", slug: ["cli", "checks"] },
      { title: "x402 (Test)", slug: ["cli", "test-x402"] },
      { title: "MPP Charge Mode", slug: ["cli", "mpp-charge"] },
      { title: "MPP Channel Mode", slug: ["cli", "mpp-channel"] },
      { title: "Testing an agent that pays", slug: ["cli", "serve"] },
      { title: "Reading output", slug: ["cli", "reading-output"] },
    ],
  },
  {
    kind: "group",
    title: "MCP Guide",
    icon: Cable,
    pages: [
      { title: "Overview", slug: ["mcp", "overview"] },
      { title: "Claude Code & Claude Desktop", slug: ["mcp", "claude-code"] },
      { title: "Codex, Cursor, VS Code and other clients", slug: ["mcp", "other-clients"] },
      { title: "Tools", slug: ["mcp", "tools"] },
      { title: "Resource", slug: ["mcp", "resource"] },
      { title: "Secrets are never tool arguments", slug: ["mcp", "secrets"] },
      { title: "Results", slug: ["mcp", "results"] },
      { title: "Why the destructive tool is a separate tool", slug: ["mcp", "destructive-tool"] },
    ],
  },
  {
    kind: "group",
    title: "Core Guide",
    icon: Package,
    pages: [
      { title: "Overview", slug: ["core", "overview"] },
      { title: "Install & usage", slug: ["core", "usage"] },
      { title: "x402 checks", slug: ["core", "x402"] },
      { title: "MPP modes", slug: ["core", "mpp-modes"] },
      { title: "Reporting & result shapes", slug: ["core", "reporting"] },
      { title: "Design notes", slug: ["core", "design"] },
    ],
  },
  {
    kind: "group",
    title: "Configuration",
    icon: Settings2,
    pages: [
      { title: "Overview", slug: ["configuration", "overview"] },
      { title: "What each check needs", slug: ["configuration", "check-requirements"] },
      { title: "Networks", slug: ["configuration", "networks"] },
      { title: "Getting testnet keys", slug: ["configuration", "testnet-keys"] },
      { title: "The disposable channel", slug: ["configuration", "disposable-channel"] },
    ],
  },
  {
    kind: "group",
    title: "Wasit Check Catalogue",
    icon: ListChecks,
    pages: [
      { title: "Overview", slug: ["checks", "overview"] },
      { title: "x402", slug: ["checks", "x402"] },
      { title: "MPP - Charge Mode", slug: ["checks", "mpp-charge-mode"] },
      { title: "MPP - Channel Mode", slug: ["checks", "mpp-channel-mode"] },
      { title: "Common failures and fixes", slug: ["checks", "common-failures"] },
    ],
  },
  {
    kind: "group",
    title: "Security Policy",
    icon: ShieldCheck,
    pages: [
      { title: "Overview", slug: ["security", "overview"] },
      { title: "Testnet only", slug: ["security", "testnet-only"] },
      { title: "Authorization", slug: ["security", "authorization"] },
      { title: "Checks that spend money", slug: ["security", "spend-money"] },
      { title: "Destructive checks", slug: ["security", "destructive-checks"] },
      { title: "Key handling", slug: ["security", "key-handling"] },
      { title: "Reporting and disclosure", slug: ["security", "disclosure"] },
      { title: "Known advisories in a clean install", slug: ["security", "known-advisories"] },
      { title: "Supported versions", slug: ["security", "supported-versions"] },
    ],
  },
]

/**
 * Every page in DOCS_NAV, in reading order, flattened out of its groups
 * — this is the "book order" a reader moves through with next/prev
 * controls. A `kind: "link"` entry (e.g. "What Is Wasit") contributes
 * its one page with no group label; a `kind: "group"` entry contributes
 * each of its pages tagged with that group's title, so the pager can
 * show "Get Started" as context above "Quick Start" the way a book
 * shows its chapter name above the page title.
 */
export type FlatDocPage = { page: DocNavPage; groupTitle?: string }

export function flatDocPages(): FlatDocPage[] {
  return DOCS_NAV.flatMap((entry) =>
    entry.kind === "link"
      ? [{ page: entry.page }]
      : entry.pages.map((page) => ({ page, groupTitle: entry.title }))
  )
}

/**
 * The previous/next page relative to `slug`, in the same flattened
 * reading order — powers the pager rendered at the bottom of every docs
 * article (components/docs-pager.tsx). Returns undefined on either end
 * for the first/last page in the whole nav, and for a slug that isn't
 * in DOCS_NAV at all (defensive; callers already 404 in that case).
 */
export function getAdjacentDocPages(slug: string[]): {
  prev?: FlatDocPage
  next?: FlatDocPage
} {
  const flat = flatDocPages()
  const key = slug.join("/")
  const index = flat.findIndex((entry) => entry.page.slug.join("/") === key)
  if (index === -1) return {}
  return { prev: flat[index - 1], next: flat[index + 1] }
}

export function findNavPage(slug: string[]): { page: DocNavPage; group?: DocNavGroup } | undefined {
  const key = slug.join("/")
  for (const entry of DOCS_NAV) {
    if (entry.kind === "link" && entry.page.slug.join("/") === key) {
      return { page: entry.page }
    }
    if (entry.kind === "group") {
      const page = entry.pages.find((p) => p.slug.join("/") === key)
      if (page) return { page, group: entry }
    }
  }
  return undefined
}
