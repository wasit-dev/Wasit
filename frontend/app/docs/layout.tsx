import type { ReactNode } from "react"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { DocsSidebar } from "@/components/docs-sidebar"
import { DocsBreadcrumb } from "@/components/docs-breadcrumb"
import { Nav } from "@/components/Nav"
import "./docs.css"

/**
 * The site-wide Nav sits above the whole sidebar-07 shell rather than
 * inside SidebarInset — it's what gives a /docs page the same top bar
 * (and its "Docs" button, which is how you get back to /docs from a
 * sub-page) as the rest of the site. It is given the "docs" brand
 * variant here: the sidebar carries no logo of its own by design, so
 * this bar is the only place a /docs page can identify itself. The shadcn sidebar itself renders
 * `position: fixed` at the DOM level (see [data-slot="sidebar-container"]
 * in components/ui/sidebar.tsx) regardless of where it sits in the
 * tree, so stacking Nav above it needs the matching CSS offset in
 * docs.css (search "Nav offset") — without that, the fixed sidebar
 * would render at the very top of the viewport and sit underneath Nav,
 * not below it.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Nav variant="docs" />
      <SidebarProvider>
        <DocsSidebar />
        {/* min-w-0: as a flex item the inset would otherwise refuse to
            shrink below its widest content (a long table or identifier),
            and push the whole page sideways at tablet widths. */}
        <SidebarInset className="min-w-0">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border">
            <div className="flex items-center gap-2 px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-2 h-4" />
              <DocsBreadcrumb />
            </div>
          </header>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </>
  )
}
