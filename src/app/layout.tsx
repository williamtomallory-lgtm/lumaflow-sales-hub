import "@fontsource-variable/dm-sans";
import "@fontsource-variable/manrope";
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LumaFlow · Chat-AI",
  description: "为销售团队打造的产品知识、智能问答与资料包工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
