import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/shell";
import { WorkspaceProvider } from "@/components/workspace";

export const metadata: Metadata = {
  title: "AnswerLens · AI 推荐情报",
  description: "看两个真实大模型如何理解、比较和推荐你的产品",
  icons: { icon: "/icon.svg" }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <WorkspaceProvider>
          <AppShell>{children}</AppShell>
        </WorkspaceProvider>
      </body>
    </html>
  );
}
