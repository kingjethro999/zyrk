import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zyrk — A verified shared store for Node packages",
  description:
    "Zyrk verifies npm package sources and reuses compatible dependency contexts across your Node.js projects.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
