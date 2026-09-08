import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { metadataBase: new URL('https://tabosm.art'), title: 'Tabosmart | Organize Chrome tabs. Keep your headspace.', description: 'Review related tabs, remove selected duplicates and save links for later. Tabosmart is a local Chrome tab organizer with optional on-device AI. Help shape what comes next.', icons: {icon: '/favicon.svg'}, alternates:{canonical:'/'}};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {return <html lang="en"><body>{children}</body></html>}
