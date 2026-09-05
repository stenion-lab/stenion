import type { Metadata } from 'next';
import { Analytics } from '@vercel/analytics/next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Space_Grotesk } from 'next/font/google';
import { Nav } from '../components/nav';
import { Footer } from '../components/footer';
import './globals.css';

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
  icons: {
    icon: '/icon.png',
    shortcut: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Stenion — live risk intelligence for Stellar DeFi',
    description:
      'Continuous, on-chain-derived safety scores for Stellar/Soroban DeFi protocols. Audits are a snapshot; Stenion tracks risk as it moves.',
  },
};

const THEME_INIT = `(function(){try{var c=localStorage.getItem('stenion-theme');var d=document.documentElement;if(c==='light'||c==='dark'){d.setAttribute('data-theme',c)}else{d.removeAttribute('data-theme')}}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-scroll-behavior="smooth"
      className={`${GeistSans.variable} ${GeistMono.variable} ${display.variable}`}
    >
      <body className="min-h-screen bg-bg text-ink antialiased">
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
        <Analytics />
      </body>
    </html>
  );
}
