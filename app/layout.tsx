import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Todo planner',
  description: 'Tasks, recurring routines, reminders and checklists in Singapore time.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
