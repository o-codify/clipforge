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

/** Suggestions only; accepted metadata is never regenerated on the worker. */
export function suggestVideoMetadata(row: {
  text: string | null; trigger: string | null; displayName: string; login: string; gameTitle: string | null;
}): VideoMetadata {
  const triggers: Record<string, string> = { combat: "Жаркий момент", reaction: "Реакция", speech: "Разговор", loudness: "Громкий момент" };
  const hook = (row.text ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const lead = [...hook].slice(0, 55).join("") || triggers[row.trigger ?? ""] || "Момент";
  return {
    title: [...`${lead} — ${row.displayName}${row.gameTitle ? ` | ${row.gameTitle}` : ""}`.replace(/[<>]/g, "")].slice(0, 100).join(""),
    description: `Клип со стрима ${row.displayName}\nTwitch: https://twitch.tv/${row.login}${row.gameTitle ? `\nИгра: ${row.gameTitle}` : ""}`.replace(/[<>]/g, ""),
    privacy: "private",
  };
}
