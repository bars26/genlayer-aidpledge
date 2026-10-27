import type { Metadata, Viewport } from "next";
import { DM_Serif_Display, Figtree } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const serif = DM_Serif_Display({ subsets: ["latin"], weight: "400", variable: "--font-serif" });
const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree" });

export const metadata: Metadata = {
  title: "AidPledge — did the aid arrive?",
  description:
    "Bond GEN behind a donor's announced humanitarian pledge. GenLayer validators read the announcement, then OCHA's Financial Tracking Service after the deadline; a shortfall pays out in proportion to the gap.",
  manifest: "/site.webmanifest",
  icons: { icon: [{ url: "/favicon.svg", type: "image/svg+xml" }] },
};

export const viewport: Viewport = {
  themeColor: "#F7F4EC",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${serif.variable} ${figtree.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
