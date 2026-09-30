import type { Viewer } from "./api";
export const WORKSPACE_LINKS = [
  { href: "/", label: "Обзор", icon: "overview" },
  { href: "/clips", label: "Клипы", icon: "clips" },
  { href: "/streamers", label: "Стримеры", icon: "streamers" },
  { href: "/games", label: "Игры", icon: "games" },
  { href: "/jobs", label: "Задания", icon: "jobs" },
  { href: "/workers", label: "Воркеры", icon: "workers" },
  { href: "/publications", label: "Публикация", icon: "publications" },
  { href: "/shorts", label: "На YouTube", icon: "clips" },
  { href: "/analytics", label: "Статистика", icon: "analytics" },
] as const;

export function activeSection(path: string) {
  if (path.startsWith("/settings")) return "/settings";
  if (path.startsWith("/vods/") || path === "/discovery") return "/streamers";
  if (path.startsWith("/runs/")) return "/jobs";
  return WORKSPACE_LINKS.find(item => item.href !== "/" && (path === item.href || path.startsWith(`${item.href}/`)))?.href ?? (path === "/me" ? "/me" : "/");
}

export function pageTitle(path: string, isAdmin: boolean) {
  if (path === "/shorts") return "Опубликованные Shorts";
  if (path === "/me") return "Мой профиль";
  if (path === "/settings/accounts") return "Аккаунты";
  if (path === "/settings/publication") return "Публикации";
  if (path === "/settings") return "Платформа";
  if (path === "/discovery") return "Поиск стримеров";
  if (path.startsWith("/vods/")) return "Эфир";
  if (path.startsWith("/runs/")) return "Прогон";
  if (path.startsWith("/streamers/")) return "Канал стримера";
  if (path.startsWith("/games/")) return "Игра и эфиры";
  return WORKSPACE_LINKS.find(item => item.href === path)?.label ?? "ClipForge";
}

export function sectionNumber(path: string) {
  return ({"/":"01", "/clips":"02", "/streamers":"03", "/games":"04", "/jobs":"05", "/workers":"06", "/publications":"07", "/shorts":"08", "/analytics":"09", "/settings":"10", "/me":"11"} as Record<string,string>)[activeSection(path)] ?? "01";
}

export function workspaceLinks(viewer: Viewer): {href:string;label:string;icon:string}[] {
  const channel = viewer.actingAs && viewer.actingAs !== "__unlinked_account__" ? viewer.actingAs : null;
  return [
    ...WORKSPACE_LINKS.filter(item=>viewer.isAdmin||!['/workers','/publications','/shorts','/analytics'].includes(item.href)).flatMap<{href:string;label:string;icon:string}>(item => item.href === "/streamers" && viewer.role === "user"
      ? channel ? [{...item, href:`/streamers/${channel}`, label:"Мой канал"}] : [] : [item]),
    ...(viewer.isAdmin ? [{href:"/settings",label:"Управление",icon:"settings"}] : []),
    {href:"/me",label:"Мой профиль",icon:"profile"},
  ];
}
