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

/**
 * Runs before first paint to set the resolved theme on <html data-theme=...>,
 * so there is no flash of the wrong theme on load. Explicit user choice wins;
 * otherwise the system preference decides; otherwise dark (the default).
 */
const themeScript = `
  (function () {
    try {
      var choice = localStorage.getItem('stenion-theme');
      if (choice === 'light' || choice === 'dark') {
        document.documentElement.setAttribute('data-theme', choice);
      } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
        document.documentElement.setAttribute('data-theme', 'light');
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    } catch (e) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  })();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${GeistSans.variable} ${GeistMono.variable} ${display.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-bg text-ink antialiased">
        <Nav />
        <main>{children}</main>
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