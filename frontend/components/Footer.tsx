import Image from "next/image";
import Link from "next/link";
import { PixelWordmark } from "./PixelWordmark";

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
 * The logo lockup and link columns on the site grid, then the wordmark
 * across the full width as a dot-matrix (components/PixelWordmark.tsx),
 * then a thin utility bar.
 */
export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="frame footer-top">
        <div className="footer-brand">
          {/* width/height carry the lockup's 1280x321 ratio only; CSS sets the height. */}
          <Image src="/logo-light.svg" alt="Wasit" width={1280} height={321} className="footer-logo" />
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

      <div className="frame footer-giant">
        <PixelWordmark />
      </div>

      <div className="frame footer-bottom">
        <span>© {year} Wasit. All rights reserved.</span>
        <span>Apache-2.0 · Open source · Built on Stellar</span>
      </div>
    </footer>
  );
}
