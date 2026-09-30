import Image from "next/image"
import Link from "next/link"
import { DocsSearch } from "./DocsSearch"

const GITHUB_URL = "https://github.com/wasit-dev/wasit"

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  )
}

/**
 * The site-wide bar: the logo lockup, the landing page's section links,
 * then search, GitHub and a full-height Docs cell. Each group is its own bordered cell so the bar reads as one
 * row of a grid, the same hairline grid the rest of the site is drawn on.
 *
 * Link targets mirror the landing page's section ids (app/page.tsx) —
 * keep the two in sync when either changes. "Quick start" is the one
 * exception and goes straight to the docs page.
 *
 * `variant` adds a DOCS tag to the wordmark on /docs pages
 * (app/docs/layout.tsx passes it): the docs sidebar carries no brand of
 * its own, so this bar is the only place a reader landing mid-docs can
 * tell which surface they are on. A prop rather than usePathname() keeps
 * Nav a server component; the layout already knows the answer.
 */
export function Nav({ variant = "site" }: { variant?: "site" | "docs" } = {}) {
  return (
    <header className="site-header">
      <div className="navbar">
        <Link href="/" className="brand" aria-label={variant === "docs" ? "Wasit Docs" : "Wasit"}>
          {/* width/height carry the lockup's 1280x321 ratio only; CSS sets the height. */}
          <Image src="/logo-light.svg" alt="" width={1280} height={321} className="brand-logo" priority />
          {variant === "docs" && <span className="brand-tag">DOCS</span>}
        </Link>

        <nav className="navlinks" aria-label="Site">
          <Link href="/#comparison">Why</Link>
          <Link href="/#how-it-works">How it works</Link>
          <Link href="/#mcp">MCP</Link>
          <Link href="/#faq">FAQ</Link>
          <Link href="/docs/start/try-it">Quick start</Link>
        </nav>

        <div className="navbar-right">
          <DocsSearch />
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Wasit on GitHub"
            className="nav-icon-link"
          >
            <GitHubIcon />
          </a>
          <Link href="/docs/overview/wasit" className="nav-cta">
            Docs
          </Link>
        </div>
      </div>
    </header>
  )
}
