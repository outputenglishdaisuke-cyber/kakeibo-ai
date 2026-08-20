"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { parseReceiptItemsMemo } from "@/lib/receipt-aggregation";

export function ReceiptItemsDisclosure({
  memo,
  className,
}: {
  memo?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const receipt = parseReceiptItemsMemo(memo);
  if (!receipt) return null;

  return (
    <div className={className}>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        品目内訳（{receipt.items.length}件）
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1 rounded-md border border-indigo-100 bg-indigo-50/50 px-2.5 py-2 text-xs text-gray-700">
          {receipt.items.map((item, i) => (
            <li
              key={`${item.itemName}-${i}`}
              className="flex items-start justify-between gap-3"
            >
              <span className="min-w-0 truncate">
                {item.itemName}
                {item.categoryName ? (
                  <span className="ml-1 text-gray-400">/{item.categoryName}</span>
                ) : null}
              </span>
              <span className="flex-shrink-0 tabular-nums text-gray-800">
                {formatCurrency(item.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
