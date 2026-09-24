export const WORKSPACE_LINKS = [
  { href: "/", label: "Обзор", icon: "overview" },
  { href: "/clips", label: "Клипы", icon: "clips" },
  { href: "/streamers", label: "Стримеры", icon: "streamers" },
  { href: "/games", label: "Игры", icon: "games" },
  { href: "/jobs", label: "Задания", icon: "jobs" },
] as const;

export function activeSection(path: string) {
  if (path.startsWith("/vods/") || path === "/discovery") return "/streamers";
  if (path.startsWith("/runs/")) return "/jobs";
  return WORKSPACE_LINKS.find(item => item.href !== "/" && (path === item.href || path.startsWith(`${item.href}/`)))?.href ?? (path === "/me" ? "/me" : "/");
}

export function pageTitle(path: string, isAdmin: boolean) {
  if (path === "/me") return isAdmin ? "Настройки площадки" : "Мой профиль";
  if (path === "/discovery") return "Поиск стримеров";
  if (path.startsWith("/vods/")) return "Эфир";
  if (path.startsWith("/runs/")) return "Прогон";
  if (path.startsWith("/streamers/")) return "Канал стримера";
  if (path.startsWith("/games/")) return "Игра и эфиры";
  return WORKSPACE_LINKS.find(item => item.href === path)?.label ?? "ClipForge";
}
