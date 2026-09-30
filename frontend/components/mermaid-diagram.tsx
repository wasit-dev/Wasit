"use client"

import * as React from "react"

let mermaidSeq = 0

/**
 * Renders a ```mermaid fenced block as an actual diagram instead of code.
 * The `mermaid` package is loaded dynamically (only when a page actually
 * has a diagram) and only ever runs in the browser — mermaid needs a DOM
 * to measure text and lay out nodes, so this can't render on the server.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [error, setError] = React.useState<string | null>(null)
  const idRef = React.useRef(`mermaid-diagram-${++mermaidSeq}`)

  React.useEffect(() => {
    let cancelled = false
    // react-hooks/set-state-in-effect false positive: this reset has to
    // happen here, not during render — it's clearing the *previous*
    // render's error right before this effect kicks off a new async
    // import+render attempt for the new `source`, the same "starting a
    // new async operation" case the rule's own docs list as an
    // exception (react.dev/reference/eslint-plugin-react-hooks/lints/set-state-in-effect).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null)

    import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
        themeVariables: {
          background: "#0a0a0a",
          primaryColor: "#141414",
          primaryTextColor: "#ededed",
          primaryBorderColor: "#2e2e2e",
          secondaryColor: "#0a0a0a",
          tertiaryColor: "#0a0a0a",
          lineColor: "#a0a0a0",
          textColor: "#ededed",
          fontFamily: "var(--font-archivo), system-ui, sans-serif",
          fontSize: "14px",
        },
      })

      try {
        const { svg } = await mermaid.render(idRef.current, source)
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render diagram")
        }
      }
    })

    return () => {
      cancelled = true
    }
  }, [source])

  if (error) {
    return (
      <div className="mermaid-error" role="alert">
        Diagram failed to render: {error}
      </div>
    )
  }

  return <div className="mermaid-diagram" ref={containerRef} aria-label="Diagram" />
}
