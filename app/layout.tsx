import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Music Art", description: "An art-first television experience for music listening." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
