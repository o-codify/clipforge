export interface VideoMetadata {
  title: string;
  description: string;
  privacy: "private" | "unlisted" | "public";
}

/** Validate without silently changing the uploader's text. */
export function validateVideoMetadata(value: VideoMetadata): void {
  if (!value.title.trim() || [...value.title].length > 100 || /[<>]/.test(value.title)) {
    throw new Error("Название должно содержать от 1 до 100 символов без знаков < и >");
  }
  if (Buffer.byteLength(value.description, "utf8") > 5000 || /[<>]/.test(value.description)) {
    throw new Error("Описание должно занимать не более 5000 байт и не содержать знаков < и >");
  }
  if (!["private", "unlisted", "public"].includes(value.privacy)) throw new Error("Выберите видимость видео");
}

function hashtag(value: string): string {
  return [...value.normalize("NFKC").replace(/[^\p{L}\p{N}_]/gu, "")].slice(0, 64).join("");
}

/** A small set of relevant, clickable tags, shared by manual and scheduled uploads. */
export function descriptionHashtags(login: string, gameTitle: string | null): string[] {
  const aliases: Record<string, string> = {
    "dota 2": "Dota2", "pubg: battlegrounds": "PUBG", "counter-strike 2": "CS2",
  };
  const game = gameTitle?.trim() ?? "";
  const values = [game ? aliases[game.toLowerCase()] ?? game : "", login, "Twitch", "Shorts"];
  const seen = new Set<string>();
  return values.map(hashtag).filter(tag => {
    const key = tag.toLowerCase();
    if (!tag || key === "безкатегории" || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(tag => `#${tag}`);
}

/** Suggestions only; accepted metadata is never regenerated on the worker. */
export function suggestVideoMetadata(row: {
  text: string | null; trigger: string | null; displayName: string; login: string; gameTitle: string | null;
}): VideoMetadata {
  const triggers: Record<string, string> = { combat: "Жаркий момент", reaction: "Реакция", speech: "Разговор", loudness: "Громкий момент" };
  const hook = (row.text ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const lead = [...hook].slice(0, 55).join("") || triggers[row.trigger ?? ""] || "Момент";
  return {
    title: [...`${lead} — ${row.displayName}${row.gameTitle ? ` | ${row.gameTitle}` : ""}`.replace(/[<>]/g, "")].slice(0, 100).join(""),
    description: `${descriptionHashtags(row.login, row.gameTitle).join(" ")}\n\nКлип со стрима ${row.displayName}\nTwitch: https://twitch.tv/${row.login}`.replace(/[<>]/g, ""),
    privacy: "private",
  };
}
