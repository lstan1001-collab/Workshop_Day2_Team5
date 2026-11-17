import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Todo App | Passkeys',
  description: 'Sign in to your Todo App with a passkey.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body><main id="main-content">{children}</main></body>
    </html>
  );
}
