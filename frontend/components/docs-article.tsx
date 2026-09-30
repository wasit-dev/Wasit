import type { ComponentPropsWithoutRef, ReactNode } from "react"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeSlug from "rehype-slug"
import { CodeBlock } from "@/components/code-block"
import { DocsToc } from "@/components/docs-toc"
import { DocsPager } from "@/components/docs-pager"
import { docLinkHref, docSourceFile } from "@/lib/content"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/**
 * GFM tables mapped onto shadcn/ui's Table, with three deliberate
 * departures from its defaults — all because these tables hold prose,
 * not the short scalar values a data table holds.
 *
 * `whitespace-nowrap` is dropped from every cell. The check catalogue's
 * "Pass criteria" column is a full paragraph per row; keeping nowrap
 * would render each one as a single line thousands of pixels wide and
 * turn every table on the site into a horizontal scroller. Cells wrap,
 * and the container's own overflow-x-auto stays as a safety net for the
 * rare cell that still cannot fit — an unbroken contract address, say.
 *
 * Cells align to the top rather than the middle, since a row whose
 * columns are one word and one paragraph reads wrong centred, and get
 * roomier padding than shadcn's compact `p-2` default to match the
 * article's own reading rhythm.
 *
 * Row hover is dropped. These rows are not selectable or clickable, so
 * a hover response invites a click that does nothing.
 */
const CELL = "px-3.5 py-3 align-top whitespace-normal leading-relaxed"

function MarkdownTable(props: ComponentPropsWithoutRef<"table">) {
  return <Table className="my-[1.3em] border-collapse" {...props} />
}

function MarkdownRow(props: ComponentPropsWithoutRef<"tr">) {
  return <TableRow className="hover:bg-transparent" {...props} />
}

function MarkdownHead(props: ComponentPropsWithoutRef<"th">) {
  return <TableHead className={`h-auto ${CELL} font-semibold`} {...props} />
}

function MarkdownCell(props: ComponentPropsWithoutRef<"td">) {
  return <TableCell className={CELL} {...props} />
}

/**
 * The shared shell for every /docs page: one page's markdown, rendered
 * on its own (never concatenated with any other page anymore), plus its
 * own right-hand table of contents and, when `slug` is passed, a
 * bottom-of-article prev/next pager (components/docs-pager.tsx) so a
 * reader can move through the whole nav without going back to the
 * sidebar. `slug` is optional — a future caller that renders standalone
 * markdown with no place in DOCS_NAV can still use this shell and just
 * skip the pager.
 *
 * `children` render after the markdown and before the pager, for the one
 * thing markdown cannot express: the card index on Overview -> Wasit,
 * which is a grid of links with icons rather than prose.
 *
 * When the page is republished from a repo file, that file's own
 * relative links are rewritten through docLinkHref: `../CHECKS.md` is
 * correct on GitHub and a 404 here, because the browser resolves it
 * against the docs URL rather than the file's directory. Hand-authored
 * pages have no such links and keep react-markdown's default transform,
 * which is also chained after ours so its protocol sanitising is never
 * lost.
 */
export function DocsArticle({
  markdown,
  slug,
  children,
}: {
  markdown: string
  slug?: string[]
  children?: ReactNode
}) {
  const sourceFile = slug ? docSourceFile(slug) : undefined

  return (
    <div className="flex items-start justify-center gap-12 px-6 py-10 md:px-10">
      <article id="docs-content" className="typeset typeset-docs w-full min-w-0 max-w-[68ch]">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug]}
          urlTransform={
            sourceFile
              ? (url) => defaultUrlTransform(docLinkHref(url, sourceFile))
              : defaultUrlTransform
          }
          components={{
            pre: CodeBlock,
            table: MarkdownTable,
            thead: TableHeader,
            tbody: TableBody,
            tr: MarkdownRow,
            th: MarkdownHead,
            td: MarkdownCell,
          }}
        >
          {markdown}
        </ReactMarkdown>
        {children}
        {slug && <DocsPager slug={slug} />}
      </article>
      <DocsToc contentSelector="#docs-content" className="sticky top-20 hidden w-56 shrink-0 xl:block" />
    </div>
  )
}
