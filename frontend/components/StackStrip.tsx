import { SvgMark, markWidth, type MarkId } from "@/components/BrandMarks"

// The stack strip under the ticker: the two protocols Wasit checks on the
// left, the four chains whose own record it reads the settlement from on
// the right, and a line wherever a protocol runs on a chain. The lines are
// facts, not decoration: in 0.7.0 x402 pays on all four testnets and MPP on
// Stellar's only, so MPP has one line. A dot runs each line from protocol
// to chain, the direction the payment goes.
//
// Drawn as SVG at a fixed viewBox, so the lines meet the boxes exactly at
// every width. Two layouts, chosen in CSS: wide (side by side) from 1100px,
// narrow (protocols above chains) below it, where the wide one's text would
// shrink too far.

type Node = { id: MarkId; name: string; short: string; meta: string; metaShort: string; href: string }

// Check counts as docs/CHECKS.md lists them: ten for x402, one for MPP
// charge mode and five for channel mode.
const PROTOCOLS: Node[] = [
  { id: "x402", name: "x402", short: "x402", meta: "10 checks · exact scheme", metaShort: "10 checks", href: "https://x402.org" },
  { id: "mpp", name: "Machine Payments Protocol", short: "MPP", meta: "6 checks · charge and channel", metaShort: "6 checks", href: "https://paymentauth.org" },
]

// The testnet each chain is tested on, and what Wasit reads the settlement
// from there (docs/CHECKS.md, X402-06 and MPP-01).
const CHAINS: Node[] = [
  { id: "stellar", name: "Stellar", short: "Stellar", meta: "testnet · contract transfer event", metaShort: "testnet", href: "https://stellar.org" },
  { id: "base", name: "Base", short: "Base", meta: "Sepolia · ERC-20 Transfer log", metaShort: "Sepolia", href: "https://base.org" },
  { id: "ethereum", name: "Ethereum", short: "Ethereum", meta: "Sepolia · ERC-20 Transfer log", metaShort: "Sepolia", href: "https://ethereum.org" },
  { id: "solana", name: "Solana", short: "Solana", meta: "devnet · token balances", metaShort: "devnet", href: "https://solana.com" },
]

/** Which chains each protocol runs on, as 0.7.0 tests them. */
const RUNS_ON: Record<"x402" | "mpp", readonly MarkId[]> = {
  x402: ["stellar", "base", "ethereum", "solana"],
  mpp: ["stellar"],
}

function chainList(ids: readonly MarkId[]): string {
  const names = ids.map((id) => CHAINS.find((c) => c.id === id)!.name)
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

function protocolLabel(p: Node): string {
  const on = RUNS_ON[p.id as "x402" | "mpp"]
  return `${p.name}: ${p.meta}. Tested on ${chainList(on)} ${on.length === 1 ? "testnet" : "testnets"}.`
}

function chainLabel(c: Node): string {
  const by = (Object.keys(RUNS_ON) as Array<"x402" | "mpp">).filter((p) => RUNS_ON[p].includes(c.id))
  return `${c.name}, ${c.meta}. Settlement read here for ${by.map((p) => (p === "mpp" ? "MPP" : p)).join(" and ")}.`
}

/** A dot that runs the path `id` from start to end, forever. */
function Flow({ path, dur, begin, kind }: { path: string; dur: number; begin: number; kind: "x" | "m" }) {
  return (
    <circle r="3.2" className={`fan-flow fan-flow--${kind}`}>
      <animateMotion dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite">
        <mpath href={`#${path}`} />
      </animateMotion>
    </circle>
  )
}

/** Where a protocol's line meets a chain; MPP lands a little lower so the two never merge. */
function landing(p: "x402" | "mpp", centre: number, offset: number): number {
  return p === "mpp" ? centre + offset : centre
}

function Wide() {
  const W = 1200
  const H = 440
  const pw = 340, ph = 150, py = [36, 254]
  const cx = W - 340, cw = 340, ch = 92, cy = [0, 116, 232, 348]
  const pc = py.map((y) => y + ph / 2)
  const cc = cy.map((y) => y + ch / 2)
  const lines: React.ReactNode[] = []
  PROTOCOLS.forEach((p, i) => {
    const key = p.id as "x402" | "mpp"
    RUNS_ON[key].forEach((chainId, n) => {
      const j = CHAINS.findIndex((c) => c.id === chainId)
      const y0 = pc[i]!, y1 = landing(key, cc[j]!, 16)
      const id = `fan-w-${key}-${chainId}`
      const kind = key === "x402" ? "x" : "m"
      lines.push(
        <g key={id}>
          <path id={id} d={`M${pw},${y0} C${pw + 220},${y0} ${cx - 220},${y1} ${cx},${y1}`} className={`fan-line fan-line--${kind}`} />
          <circle cx={cx} cy={y1} r="4" className={`fan-joint fan-joint--${kind}`} />
          <Flow path={id} dur={key === "x402" ? 2.6 : 2.9} begin={n * 0.45 + (kind === "m" ? 0.3 : 0)} kind={kind} />
        </g>,
      )
    })
    lines.push(<circle key={`j-${key}`} cx={pw} cy={pc[i]} r="4" className={`fan-joint fan-joint--${key === "x402" ? "x" : "m"}`} />)
  })
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fan fan--wide" role="group" aria-label="Which protocol runs on which chain">
      {lines}
      {PROTOCOLS.map((p, i) => {
        const y = py[i]!
        const markH = p.id === "x402" ? 30 : 18
        return (
          <a key={p.id} href={p.href} target="_blank" rel="noreferrer noopener" aria-label={protocolLabel(p)} className="fan-node">
            <rect x="0" y={y} width={pw} height={ph} className="fan-box" />
            <text x="22" y={y + 28} className="fan-role"><tspan className="fan-slash">{"// "}</tspan>checks</text>
            <SvgMark id={p.id} x={22} y={y + 44} height={markH} className="fan-mark" />
            <text x="22" y={y + ph - 42} className="fan-name">{p.name}</text>
            <text x="22" y={y + ph - 20} className="fan-meta">{p.meta}</text>
          </a>
        )
      })}
      {CHAINS.map((c, j) => {
        const y = cy[j]!
        return (
          <a key={c.id} href={c.href} target="_blank" rel="noreferrer noopener" aria-label={chainLabel(c)} className="fan-node">
            <rect x={cx} y={y} width={cw} height={ch} className="fan-box" />
            <text x={cx + 22} y={y + 26} className="fan-role"><tspan className="fan-slash">{"// "}</tspan>trusts</text>
            <text x={cx + 22} y={y + 54} className="fan-name">{c.name}</text>
            <text x={cx + 22} y={y + 76} className="fan-meta">{c.meta}</text>
            <SvgMark id={c.id} x={cx + cw - 22 - markWidth(c.id, 30)} y={y + 31} height={30} className="fan-mark" />
          </a>
        )
      })}
    </svg>
  )
}

function Narrow() {
  const W = 420
  const H = 404
  const pw = 200, ph = 118, px = [0, 220]
  const cw = 96, ch = 122, cy = H - ch, cx = [0, 108, 216, 324]
  const pc = px.map((x) => x + pw / 2)
  const cc = cx.map((x) => x + cw / 2)
  const lines: React.ReactNode[] = []
  PROTOCOLS.forEach((p, i) => {
    const key = p.id as "x402" | "mpp"
    RUNS_ON[key].forEach((chainId, n) => {
      const j = CHAINS.findIndex((c) => c.id === chainId)
      const x0 = pc[i]!, x1 = landing(key, cc[j]!, 16)
      const id = `fan-n-${key}-${chainId}`
      const kind = key === "x402" ? "x" : "m"
      lines.push(
        <g key={id}>
          <path id={id} d={`M${x0},${ph} C${x0},${ph + 90} ${x1},${cy - 90} ${x1},${cy}`} className={`fan-line fan-line--${kind}`} />
          <circle cx={x1} cy={cy} r="3.5" className={`fan-joint fan-joint--${kind}`} />
          <Flow path={id} dur={2.2} begin={n * 0.4 + (kind === "m" ? 0.3 : 0)} kind={kind} />
        </g>,
      )
    })
    lines.push(<circle key={`j-${key}`} cx={pc[i]} cy={ph} r="3.5" className={`fan-joint fan-joint--${key === "x402" ? "x" : "m"}`} />)
  })
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fan fan--narrow" role="group" aria-label="Which protocol runs on which chain">
      {lines}
      {PROTOCOLS.map((p, i) => {
        const x = px[i]!
        const markH = p.id === "x402" ? 22 : 13
        return (
          <a key={p.id} href={p.href} target="_blank" rel="noreferrer noopener" aria-label={protocolLabel(p)} className="fan-node">
            <rect x={x} y="0" width={pw} height={ph} className="fan-box" />
            <text x={x + 16} y="22" className="fan-role fan-role--sm"><tspan className="fan-slash">{"// "}</tspan>checks</text>
            <SvgMark id={p.id} x={x + 16} y={34} height={markH} className="fan-mark" />
            <text x={x + 16} y={ph - 32} className="fan-name fan-name--sm">{p.short}</text>
            <text x={x + 16} y={ph - 14} className="fan-meta fan-meta--sm">{p.metaShort}</text>
          </a>
        )
      })}
      {CHAINS.map((c, j) => {
        const x = cx[j]!
        return (
          <a key={c.id} href={c.href} target="_blank" rel="noreferrer noopener" aria-label={chainLabel(c)} className="fan-node">
            <rect x={x} y={cy} width={cw} height={ch} className="fan-box" />
            <text x={x + 12} y={cy + 20} className="fan-role fan-role--sm"><tspan className="fan-slash">{"// "}</tspan>trusts</text>
            <SvgMark id={c.id} x={x + 12} y={cy + 32} height={24} className="fan-mark" />
            <text x={x + 12} y={cy + ch - 32} className="fan-name fan-name--xs">{c.short}</text>
            <text x={x + 12} y={cy + ch - 14} className="fan-meta fan-meta--sm">{c.metaShort}</text>
          </a>
        )
      })}
    </svg>
  )
}

export function StackStrip() {
  return (
    <section className="stack" aria-labelledby="stack-title">
      <div className="frame stack-fan">
        <div className="stack-intro" data-reveal>
          <span className="stack-kicker">The stack</span>
          <p id="stack-title" className="stack-title">
            Two protocols it <span className="hl-2">checks</span>. Four chains it <span className="hl-2">trusts</span>.
          </p>
        </div>
        <div className="stack-diagram" data-reveal data-reveal-delay="120">
          <Wide />
          <Narrow />
        </div>
      </div>
    </section>
  )
}
