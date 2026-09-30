"use client"

import Image from "next/image"
import type { CSSProperties, ReactNode } from "react"
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import "./HowItWorksFlow.css"

type HandleSpec = {
  id: string
  kind: "source" | "target"
  position: Position
  style?: CSSProperties
}

type ActorData = {
  label: string
  sublabel: string
  variant: "actor" | "chain"
  handles: HandleSpec[]
  logo?: ReactNode
}

// One lane per edge (four lanes, not two) — each of the four HTTP
// round-trip steps gets its own dedicated horizontal row between wasit
// and service, instead of the request and its response sharing a lane
// and drawing directly on top of each other. That overlap was the bug:
// two edges tracing the exact same line meant their numbered labels
// landed on the same point and rendered stacked/unreadable.
function lane(prefix: string, kind: "source" | "target", position: Position, top: string): HandleSpec {
  return { id: `${prefix}-${kind}`, kind, position, style: { top } }
}

const LANE_TOP = ["18%", "39%", "61%", "82%"] as const

// Stellar's mark, inlined as raw SVG rather than a rasterized asset so
// it can pick up the diagram's accent tint via CSS `fill` (see
// .flow-actor-logo--stellar in HowItWorksFlow.css) instead of shipping
// a second pre-colored image asset.
function StellarMark() {
  return (
    <svg
      viewBox="0 0 236.36 200"
      className="flow-actor-logo flow-actor-logo--stellar"
      aria-hidden="true"
    >
      <path d="M203,26.16l-28.46,14.5-137.43,70a82.49,82.49,0,0,1-.7-10.69A81.87,81.87,0,0,1,158.2,28.6l16.29-8.3,2.43-1.24A100,100,0,0,0,18.18,100q0,3.82.29,7.61a18.19,18.19,0,0,1-9.88,17.58L0,129.57V150l25.29-12.89,0,0,8.19-4.18,8.07-4.11v0L186.43,55l16.28-8.29,33.65-17.15V9.14Z" />
      <path d="M236.36,50,49.78,145,33.5,153.31,0,170.38v20.41l33.27-16.95,28.46-14.5L199.3,89.24A83.45,83.45,0,0,1,200,100,81.87,81.87,0,0,1,78.09,171.36l-1,.53-17.66,9A100,100,0,0,0,218.18,100c0-2.57-.1-5.14-.29-7.68a18.2,18.2,0,0,1,9.87-17.58l8.6-4.38Z" />
    </svg>
  )
}

const nodes: Node<ActorData>[] = [
  {
    id: "wasit",
    type: "actor",
    position: { x: 0, y: 20 },
    data: {
      label: "WASIT",
      sublabel: "the checker",
      variant: "actor",
      logo: <Image src="/mark.png" alt="" width={316} height={256} className="flow-actor-logo" />,
      handles: [
        lane("lane-1", "source", Position.Right, LANE_TOP[0]),
        lane("lane-2", "target", Position.Right, LANE_TOP[1]),
        lane("lane-3", "source", Position.Right, LANE_TOP[2]),
        lane("lane-4", "target", Position.Right, LANE_TOP[3]),
        // Two offset handles rather than one, for the same reason the
        // four HTTP lanes above are offset from each other: the RPC
        // call down to Stellar and the verified-transfer response
        // back up are two distinct edges, not one line reused in both
        // directions. Spread wide (15%/85%) rather than close together,
        // so the longer "CAP-46 transfer verified" label has room next
        // to "RPC: getTransaction" instead of the two colliding.
        { id: "down-source", kind: "source", position: Position.Bottom, style: { left: "15%" } },
        { id: "down-target", kind: "target", position: Position.Bottom, style: { left: "85%" } },
      ],
    },
  },
  {
    id: "service",
    type: "actor",
    position: { x: 460, y: 20 },
    data: {
      label: "YOUR SERVICE",
      sublabel: "the target",
      variant: "actor",
      handles: [
        lane("lane-1", "target", Position.Left, LANE_TOP[0]),
        lane("lane-2", "source", Position.Left, LANE_TOP[1]),
        lane("lane-3", "target", Position.Left, LANE_TOP[2]),
        lane("lane-4", "source", Position.Left, LANE_TOP[3]),
      ],
    },
  },
  {
    id: "stellar",
    type: "actor",
    position: { x: 150, y: 300 },
    data: {
      label: "STELLAR",
      sublabel: "the source of truth",
      variant: "chain",
      logo: <StellarMark />,
      handles: [
        { id: "top-target", kind: "target", position: Position.Top, style: { left: "15%" } },
        { id: "top-source", kind: "source", position: Position.Top, style: { left: "85%" } },
      ],
    },
  },
]

// Shared label styling so all four request/response edges render their
// numbered tag as a legible pill against the canvas, instead of bare
// text sitting on the line it labels.
const labelProps = {
  labelBgPadding: [6, 3] as [number, number],
  labelBgBorderRadius: 5,
  labelStyle: { fontWeight: 600 },
}

const edges: Edge[] = [
  {
    id: "e1",
    source: "wasit",
    sourceHandle: "lane-1-source",
    target: "service",
    targetHandle: "lane-1-target",
    label: "① unpaid request",
    animated: true,
    markerEnd: { type: MarkerType.ArrowClosed },
    ...labelProps,
  },
  {
    id: "e2",
    source: "service",
    sourceHandle: "lane-2-source",
    target: "wasit",
    targetHandle: "lane-2-target",
    label: "② 402 challenge",
    animated: true,
    markerEnd: { type: MarkerType.ArrowClosed },
    ...labelProps,
  },
  {
    id: "e3",
    source: "wasit",
    sourceHandle: "lane-3-source",
    target: "service",
    targetHandle: "lane-3-target",
    label: "③ signed payment",
    animated: true,
    markerEnd: { type: MarkerType.ArrowClosed },
    ...labelProps,
  },
  {
    id: "e4",
    source: "service",
    sourceHandle: "lane-4-source",
    target: "wasit",
    targetHandle: "lane-4-target",
    label: "④ 2xx receipt",
    animated: true,
    markerEnd: { type: MarkerType.ArrowClosed },
    ...labelProps,
  },
  {
    id: "e5",
    source: "wasit",
    sourceHandle: "down-source",
    target: "stellar",
    targetHandle: "top-target",
    label: "⑤ RPC: getTransaction",
    animated: true,
    className: "flow-edge-accent",
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--accent)" },
    ...labelProps,
  },
  {
    id: "e6",
    source: "stellar",
    sourceHandle: "top-source",
    target: "wasit",
    targetHandle: "down-target",
    label: "⑥ CAP-46 transfer verified",
    animated: true,
    className: "flow-edge-accent",
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--accent)" },
    ...labelProps,
  },
]

function ActorNode({ data }: NodeProps<Node<ActorData>>) {
  return (
    <div className={`flow-actor${data.variant === "chain" ? " flow-actor--chain" : ""}`}>
      {data.handles.map((h) => (
        <Handle key={h.id} id={h.id} type={h.kind} position={h.position} style={h.style} />
      ))}
      {data.logo}
      <span className="flow-actor-label mono">{data.label}</span>
      <span className="flow-actor-sub">{data.sublabel}</span>
    </div>
  )
}

const nodeTypes = { actor: ActorNode }

/**
 * The request/response cycle from the "How it works" section, as an
 * actual sequence diagram instead of a numbered list — Wasit and Your
 * Service trade the HTTP round trip (steps ①–④, each on its own lane
 * so the rows never overlap), then Wasit breaks out of that exchange
 * entirely to check Stellar directly: ⑤ calls RPC `getTransaction`,
 * ⑥ confirms the CAP-46 transfer event it returns (both the accent
 * edges, offset from each other the same way the HTTP lanes are, so
 * the call down and the confirmation back up don't draw on top of one
 * another). Splitting the old single "verify transfer event" edge
 * into these two is what makes the diagram concrete rather than
 * hand-wavy about what "verify" means. Going somewhere neither of the
 * other two nodes touch is the whole point of the section: a receipt
 * only proves your service CLAIMS to have been paid, the chain proves
 * it actually happened.
 *
 * Nodes are draggable and the canvas pans/pinch-zooms (zoomOnScroll is
 * off on purpose — a marketing page shouldn't hijack the mouse wheel
 * from normal page scrolling), but new connections can't be drawn; this
 * is a diagram to explore, not an editor.
 */
export function HowItWorksFlow() {
  return (
    <div className="flow-canvas" role="img" aria-label="Sequence diagram: Wasit and your service exchange an HTTP payment challenge and payment, then Wasit independently calls Stellar RPC and confirms the CAP-46 transfer event, rather than trusting your service's receipt.">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: false }}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        minZoom={0.6}
        maxZoom={1.4}
      >
        <Background variant={BackgroundVariant.Lines} gap={32} color="#18171d" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
