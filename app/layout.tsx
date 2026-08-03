import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Bangumi SML",
  description: "提名、小组赛、淘汰赛——决出你心中的最萌角色。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
