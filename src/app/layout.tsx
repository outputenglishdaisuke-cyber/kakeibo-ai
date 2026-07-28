import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/Sidebar";

const geist = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "家計簿AI",
  description: "AI による自動分類付き家計簿アプリ",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className={`${geist.variable} h-full antialiased`}>
      <body className="h-full bg-gray-50 text-gray-900">
        <Sidebar />
        <main className="min-h-screen px-4 pb-24 pt-16 md:ml-56 md:p-8 md:pb-8 md:pt-8">
          {children}
        </main>
      </body>
    </html>
  );
}
