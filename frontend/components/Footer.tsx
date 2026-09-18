import Image from "next/image";
import Link from "next/link";

const GITHUB_URL = "https://github.com/wasit-dev/wasit";
const X_URL = "https://x.com/wasithq";

const FOOTER_COLUMNS: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  {
    title: "Products",
    links: [{ label: "Docs", href: "/docs" }],
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

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer>
      <div className="wrap footer-top">
        <div className="footer-brand-block">
          <Image
            src="/W-White.png"
            alt="Wasit"
            width={387}
            height={100}
            className="footer-wordmark-img"
          />
          <p className="footer-statement">VERIFY THE SETTLEMENT</p>
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
                        {link.label}
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

      <div className="wrap footer-bottom">
        <span className="fine">© {year} Wasit. All rights reserved.</span>
        <span className="fine">Open Source · Powered by Stellar</span>
      </div>
    </footer>
  );
}
