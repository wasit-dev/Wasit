import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Archivo carries the whole type system: its width axis runs from
// condensed to expanded, so the display headings (expanded, heavy) and
// the body copy (normal width) come from one family. JetBrains Mono
// sets every label, the navigation and the terminal output.
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jbmono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Wasit",
  description:
    "Independent protocol-compliance tester for x402 and MPP on Stellar. Runs the real payment flow and verifies on-chain settlement, not just response shape.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${archivo.variable} ${jetbrainsMono.variable}`}>
      <body>
        {children}
        {/* Cookieless page-view counts; see /legal/privacy. */}
        <Analytics />
      </body>
    </html>
  );
}
