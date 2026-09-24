import type { Metadata } from "next";

import "./globals.css";
import "./design-system.css";
import "@clipforge/assistant/styles.css";
import "./workspace.css";
import { Shell } from "@/components/Shell";

export const metadata: Metadata = {
  title: "ClipForge",
  description: "Нарезка стримов Twitch на вертикальные клипы",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
