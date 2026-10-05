import Image from "next/image"

// The two protocols' marks, inlined (from their official brand files) so
// they take the page's colour through currentColor. Stellar's lockup is
// only available as a bitmap, so it ships as public/brand/stellar-white.png.

function X402Logo() {
  return (
    <svg viewBox="0 0 486.3 187.4" className="stack-logo stack-logo--x402" role="img" aria-label="x402">
      <path d="M10.5,59.5c.6-.6,1.6-.6,2.3,0l50.9,50.9,19.5-19.5c.6-.6,1.6-.6,2.3,0l10,10c.6.6.6,1.7,0,2.3l-14.4,14.4v10.4l45.8,45.8c.6.6.6,1.7,0,2.3l-10,10c-.6.6-1.6.6-2.3,0l-50.9-50.9-50.9,50.9c-.6.6-1.6.6-2.3,0L.5,176.1c-.6-.6-.6-1.7,0-2.3l45.8-45.8v-10.4L.5,71.8c-.6-.6-.6-1.7,0-2.3l10-10Z" />
      <path d="M374.1,151.7c0-2.5,1-4.9,2.7-6.7l91-93.6c.4-.5.7-1.1.7-1.7v-7.4c0-.6-.2-1.2-.7-1.7l-18.9-19.9c-.4-.5-1.1-.7-1.7-.7h-37.9c-.6,0-1.3.3-1.7.7l-22.9,23c-.9.9-2.5.9-3.4,0l-9.1-9.1c-.9-.9-.9-2.5,0-3.4l26-26c1.8-1.8,4.3-2.8,6.8-2.8h46.7c2.6,0,5.2,1.1,7,3l24.9,26.1c1.7,1.8,2.7,4.2,2.7,6.7v15.9c0,2.5-1,4.9-2.7,6.7l-91,93.6c-.4.5-.7,1.1-.7,1.7v11.4c0,1.3,1.1,2.4,2.4,2.4h89.6c1.3,0,2.4,1.1,2.4,2.4v12.9c0,1.3-1.1,2.4-2.4,2.4h-100.1c-5.3,0-9.7-4.3-9.7-9.7v-26.1Z" />
      <path d="M317.9,2.2c17.8,0,32.2,14.4,32.2,32.2v121.6c-.4,17.1-14.2,30.9-31.3,31.4h-41.2c-17.1-.4-30.9-14.2-31.3-31.4v-.8s0-120.8,0-120.8c0-17.8,14.4-32.2,32.2-32.2h39.5ZM263.8,144.8v10.5c0,8,6.5,14.5,14.5,14.5h39.5c8,0,14.5-6.5,14.5-14.5v-79l-68.5,68.6ZM278.3,19.9c-8,0-14.5,6.5-14.5,14.5v85.3l68.5-68.6v-16.7c0-8-6.5-14.5-14.5-14.5h-39.5Z" />
      <path d="M199.3,0c1.3,0,2.4,1.1,2.4,2.4v78.6c0,1.3,1.1,2.4,2.4,2.4h17.3c1.3,0,2.4,1.1,2.4,2.4v12.9c0,1.3-1.1,2.4-2.4,2.4h-17.3c-1.3,0-2.4,1.1-2.4,2.4v81.5c0,1.3-1.1,2.4-2.4,2.4h-12.9c-1.3,0-2.4-1.1-2.4-2.4v-81.5c0-1.3-1.1-2.4-2.4-2.4h-60.8c-.6,0-1.3-.3-1.7-.7l-21-21c-.9-.9-.9-2.5,0-3.4L172.9.7c.5-.5,1.1-.7,1.7-.7h24.7ZM123,76c-.9.9-.9,2.5,0,3.4l3.3,3.3c.5.5,1.1.7,1.7.7h53.5c1.3,0,2.4-1.1,2.4-2.4V19.9c0-1.2-1-2.2-2.2-2.2s-1.1.2-1.5.6l-57.3,57.6Z" />
    </svg>
  )
}

function MppLogo() {
  return (
    <svg viewBox="0 0 81.2195 18" className="stack-logo stack-logo--mpp" role="img" aria-label="MPP">
      <path d="M33.1162 17.9828H29.2324V2.84079e-05H51.2711C52.7167 2.84079e-05 53.8884 1.17531 53.8884 2.62538V8.65536C53.8884 10.1054 52.7167 11.2807 51.2711 11.2807H33.7302C33.3911 11.2807 33.1162 11.5556 33.1162 11.8948V17.9828ZM33.9887 7.62911H49.1322C49.6143 7.62911 50.0047 7.2375 50.0047 6.754V4.52674C50.0047 4.04324 49.6143 3.65162 49.1322 3.65162H33.9887C33.5066 3.65162 33.1162 4.04324 33.1162 4.52674V6.754C33.1162 7.2375 33.5066 7.62911 33.9887 7.62911Z" />
      <path d="M26.5978 17.9828H22.7141V5.6935C22.7141 5.30451 22.246 5.10892 21.9707 5.38284L16.511 10.8126C16.2658 11.0564 15.9347 11.1933 15.5897 11.1933H11.0099C10.6661 11.1933 10.3364 11.0577 10.0916 10.8157L4.62666 5.41609C4.35096 5.14349 3.88419 5.33952 3.88419 5.72763V17.9828H0V0H4.67988L11.8982 7.13351C12.0613 7.29496 12.2812 7.3851 12.5106 7.3851H14.0824C14.3123 7.3851 14.5334 7.29409 14.6966 7.13132L21.8669 0H26.5983V17.9828H26.5978Z" />
      <path d="M60.4063 17.9828H56.5226V2.84079e-05H78.5612C80.0068 2.84079e-05 81.1786 1.17531 81.1786 2.62538V8.65536C81.1786 10.1054 80.0068 11.2807 78.5612 11.2807H61.0204C60.6812 11.2807 60.4063 11.5556 60.4063 11.8948V17.9828ZM61.2788 7.62911H76.4223C76.9044 7.62911 77.2948 7.2375 77.2948 6.754V4.52674C77.2948 4.04324 76.9044 3.65162 76.4223 3.65162H61.2788C60.7968 3.65162 60.4063 4.04324 60.4063 4.52674V6.754C60.4063 7.2375 60.7968 7.62911 61.2788 7.62911Z" />
    </svg>
  )
}

type Cell = { key: string; href: string; name: string; role: "checks" | "trusts"; meta: string; logo: React.ReactNode }

// Check counts as docs/CHECKS.md lists them: ten for x402, one for MPP
// charge mode and five for channel mode. Links are the homepages the repo
// already cites.
const CELLS: Cell[] = [
  { key: "x402", href: "https://x402.org", name: "x402", role: "checks", meta: "10 checks · exact scheme on Stellar, Base and Solana", logo: <X402Logo /> },
  { key: "mpp", href: "https://paymentauth.org", name: "Machine Payments Protocol", role: "checks", meta: "6 checks · charge and channel", logo: <MppLogo /> },
  {
    key: "stellar",
    href: "https://stellar.org",
    name: "Stellar",
    role: "trusts",
    meta: "settlement read from Stellar RPC",
    logo: <Image src="/brand/stellar-white.png" alt="Stellar" width={1200} height={300} className="stack-logo stack-logo--stellar" />,
  },
]

/**
 * The stack Wasit works on, as a logo strip under the hero: the two
 * payment protocols it checks and the one chain it trusts. Each cell links
 * to that project's own site.
 */
export function StackStrip() {
  return (
    <section className="stack" aria-labelledby="stack-title">
      <div className="frame stack-grid">
        <div className="stack-intro" data-reveal>
          <span className="stack-kicker">The stack</span>
          <p id="stack-title" className="stack-title">
            Two protocols it <span className="hl-2">checks</span>. One chain it <span className="hl-2">trusts</span>.
          </p>
        </div>
        {CELLS.map((cell, i) => (
          <a
            key={cell.key}
            className="stack-cell"
            href={cell.href}
            target="_blank"
            rel="noreferrer noopener"
            data-reveal
            data-reveal-delay={String(100 * (i + 1))}
          >
            <span className="stack-role">{cell.role}</span>
            <span className="stack-mark">{cell.logo}</span>
            <span className="stack-name">{cell.name}</span>
            <span className="stack-meta">{cell.meta}</span>
          </a>
        ))}
      </div>
    </section>
  )
}
