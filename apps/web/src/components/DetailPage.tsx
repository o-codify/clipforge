import type { ReactNode } from "react";
import { PageScroll } from "./PageScroll";

/** The toolbar sticks to the unpadded scroll boundary; results cannot appear above it. */
export function DetailPage({intro,toolbar,children}:{intro:ReactNode;toolbar?:ReactNode;children:ReactNode}) {
  return <PageScroll className="detail-page-scroll">
    <div className="detail-page-intro">{intro}</div>
    {toolbar&&<div className="page-toolbar detail-page-toolbar" role="group" aria-label="Фильтры эфиров">{toolbar}</div>}
    <div className="detail-page-content">{children}</div>
  </PageScroll>;
}
