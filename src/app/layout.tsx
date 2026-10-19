import type { Metadata } from 'next';
import { Big_Shoulders, JetBrains_Mono, Public_Sans } from 'next/font/google';
import { Suspense } from 'react';
import { Flash } from '@/components/Flash';
import './globals.css';

const display = Big_Shoulders({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-disp', display: 'swap', adjustFontFallback: false });
const body = Public_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-body', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'DepFlx Club',
  description: 'Poker club operations: members, cards, wallet, floor, kitchen.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        {children}
        <Suspense>
          <Flash />
        </Suspense>
      </body>
    </html>
  );
}
