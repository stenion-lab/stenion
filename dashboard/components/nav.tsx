'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Github, Menu, Radar, X } from 'lucide-react';
import { cn } from '../app/lib/cn';
import { GITHUB_URL, NAV_LINKS } from '../app/lib/site';
import { ThemeToggle } from './theme-toggle';

// Same expo-out ease the rest of the site uses (see reveal.tsx) — subtle, not bouncy.
const EASE = [0.16, 1, 0.3, 1] as const;

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstLinkRef = useRef<HTMLAnchorElement>(null);
  const reduceMotion = useReducedMotion();

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  // Close on Escape / outside-click: return focus to the trigger (keyboard UX).
  const closeToTrigger = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Route change closes the menu without stealing focus back to the trigger —
  // focus belongs on the newly-navigated page, not the hamburger.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // While open: lock background scroll, wire Escape, and move focus into the panel.
  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeToTrigger();
    };
    document.addEventListener('keydown', onKeyDown);

    firstLinkRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, closeToTrigger]);

  return (
    <header className="sticky top-0 z-50 border-b border-line/70 bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5">
        <Link
          href="/"
          className="group flex items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent/15 ring-1 ring-inset ring-accent/30">
            <Radar className="h-4 w-4 text-accent" strokeWidth={2} aria-hidden="true" />
          </span>
          <span className="font-display text-lg font-semibold tracking-tight text-ink">
            Stenion
          </span>
        </Link>

        {/* Desktop nav — unchanged layout, just hidden below md. */}
        <nav
          aria-label="Main navigation"
          className="ml-auto hidden items-center gap-1 text-sm md:flex"
        >
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                'relative rounded-md px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                isActive(link.href) ? 'text-ink' : 'text-muted hover:text-ink',
              )}
            >
              {link.label}
              {isActive(link.href) && (
                <span className="absolute inset-x-3 -bottom-px h-px bg-accent" />
              )}
            </Link>
          ))}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Stenion on GitHub (opens in a new tab)"
            className="ml-1 grid h-9 w-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Github className="h-4 w-4" aria-hidden="true" />
          </a>
          <ThemeToggle />
        </nav>

        {/* Mobile trigger — hamburger below md only. */}
        <button
          ref={triggerRef}
          type="button"
          aria-label={open ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={open}
          aria-controls="mobile-menu"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto grid h-9 w-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:hidden"
        >
          {open ? (
            <X className="h-5 w-5" aria-hidden="true" />
          ) : (
            <Menu className="h-5 w-5" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Mobile menu: scrim (outside-click) + slide-down panel. md:hidden so it
          can never surface on desktop even if state is stale across a resize. */}
      <AnimatePresence>
        {open && (
          <div className="md:hidden">
            <motion.div
              aria-hidden
              onClick={closeToTrigger}
              className="fixed inset-x-0 bottom-0 top-16 z-40 bg-bg/60 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.18, ease: EASE }}
            />
            <motion.nav
              id="mobile-menu"
              aria-label="Mobile navigation"
              className="fixed inset-x-0 top-16 z-50 border-b border-line/70 bg-surface/95 backdrop-blur-xl"
              initial={{ opacity: 0, y: reduceMotion ? 0 : -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduceMotion ? 0 : -8 }}
              transition={{ duration: reduceMotion ? 0 : 0.22, ease: EASE }}
            >
              <div className="mx-auto flex max-w-6xl flex-col gap-1 px-3 py-3 text-sm">
                {NAV_LINKS.map((link, i) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    ref={i === 0 ? firstLinkRef : undefined}
                    onClick={() => setOpen(false)}
                    className={cn(
                      'rounded-md px-3 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      isActive(link.href)
                        ? 'bg-surface-2 text-ink'
                        : 'text-muted hover:bg-surface-2 hover:text-ink',
                    )}
                  >
                    {link.label}
                  </Link>
                ))}
                {/* The two icon controls share one row below the links, the same
                    pairing as the desktop bar — the links are the menu, these
                    are the utilities. The theme toggle has to live here at all
                    because the desktop nav is hidden below md, which would
                    otherwise leave the control unreachable on the viewport where
                    most people meet the site. Its own menu closes on selection,
                    but the sheet deliberately stays open so you can see the theme
                    change against the page behind it.

                    Pushed to opposite edges: they're two unrelated utilities,
                    not a group, and the split keeps the toggle at the right edge
                    where its right-pinned menu opens on-screen. */}
                <div className="mt-1 flex items-center justify-between border-t border-line-soft px-3 pt-3">
                  <a
                    href={GITHUB_URL}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Stenion on GitHub (opens in a new tab)"
                    onClick={() => setOpen(false)}
                    className="grid h-9 w-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Github className="h-4 w-4" aria-hidden="true" />
                  </a>
                  <ThemeToggle />
                </div>
              </div>
            </motion.nav>
          </div>
        )}
      </AnimatePresence>
    </header>
  );
}
