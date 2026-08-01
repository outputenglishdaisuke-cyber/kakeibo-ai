"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  List,
  Upload,
  Tag,
  BookOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "ダッシュボード", shortLabel: "ホーム", icon: LayoutDashboard },
  { href: "/transactions", label: "明細一覧", shortLabel: "明細", icon: List },
  { href: "/import", label: "データ取り込み", shortLabel: "取込", icon: Upload },
  { href: "/categories", label: "カテゴリ管理", shortLabel: "分類", icon: Tag },
  { href: "/rules", label: "ルール管理", shortLabel: "ルール", icon: BookOpen },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <>
      {/* PC: 左サイドバー（現状維持） */}
      <aside className="fixed left-0 top-0 z-40 hidden h-full w-56 border-r border-gray-200 bg-white md:block">
        <div className="flex h-16 items-center border-b border-gray-200 px-6">
          <span className="text-xl font-bold text-indigo-600">家計簿AI</span>
        </div>
        <nav className="space-y-1 p-4">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-indigo-50 text-indigo-700"
                    : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* スマホ: 下部固定タブバー */}
      <nav
        className={cn(
          "fixed bottom-0 left-0 right-0 z-40 border-t border-gray-200 bg-white md:hidden",
          "px-3 pt-1.5",
          "pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        )}
      >
        <div className="mx-auto flex max-w-lg items-stretch justify-between gap-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1.5 py-2 text-xs font-medium transition-colors",
                  active
                    ? "bg-indigo-50 text-indigo-600"
                    : "text-gray-500 active:bg-gray-50"
                )}
              >
                <Icon className={cn("h-6 w-6", active && "text-indigo-600")} />
                <span className="leading-none">{item.shortLabel}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* スマホ: 上部ブランドバー */}
      <header className="fixed left-0 right-0 top-0 z-30 flex h-12 items-center border-b border-gray-200 bg-white px-4 md:hidden">
        <span className="text-lg font-bold text-indigo-600">家計簿AI</span>
      </header>
    </>
  );
}
