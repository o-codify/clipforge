"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

/** Keep page controls outside the scrollable results, including on narrow screens. */
export function PageScroll({ children, className = "" }: { children: ReactNode; className?: string }) {
  const path = usePathname();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { ref.current?.scrollTo(0, 0); }, [path]);

  return <div ref={ref} className={`page-scroll${className ? ` ${className}` : ""}`} role="region" aria-label="Содержимое страницы" tabIndex={0}>
    {children}
  </div>;
}
