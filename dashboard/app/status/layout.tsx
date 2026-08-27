import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Status',
  description:
    "Live indexer health for Stenion's scoring pipeline — overall status plus per-protocol freshness, staleness, and last-run timestamps.",
};

export default function StatusLayout({ children }: { children: React.ReactNode }) {
  return children;
}
