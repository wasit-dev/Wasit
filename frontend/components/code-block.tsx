"use client"

import * as React from "react"
import { Check, Copy } from "lucide-react"
import { cn } from "@/lib/utils"
import { MermaidDiagram } from "@/components/mermaid-diagram"
import { highlightCode } from "@/lib/code-highlight"

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node
  if (typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(extractText).join("")
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode }
    return extractText(props.children)
  }
  return ""
}

/**
 * Overrides ReactMarkdown's `pre` renderer for every fenced code block
 * (inline `code` spans are untouched — those never render inside a
 * `pre`). Renders as a square terminal panel — the fence's language
 * and a copy button in one mono title bar — with the code body syntax-colored by the dependency-free
 * tokenizer in lib/code-highlight.ts. A ```mermaid fence skips all of
 * this and renders as a diagram instead.
 */
export function CodeBlock({ children, className, ...props }: React.ComponentPropsWithoutRef<"pre">) {
  const [copied, setCopied] = React.useState(false)
  const text = extractText(children).replace(/\n$/, "")

  // ReactMarkdown always calls this renderer with the fenced block's own
  // <code language-xxx> element as `children` — pull its className back
  // out both to tell a ```mermaid fence apart from an ordinary one and
  // to pick which tokenizer rules apply.
  const codeClassName = React.isValidElement(children)
    ? ((children.props as { className?: string }).className ?? "")
    : ""
  const lang = /language-(\w+)/.exec(codeClassName)?.[1] ?? ""

  // Computed unconditionally (before the mermaid early return) so hook
  // call order never depends on which kind of fence this render is —
  // the wasted work on a mermaid block's text is negligible.
  const highlighted = React.useMemo(() => highlightCode(text, lang), [text, lang])

  if (/language-mermaid/.test(codeClassName)) {
    return <MermaidDiagram source={text} />
  }

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard API unavailable (insecure context, denied permission) —
      // the button just won't flip to "Copied"; nothing else to do.
    }
  }

  return (
    <div className="doc-code">
      <div className="doc-code-bar">
        <span className="doc-code-square" aria-hidden="true" />
        <span className="doc-code-lang mono">{lang || "text"}</span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "Copied" : "Copy code"}
          className={cn("doc-code-copy", copied && "is-copied")}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className={cn("doc-code-pre", className)} {...props}>
        <code className={cn(codeClassName, "mono")} dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  )
}
