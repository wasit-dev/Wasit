import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Fira_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const firaMono = Fira_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-fira-mono",
  display: "swap",
});

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
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
    <html lang="en" className={`${firaMono.variable} ${plusJakartaSans.variable}`}>
      <body>
        {children}
        {/* Cookieless page-view counts; see /legal/privacy. */}
        <Analytics />
      </body>
    </html>
  );
}
