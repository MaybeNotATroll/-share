import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Numa — number-based file sharing",
  description: "Share files through simple numeric spaces.",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
