"use client";

import { createContext, useContext } from "react";
import type { Viewer } from "./api";

export { SESSION_EXPIRED } from "./api";
export const SessionContext = createContext<{
  viewer: Viewer;
  updateViewer: (viewer: Viewer) => void;
  logout: () => Promise<void>;
} | null>(null);

/** The persistent shell owns the session; pages never fetch their own copy. */
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Session requires the authenticated shell");
  return session;
}
