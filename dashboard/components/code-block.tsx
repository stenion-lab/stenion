'use client';

import { Check, Copy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A rendered markdown code fence with a copy button.
 *
 * Exists for API.md, where every block is something an integrator is going to
 * paste — a curl line, a JSON body, a TypeScript snippet. It is wired into
 * MarkdownDoc's `pre` override, so METHODOLOGY.md's blocks get it too; that is
 * fine (its formula blocks are also worth copying) and it keeps one code-block
 * treatment across the site rather than two.
 *
 * `raw` is the flattened text, passed in from MarkdownDoc rather than read back
 * out of the DOM: the children here are React nodes, and re-deriving the string
 * from a ref would mean trusting whatever whitespace the browser reports.
 *
 * NO SYNTAX HIGHLIGHTING, deliberately. Every option is a new dependency
 * (highlight.js, shiki, prism) for colour on a handful of blocks, and this
 * project doesn't add dependencies for polish. The blocks are short, fenced with
 * a language for anyone reading the source on GitHub, and legible without it.
 */
export function CodeBlock({ raw, children }: { raw: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The confirmation is a timeout, so it has to be cancelled if the component
  // goes away first (route change mid-flight) or the state set would leak.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(raw);
    } catch {
      // Clipboard is permission-gated and unavailable on insecure origins. There
      // is nothing useful to say and nothing to retry — the text is right there
      // and selectable — so fail silently rather than throwing an error toast at
      // someone who can just select it.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }, [raw]);

  return (
    // This component OWNS the <pre>. react-markdown's `pre` override is handed the
    // element's *children* (the <code>), not the element, so rendering only the
    // wrapper here would drop <pre> from the output entirely — taking monospace,
    // whitespace preservation and prose's `overflow-x: auto` with it, which is
    // exactly what keeps a long JSON body from widening the page on a phone.
    //
    // `my-0` cancels prose's own pre margins and moves them to the wrapper, so the
    // absolutely-positioned button anchors to the code block's real top edge
    // rather than depending on margin collapsing through this div.
    //
    // The `pr-*` reserves the button's own footprint, so a short first line — an
    // `http` header, an opening brace — can't render underneath it. It widens at
    // `sm` because that's where the button grows a text label. A line long enough
    // to scroll still passes under the button, which is why the button is opaque.
    <div className="group relative my-6 [&>pre]:my-0 [&>pre]:pr-12 sm:[&>pre]:pr-24">
      <pre>{children}</pre>
      <button
        type="button"
        onClick={copy}
        // Always visible rather than hover-only: half this page's readers are on a
        // phone, where there is no hover and a hidden affordance is no affordance.
        // Opaque background because the block scrolls horizontally underneath it.
        className="cursor-pointer absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        aria-label={copied ? 'Copied code to clipboard' : 'Copy code to clipboard'}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-safe" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
        {/* Hidden below sm: on a narrow screen the label is what pushes the
            button wide enough to sit over the code it's meant to let you copy. */}
        <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}
