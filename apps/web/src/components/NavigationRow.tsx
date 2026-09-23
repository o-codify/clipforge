"use client";
import Link from "next/link";
import type { ReactNode } from "react";
/** Native link stretched across the row; other controls stay above its hit area. */
export function NavigationRow({href,label,children}:{href:string;label:ReactNode;children:ReactNode}){
  return <tr className="navigation-row"><td><Link className="row-destination" href={href}>{label}</Link></td>{children}</tr>;
}
