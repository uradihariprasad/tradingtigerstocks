import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PULSE · NSE F&O Intraday Scanner",
  description:
    "Two-stage NSE F&O intraday scanner — Stage-1 market-wide momentum filter and Stage-2 deep structure / option-chain trade setup engine. Powered exclusively by Upstox market data.",
};

export const viewport: Viewport = {
  themeColor: "#04060b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,300..800;1,400&family=Space+Grotesk:wght@300..700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
