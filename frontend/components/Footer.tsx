import Image from "next/image";
import Link from "next/link";

const GITHUB_URL = "https://github.com/wasit-dev/wasit";
const X_URL = "https://x.com/wasithq";
const NPM_URL = "https://www.npmjs.com/package/@wasit-dev/cli";

const FOOTER_COLUMNS: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Check Catalogue", href: "/docs/checks/overview" },
      { label: "npm", href: NPM_URL, external: true },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "X", href: X_URL, external: true },
      { label: "GitHub", href: GITHUB_URL, external: true },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms of Service", href: "/legal/terms" },
      { label: "Privacy Policy", href: "/legal/privacy" },
    ],
  },
];

/**
 * Brand block and link columns on the site grid, then the wordmark set
 * across the full width in outline — the footer's one large gesture,
 * decorative and hidden from assistive tech since the brand is already
 * named above it — and a thin utility bar.
 */
export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="frame footer-top">
        <div className="footer-brand">
          <div className="footer-brand-row">
            <Image src="/Wolf.png" alt="" width={1924} height={1284} className="footer-mark" />
            <span className="footer-word">WASIT</span>
          </div>
          <p className="footer-statement">Verify the settlement, not the receipt.</p>
        </div>

        <div className="footer-columns">
          {FOOTER_COLUMNS.map((col) => (
            <div className="footer-col" key={col.title}>
              <h3>{col.title}</h3>
              <ul>
                {col.links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a href={link.href} target="_blank" rel="noreferrer noopener">
                        {link.label} <span aria-hidden="true">↗</span>
                      </a>
                    ) : (
                      <Link href={link.href}>{link.label}</Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div className="footer-giant" aria-hidden="true">
        WASIT
      </div>

      <div className="frame footer-bottom">
        <span>© {year} Wasit</span>
        <span>Apache-2.0 · Open source · Built on Stellar</span>
      </div>
    </footer>
  );
}
