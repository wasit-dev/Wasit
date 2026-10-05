import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS_NAV, type DocNavGroup } from "./docs-nav";
import {
  FROM_SOURCE_MD,
  PACKAGES_MD,
  QUICK_SETUP_MD,
  REQUIREMENTS_MD,
  TRY_IT_MD,
  VERIFY_MD,
} from "./docs-pages";

/**
 * Reads a markdown file from the repo root (one level up from this Next.js
 * project, since `frontend/` is a separate Vercel project rooted inside the
 * monorepo).
 *
 * This keeps the docs pages reading the SAME files the CLI/MCP guides and
 * SECURITY.md already are, rather than a hand-copied duplicate that can
 * drift out of sync. The cost is two Vercel settings this build depends on,
 * recorded here because nothing else in the repo records them:
 *
 *   - Root Directory must be `frontend` (it was `site` until the directory
 *     was renamed; a stale value fails the deploy before any build output).
 *   - "Include source files outside of the Root Directory" must be ON, or
 *     every path below resolves to ENOENT at module load — a failure whose
 *     message never mentions the setting that caused it.
 */
export function readRepoDoc(relativePath: string): string {
  const fullPath = join(process.cwd(), "..", relativePath);
  return readFileSync(fullPath, "utf-8");
}

/**
 * Shifts every heading in a markdown string UP by `levels` (default 1) —
 * a file's own `## Section` becomes `# Section` once that section is
 * pulled out onto its own standalone docs page, and any `###` inside it
 * becomes a `##` that the page's own table of contents can pick up.
 * Floors at h1.
 */
export function promoteHeadings(markdown: string, levels = 1): string {
  return markdown.replace(/^(#{1,6})(\s+)/gm, (_match, hashes: string, space: string) => {
    const next = Math.max(hashes.length - levels, 1);
    return "#".repeat(next) + space;
  });
}

/**
 * Display-only cleanup for heading text (page <h1>s, a file's own title,
 * and the shadow labels in lib/docs-nav.ts): the " — " em dash reads
 * heavy as a title separator, so it's swapped for a plain hyphen here.
 * Only ever applied to a HEADING line — never to body prose, which stays
 * exactly as authored in the source file.
 */
export function cleanHeadingText(text: string): string {
  return text.replace(/\s+—\s+/g, " - ");
}

/**
 * One `##` section of a source file: its heading line through (not
 * including) the next `##` heading or end of file. Any `###`+
 * subheadings inside stay nested in `body` untouched.
 */
export type MdSection = { heading: string; body: string };

/**
 * Splits one repo markdown file into the group landing page it backs
 * (`title` + `preamble`: everything before the first `##`) and the list
 * of `##` sections that follow, in file order. This is the one place
 * that understands the *shape* of a source file; lib/docs-nav.ts only
 * has to agree on how many sections there are and what to call each one.
 */
export function splitDoc(markdown: string): { title: string; preamble: string; sections: MdSection[] } {
  const lines = markdown.split("\n");
  const titleMatch = lines[0]?.match(/^#\s+(.+)$/);
  const title = titleMatch ? cleanHeadingText(titleMatch[1].trim()) : "";
  const bodyLines = titleMatch ? lines.slice(1) : lines;

  const sections: MdSection[] = [];
  const preambleLines: string[] = [];
  let current: MdSection | null = null;

  for (const line of bodyLines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      if (current) sections.push(current);
      const heading = cleanHeadingText(h2[1].trim());
      current = { heading, body: `## ${heading}\n` };
    } else if (current) {
      current.body += line + "\n";
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push(current);

  return { title, preamble: preambleLines.join("\n").trim(), sections };
}

/**
 * Strips inline markdown (code spans, bold, links) down to plain text —
 * for the odd spot a heading's text is needed outside the markdown
 * renderer, e.g. a page's <title>.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

/**
 * Reduces a markdown string to plain search-index text: drops fenced
 * code blocks entirely (code tokens are noisy, low-signal matches for a
 * prose search box), strips heading hashes/list bullets/table pipes,
 * and reuses plainText()'s inline-markdown stripping for the rest. Used
 * only by lib/search-index.ts to build the docs search index — never
 * for anything rendered, so it doesn't need to preserve structure.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Pulls one named "##" section out of an arbitrary markdown file — heading
 * line through (not including) the next "##" or end of file. Unlike
 * splitDoc, this doesn't assume the file's own title sits on line 1
 * (README.md's does not: it opens with a centered <div> and badges), so
 * it's used for pulling a single well-known section out of a file that
 * isn't structured like the docs/guides/*.md files.
 */
export function extractSection(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (startIndex === -1) return null;

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join("\n").trim() + "\n";
}

/**
 * Repo-relative markdown links (`../CHECKS.md`, `configuration.md#x`) are
 * correct on GitHub and meaningless here: the browser resolves them
 * against the docs URL, so `../CHECKS.md` on /docs/cli/checks asks for
 * /docs/CHECKS.md and 404s. Every such link is rewritten at render time
 * by docLinkHref() below — see components/docs-article.tsx, which passes
 * it to react-markdown as `urlTransform`.
 */
const REPO_BLOB_BASE = "https://github.com/wasit-dev/wasit/blob/main/";

/**
 * Repo files the docs site republishes, and the group key each one is
 * served under. A link to one of these should land on the site rather
 * than bounce the reader out to GitHub — anything NOT listed here (the
 * docs/design/* notes, docs/findings/upstream-sdk.md) has no page here
 * and is sent to GitHub instead.
 */
const SITE_GROUP_BY_REPO_PATH: Record<string, string> = {
  "docs/guides/cli.md": "cli",
  "docs/guides/mcp.md": "mcp",
  "docs/guides/core.md": "core",
  "docs/guides/configuration.md": "configuration",
  "docs/CHECKS.md": "checks",
  "SECURITY.md": "security",
};

/**
 * Resolves a repo-relative href against the directory of the file it was
 * written in, yielding a path from the repo root. Returns null for
 * anything that is not a repo-relative link — absolute URLs, mailto:,
 * and pure `#anchor` links all pass through untouched.
 */
function resolveRepoPath(href: string, sourceFile: string): { path: string; hash: string } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) {
    return null;
  }
  const [rawPath, ...hashParts] = href.split("#");
  if (!rawPath) return null;

  const segments = sourceFile.split("/").slice(0, -1);
  for (const part of rawPath.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return { path: segments.join("/"), hash: hashParts.join("#") };
}

/**
 * Mirrors rehype-slug (github-slugger) closely enough to match a heading
 * anchor an author actually wrote by hand. A hash that does not match
 * any section simply falls back to the group's Overview page, which is
 * a real page — this never manufactures a 404.
 */
function headingSlug(heading: string): string {
  return plainText(heading)
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * The href a repo-relative link should point at once rendered here.
 *
 * A file the site republishes resolves to its own page — and when the
 * link carries a heading anchor, to the specific page that heading was
 * split onto, since each "##" section becomes a standalone page. Every
 * other repo path resolves to GitHub, which is the only place it exists.
 */
export function docLinkHref(href: string, sourceFile: string): string {
  const resolved = resolveRepoPath(href, sourceFile);
  if (!resolved) return href;

  const { path, hash } = resolved;
  const groupKey = SITE_GROUP_BY_REPO_PATH[path];
  if (!groupKey) {
    return REPO_BLOB_BASE + path + (hash ? `#${hash}` : "");
  }

  const group = findGroup(groupKey);
  if (!group) return REPO_BLOB_BASE + path + (hash ? `#${hash}` : "");

  const overview = `/docs/${group.pages[0].slug.join("/")}`;
  if (!hash) return overview;

  const { sections } = splitDoc(readRepoDoc(path));
  const index = sections.findIndex((section) => headingSlug(section.heading) === hash);
  if (index === -1) return overview;

  const page = group.pages[index + 1];
  return page ? `/docs/${page.slug.join("/")}` : overview;
}

/**
 * Which repo file backs each collapsible group in lib/docs-nav.ts, keyed
 * by that group's own first slug segment (e.g. "cli" for the group whose
 * pages all start ["cli", ...]).
 */
const GROUP_SOURCE_FILES: Record<string, string> = {
  cli: "docs/guides/cli.md",
  mcp: "docs/guides/mcp.md",
  core: "docs/guides/core.md",
  configuration: "docs/guides/configuration.md",
  checks: "docs/CHECKS.md",
  security: "SECURITY.md",
};

/**
 * The repo file a docs URL is served from, or undefined for the pages
 * that are hand-authored rather than republished (Get Started, About).
 * docs-article.tsx needs it to resolve that file's own relative links —
 * a link is only meaningful relative to the file it was written in.
 */
export function docSourceFile(slug: string[]): string | undefined {
  return GROUP_SOURCE_FILES[slug[0]];
}

function findGroup(key: string): DocNavGroup | undefined {
  return DOCS_NAV.find(
    (entry): entry is DocNavGroup => entry.kind === "group" && entry.pages[0]?.slug[0] === key
  );
}

/**
 * Fails the build loudly instead of silently mis-mapping pages: every
 * group in lib/docs-nav.ts must list exactly one "Overview" page plus
 * one page per "##" section actually present in its source file, in the
 * same order. Runs once, at module load.
 */
function assertDocsInSync(): void {
  for (const [key, sourceFile] of Object.entries(GROUP_SOURCE_FILES)) {
    const group = findGroup(key);
    if (!group) {
      throw new Error(`docs: no nav group found for source "${sourceFile}" (key "${key}")`);
    }

    const { sections } = splitDoc(readRepoDoc(sourceFile));
    const expected = group.pages.length - 1; // pages[0] is "Overview"
    if (sections.length !== expected) {
      throw new Error(
        `docs: ${sourceFile} has ${sections.length} "##" sections but lib/docs-nav.ts lists ${expected} ` +
          `pages for "${group.title}" — update DOCS_NAV to match.`
      );
    }

    // Counts alone are not enough. resolveDocMarkdown matches a nav page to a
    // section BY POSITION, so swapping two "##" sections in a source file
    // keeps the count identical and serves the wrong body under the wrong
    // sidebar label, with the build still green. Comparing the titles turns
    // that silent mis-render into a build failure, and catches a merely stale
    // label on the way.
    group.pages.slice(1).forEach((page, index) => {
      const sectionTitle = plainText(sections[index].heading);
      if (page.title !== sectionTitle) {
        throw new Error(
          `docs: section ${index + 1} of ${sourceFile} is "${sectionTitle}", but lib/docs-nav.ts ` +
            `calls that page "${page.title}". Pages and sections are matched by position, so this ` +
            `is either a stale label or a reordered section — update DOCS_NAV to match.`
        );
      }
    });

    assertLinksResolve(sourceFile);
  }
}

/**
 * Fails the build on a repo-relative link that points at a file which
 * does not exist.
 *
 * docLinkHref() rewrites these links so they work on the site, but a
 * rewrite cannot rescue a target that was wrong to begin with — and
 * neither GitHub nor Next.js reports one. docs/guides/core.md carried
 * `(docs/CHECKS.md)` for exactly this reason: written from the repo
 * root's point of view, it resolved to docs/guides/docs/CHECKS.md and
 * was quietly broken in both places. Checking the resolved path against
 * the filesystem turns that into a red build.
 *
 * Only the target FILE is verified, never the heading anchor: an
 * unmatched anchor degrades to the group's Overview page, which is a
 * real page, so it is not worth failing a build over.
 */
function assertLinksResolve(sourceFile: string): void {
  const markdown = readRepoDoc(sourceFile);
  const links = markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g);

  for (const link of links) {
    const resolved = resolveRepoPath(link[1], sourceFile);
    if (!resolved) continue;
    if (existsSync(join(process.cwd(), "..", resolved.path))) continue;

    throw new Error(
      `docs: ${sourceFile} links to "${link[1]}", which resolves to "${resolved.path}" — ` +
        `no such file in the repo. Repo-relative links are resolved against the linking ` +
        `file's own directory, on GitHub and here alike.`
    );
  }
}

assertDocsInSync();

/** Resolves one docs page's markdown from its URL slug (the segments
 *  after /docs). Returns null for anything generateStaticParams didn't
 *  enumerate — the route calls notFound() on that. */
function getHowItWorksMarkdown(): string {
  const readme = readRepoDoc("README.md");
  const section = extractSection(readme, "How It Works");
  if (!section) {
    throw new Error(
      'docs: README.md has no "## How It Works" section anymore — update the Get Started group in lib/docs-nav.ts / lib/content.ts.'
    );
  }
  return promoteHeadings(section);
}

/**
 * "Why Wasit Exists" — the Overview group's second page
 * (/docs/overview/why). Reuses README.md's own "## The Problem" section
 * verbatim, the same way getHowItWorksMarkdown() reuses "## How It
 * Works", so this page can't drift from the README's real explanation.
 *
 * The section's own "## The Problem" heading line is dropped rather than
 * promoted — unlike getHowItWorksMarkdown(), nothing here becomes a whole
 * page under its own extracted title. The caller supplies the "Why Wasit
 * Exists" h1 instead (see resolveDocMarkdown). The body has no nested headings, so no
 * promoteHeadings() shift is needed. The two doc links inside it are
 * repo-relative (resolve on GitHub, not on this site), so they're
 * rewritten to real GitHub blob URLs; everything else — including the
 * one em dash in the body prose — stays exactly as authored in the
 * README, consistent with extractSection()'s own contract.
 */
export function getWhyItExistsMarkdown(): string {
  const readme = readRepoDoc("README.md");
  const section = extractSection(readme, "The Problem");
  if (!section) {
    throw new Error(
      'site: README.md has no "## The Problem" section anymore — update the Overview group in lib/docs-nav.ts / lib/content.ts.'
    );
  }

  const body = section
    .replace(/^##\s+The Problem\s*\n+/, "")
    .replace(
      /\(docs\/CHECKS\.md(#[^)]*)?\)/g,
      "(https://github.com/wasit-dev/wasit/blob/main/docs/CHECKS.md$1)"
    )
    .replace(
      /\(docs\/findings\/upstream-sdk\.md\)/g,
      "(https://github.com/wasit-dev/wasit/blob/main/docs/findings/upstream-sdk.md)"
    )
    .trim();

  return `${body}

## Who it's for

**Shipping a service.** Run Wasit against your own x402 or MPP endpoint before a customer finds the gap you missed.

**Building on top of one.** Wire Wasit's MCP tools into an agent so it checks a target's real compliance before trusting it.
`;
}

/**
 * "Wasit" — the docs sidebar's own orientation page (see the
 * Overview group in lib/docs-nav.ts), for someone who opened /docs
 * without having read the README first. Reuses README.md's own opening
 * tagline (hand-copied here, since it sits before any "##" heading and
 * so can't be pulled with extractSection) plus its real "## Status"
 * table verbatim, the same way getWhyItExistsMarkdown() reuses "## The
 * Problem" — so the status this page shows can never say something the
 * README itself doesn't also say.
 *
 * The tagline paragraph is intentionally NOT hand-expanded beyond what
 * the README already claims — this page orients rather than
 * re-explaining, so there is exactly one place each explanation lives.
 * Where it used to end with a short "where to go next" list, the route
 * now renders components/docs-cards.tsx underneath instead: the same
 * job, done for every section rather than three hand-picked ones.
 */
export function getAboutMarkdown(): string {
  const readme = readRepoDoc("README.md");
  const statusSection = extractSection(readme, "Status");
  if (!statusSection) {
    throw new Error(
      'docs: README.md has no "## Status" section anymore — update getAboutMarkdown() in lib/content.ts.'
    );
  }

  const status = statusSection
    .replace(
      /\(docs\/evidence\/([^)]+)\)/g,
      "(https://github.com/wasit-dev/wasit/blob/main/docs/evidence/$1)"
    )
    .replace(/\(#design-notes\)/g, "(https://github.com/wasit-dev/wasit#design-notes)")
    .replace(/\[docs\/CHECKS\.md\]\(docs\/CHECKS\.md\)/g, "[Check Catalogue](/docs/checks/overview)")
    .replace(/\n+---\s*$/, "")
    .trim();

  return `![Wasit](/logo-light.svg)

# Wasit

Wasit is an independent protocol-compliance tester for two agentic-payment
protocols on Stellar: **x402** and **MPP**. It runs the real payment flow
against a live service and verifies the settlement itself — by reading
Stellar RPC and the token contract's own transfer event — rather than
trusting whatever the service's response claims happened. The x402 payment
checks also pay on Base Sepolia, Ethereum Sepolia and Solana devnet, where
the settlement is read from that chain's own record of the transfer.

It is not a schema validator. A response can have every field in the right
place and still take money without settling it; that gap is exactly what
Wasit checks for.

## Why it exists

x402 and MPP ship an official SDK. Neither ships an independent way to check
that a service actually implements it — nothing plays the role
\`stellar-anchor-tests\` plays for the anchor ecosystem. "We support x402" is
currently a claim nobody can check from the outside.

[Why Wasit Exists](/docs/overview/why) has the full story, including three concrete
divergences between documentation and shipped SDK behavior that turned up
while building this tool.

## What you get

One check suite, two ways to run it:

- **[\`@wasit-dev/cli\`](https://www.npmjs.com/package/@wasit-dev/cli)** — the
  \`wasit\` terminal command, for a local run or a CI job.
- **[\`@wasit-dev/server\`](https://www.npmjs.com/package/@wasit-dev/server)**
  — the same checks as MCP tools, for Claude Code, Claude Desktop, or any
  other MCP-compatible agent.

Both are thin adapters over
[\`@wasit-dev/core\`](https://www.npmjs.com/package/@wasit-dev/core) — there is
only one implementation of each check, so a CLI run and an agent's run can
never disagree about the same target.

${status}
`;
}

export function resolveDocMarkdown(slug: string[]): { title: string; markdown: string } | null {
  if (slug.length !== 2) return null;

  const [groupKey, pageSlug] = slug;

  // The three hand-authored groups. Their bodies are static markdown in
  // lib/docs-pages.ts, except the two that reuse a named README section
  // so they cannot drift from the README's own wording.
  if (groupKey === "overview") {
    if (pageSlug === "wasit") return { title: "Wasit", markdown: getAboutMarkdown() };
    if (pageSlug === "why") {
      // getWhyItExistsMarkdown() returns the body without a heading,
      // since it was written for a standalone page that supplied its own.
      return {
        title: "Why Wasit Exists",
        markdown: `# Why Wasit Exists\n\n${getWhyItExistsMarkdown()}`,
      };
    }
    if (pageSlug === "how-it-works") {
      return { title: "How It Works", markdown: getHowItWorksMarkdown() };
    }
    return null;
  }
  if (groupKey === "start") {
    if (pageSlug === "requirements") return { title: "Requirements", markdown: REQUIREMENTS_MD };
    if (pageSlug === "try-it") {
      return { title: "Try it in one command", markdown: TRY_IT_MD };
    }
    if (pageSlug === "quick-setup") return { title: "Quick setup", markdown: QUICK_SETUP_MD };
    return null;
  }
  if (groupKey === "install") {
    if (pageSlug === "packages") return { title: "Packages", markdown: PACKAGES_MD };
    if (pageSlug === "from-source") return { title: "From source", markdown: FROM_SOURCE_MD };
    if (pageSlug === "verify") return { title: "Verify the install", markdown: VERIFY_MD };
    return null;
  }
  const sourceFile = GROUP_SOURCE_FILES[groupKey];
  const group = findGroup(groupKey);
  if (!sourceFile || !group) return null;

  const { title, preamble, sections } = splitDoc(readRepoDoc(sourceFile));

  if (pageSlug === "overview") {
    return { title, markdown: `# ${title}\n\n${preamble}\n` };
  }

  // pages[0] is "Overview"; the rest line up 1:1 with `sections`, in file
  // order — that's the contract assertDocsInSync() checks above.
  const sectionPages = group.pages.slice(1);
  const index = sectionPages.findIndex((p) => p.slug[1] === pageSlug);
  if (index === -1 || !sections[index]) return null;

  return { title: plainText(sections[index].heading), markdown: promoteHeadings(sections[index].body) };
}

/**
 * Every slug generateStaticParams needs for /docs/[...slug] — every
 * group page. "Install" lives at /docs itself (app/docs/page.tsx), so
 * it's excluded here.
 */
export function allDocSlugs(): string[][] {
  return DOCS_NAV.flatMap((entry) => (entry.kind === "group" ? entry.pages : [entry.page]))
    .map((page) => page.slug)
    .filter((slug) => slug.length > 0);
}
