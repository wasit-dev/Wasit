import type { Metadata } from "next"
import { Nav } from "@/components/Nav"
import { Footer } from "@/components/Footer"
import { DocsToc } from "@/components/docs-toc"

export const metadata: Metadata = {
  title: "Privacy Policy — Wasit",
  description: "Privacy Policy for Wasit, an open-source protocol-compliance tester for the x402 and MPP payment protocols.",
}

export default function PrivacyPage() {
  return (
    <>
      <Nav />
      <div className="wrap legal-page-wrap">
        <div className="legal-page-row">
          <div className="article-wrap">
            <article id="privacy-content" className="typeset legal-typeset">
            <h1>Privacy Policy</h1>
            <p><em>Last updated: 29 September 2026.</em></p>

            <h2 id="scope">1. Scope</h2>
            <p>
              This policy covers two things: this documentation website
              (usewasit.dev and its subpages), and the Wasit CLI, MCP server,
              and core library you install from npm. It doesn’t cover
              third-party services you point Wasit at while testing them —
              their own privacy policies apply to whatever data they
              collect.
            </p>

            <h2 id="this-website">2. This website</h2>
            <p>
              This site uses Vercel Web Analytics to count page views, so
              we can see how many people read the documentation and which
              pages they use. It sets no cookies. A visit is recognised by
              a hash of the incoming request, and that visitor session is
              discarded after 24 hours; no personal identifiers are
              collected, and the data is not tied to any individual or IP
              address. For each page view it records the time, the page,
              the referring site, an approximate location, and the
              browser, operating system and device type. We see only
              aggregated statistics. See{" "}
              <a href="https://vercel.com/docs/analytics/privacy-policy" target="_blank" rel="noreferrer noopener">
                Vercel Web Analytics’ privacy documentation
              </a>
              .
            </p>
            <p>
              The site has no user accounts and no forms that collect
              personal information. Separately, our host, Vercel, keeps
              standard server logs (IP address, requested path, timestamp,
              user agent) for operating and securing the platform — not for
              Wasit. See{" "}
              <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noreferrer noopener">
                Vercel’s privacy policy
              </a>{" "}
              for details on that layer.
            </p>

            <h2 id="cli-mcp-server-core-library">3. The CLI, MCP server, and core library</h2>
            <p>
              Wasit runs on your own machine or infrastructure. It does not
              phone home, does not send telemetry to the maintainer, and
              does not collect usage analytics. When you run a check, it
              talks directly to the payment service and Stellar network
              endpoints you configure — those requests go where you point
              them, not through Wasit’s maintainer.
            </p>

            <h2 id="third-party-links">4. Third-party links</h2>
            <p>
              Pages here link out to GitHub, npm, X, and Stellar
              documentation. Once you follow one of those links, that
              site’s own privacy policy applies.
            </p>

            <h2 id="changes">5. Changes</h2>
            <p>
              If this policy changes in a way that matters, the date at
              the top of this page will be updated.
            </p>

            <h2 id="contact">6. Contact</h2>
            <p>
              Questions can be raised as an issue on{" "}
              <a href="https://github.com/wasit-dev/wasit" target="_blank" rel="noreferrer noopener">
                GitHub
              </a>{" "}
              or via{" "}
              <a href="https://x.com/wasithq" target="_blank" rel="noreferrer noopener">
                X
              </a>.
            </p>
            </article>
          </div>
          <DocsToc contentSelector="#privacy-content" className="legal-toc" />
        </div>
      </div>
      <Footer />
    </>
  )
}
