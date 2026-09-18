import type { Metadata } from "next"
import { Nav } from "@/components/Nav"
import { Footer } from "@/components/Footer"
import { DocsToc } from "@/components/docs-toc"

export const metadata: Metadata = {
  title: "Terms of Service — Wasit",
  description: "Terms of Service for Wasit, an open-source protocol-compliance tester for the x402 and MPP protocols on Stellar.",
}

/**
 * Standalone legal page: the same .article-wrap prose column as
 * app/legal/privacy/page.tsx, paired with a sticky Line Sidebar-style table
 * of contents (components/docs-toc.tsx). Content is written directly
 * here (not pulled from a repo doc) since it's specific to the hosted
 * site rather than the project's own documentation.
 */
export default function TermsPage() {
  return (
    <>
      <Nav />
      <div className="wrap legal-page-wrap">
        <div className="legal-page-row">
          <div className="article-wrap">
            <article id="terms-content" className="typeset legal-typeset">
            <h1>Terms of Service</h1>
            <p><em>Last updated: September 2026.</em></p>

            <h2 id="what-wasit-is">1. What Wasit is</h2>
            <p>
              Wasit is an open-source protocol-compliance tester for the x402 and MPP
              (Machine Payments Protocol) payment protocols on Stellar. It
              ships as a CLI, an MCP server, and a shared core library
              (<code>@wasit-dev/cli</code>, <code>@wasit-dev/server</code>,
              <code>@wasit-dev/core</code>), published to npm under the
              Apache License 2.0. This website is documentation and a
              landing page for that project — it is not a paid product,
              an account-based service, or a custodian of funds.
            </p>

            <h2 id="open-source-license">2. Open-source license</h2>
            <p>
              The Wasit source code is licensed under the{" "}
              <a href="https://github.com/wasit-dev/wasit/blob/main/LICENSE" target="_blank" rel="noreferrer noopener">
                Apache License 2.0
              </a>. That license, not this page, governs your rights to
              use, modify, and redistribute the code. If the two ever
              conflict on a code-licensing question, the LICENSE file in
              the repository controls.
            </p>

            <h2 id="no-warranty">3. No warranty</h2>
            <p>
              Wasit is provided &ldquo;as is,&rdquo; without warranty of
              any kind, as stated in the Apache 2.0 license. It is a
              testing tool: it inspects and runs real payment flows
              (including on-chain settlement checks) against services you
              point it at. You are responsible for running it against
              services you are authorized to test, for reviewing what a
              check does before running it with <code>--allow-destructive</code>{" "}
              or similar flags, and for any funds moved by the flows it
              exercises. Wasit’s maintainer is not liable for losses
              arising from its use.
            </p>

            <h2 id="using-this-website">4. Using this website</h2>
            <p>
              You’re free to browse and link to this site. Please don’t
              attempt to disrupt it (scraping at abusive rates, attempting
              to break the hosting, and similar) or use it to distribute
              malware or misleading claims about the project.
            </p>

            <h2 id="third-party-services">5. Third-party services</h2>
            <p>
              This site is hosted on Vercel and its source is on GitHub;
              the published packages are distributed via npm. Your use of
              those platforms is governed by their own terms, not this
              page.
            </p>

            <h2 id="changes">6. Changes</h2>
            <p>
              These terms may be updated as the project evolves. Material
              changes will be reflected by updating the date at the top of
              this page.
            </p>

            <h2 id="contact">7. Contact</h2>
            <p>
              Questions about these terms can be raised as an issue on{" "}
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
          <DocsToc contentSelector="#terms-content" className="legal-toc" />
        </div>
      </div>
      <Footer />
    </>
  )
}
