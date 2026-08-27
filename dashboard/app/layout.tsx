import type { Metadata } from 'next';
import { Analytics } from '@vercel/analytics/next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Space_Grotesk } from 'next/font/google';
import { Nav } from '../components/nav';
import { Footer } from '../components/footer';
import './globals.css';

// Self-hosted Geist (no network fetch) for UI + tabular numbers; Space Grotesk
// (display) only for large headings, to give the site a real type pairing
// instead of a single-font, system-ui look.
const display = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Stenion — live risk intelligence for Stellar DeFi',
    template: '%s · Stenion',
  },
  description:
    'Continuous, on-chain-derived safety scores for Stellar/Soroban DeFi protocols. Audits are a snapshot; Stenion tracks risk as it moves.',
};

// Resolve the theme BEFORE first paint. This is a blocking inline script in
// <head>, deliberately not a useEffect — an effect runs after hydration, which
// is precisely when the wrong-theme flash happens.
//
// It only writes `data-theme` for an EXPLICIT light/dark choice. "System" is
// the absence of the attribute, which lets the `prefers-color-scheme` block in
// globals.css apply on its own — so system mode needs no JS at all, keeps
// following the OS live, and still paints correctly if this script fails.
const THEME_INIT = `(function(){try{var c=localStorage.getItem('stenion-theme');var d=document.documentElement;if(c==='light'||c==='dark'){d.setAttribute('data-theme',c)}else{d.removeAttribute('data-theme')}}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the script above mutates `data-theme` before
    // React hydrates, so the server HTML and the live DOM differ by design.
    <html
      lang="en"
      suppressHydrationWarning
      data-scroll-behavior="smooth"
      className={`${GeistSans.variable} ${GeistMono.variable} ${display.variable}`}
    >
      <body className="min-h-screen bg-bg text-ink antialiased">
        {/* FIRST child of <body>, and deliberately NOT inside a <head> element.
            Inside <head> this is part of the React tree Next may stream: on a
            route that calls notFound() the head is already flushed, so the tag
            arrived only in the RSC payload as serialised JSON and never
            executed — /protocol/<unknown-id> rendered in the wrong theme while
            every other route was fine. At the top of <body> it is always in the
            initial shell. It still runs before first paint: the stylesheet is
            already in <head>, and a synchronous inline script blocks parsing,
            so the attribute is set before any body content is laid out. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-bg focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
        >
          Skip to main content
        </a>
        <Nav />
        <main id="main-content">{children}</main>
        <Footer />
        {/* Vercel Analytics — client component that injects the pageview script.
            Renders no markup, so it sits last and can't affect layout. Pageviews
            only: no props, no custom events, and nothing protocol- or score-related
            is ever passed to it. */}
        <Analytics />
      </body>
    </html>
  );
}
