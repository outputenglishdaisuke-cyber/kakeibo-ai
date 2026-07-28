import * as React from "react";
import { cn } from "@/lib/utils";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  color?: string;
}

export function Badge({ className, color, children, style, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        className
      )}
      style={{ backgroundColor: color ? `${color}22` : undefined, color: color, ...style }}
      {...props}
    >
      {children}
    </span>
  );
}
