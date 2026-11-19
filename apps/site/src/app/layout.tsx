import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

const SITE = "https://sketchor.sergioalexo.com";
const DESCRIPTION =
  "Sketchor is a modern 2D sketcher for the DXF and DWG files you already have. Install it on Windows, or just open it in your browser — no account, no licence, nothing to configure.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "Sketchor — modern parametric 2D sketching",
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  keywords: ["2D CAD", "DXF editor", "DWG viewer", "free CAD", "SVG", "STEP viewer", "sketcher", "Windows CAD", "browser CAD"],
  authors: [{ name: "Sergio Alexo", url: "https://tech.sergioalexo.com" }],
  openGraph: {
    type: "website",
    url: SITE,
    siteName: "Sketchor",
    title: "Sketchor — 2D CAD that opens instantly",
    description: DESCRIPTION,
  },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { themeColor: "#1e2025", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
