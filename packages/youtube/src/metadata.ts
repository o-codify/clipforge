import { displayTranscript, isProfane, maskProfanity } from "@clipforge/contracts/text";

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

/** Also applied to edited drafts; keep links and description paragraph breaks. */
export function prepareVideoMetadata<T extends VideoMetadata>(value: T): T {
  return {...value, title: displayTranscript(value.title), description: value.description.split(/\r?\n/).map(displayTranscript).join("\n")};
}

const GAME_TAGS: Readonly<Record<string, readonly string[]>> = {
  "dota 2": ["Dota2", "Дота2", "Dota", "Дота"],
  "pubg: battlegrounds": ["PUBG", "Пабг"],
  "playerunknown's battlegrounds": ["PUBG", "Пабг"],
  "counter-strike 2": ["CS2", "CounterStrike2", "КС2"],
  "counter-strike: global offensive": ["CSGO", "CounterStrike", "КСГО"],
};

function gameName(value: string | null): string {
  const name = (value ?? "").replace(/[<>]/g, "").trim();
  return ["без категории", "uncategorized"].includes(name.toLowerCase()) ? "" : name;
}

function hashtag(value: string): string {
  // Do not turn a censored tag into an unrelated clickable word.
  if (maskProfanity(value) !== value) return "";
  const tag = [...value.normalize("NFKC").replace(/[^\p{L}\p{N}_]/gu, "")].slice(0, 64).join("");
  return isProfane(tag) ? "" : tag;
}

/** A small set of relevant, clickable tags, shared by manual and scheduled uploads. */
export function descriptionHashtags(login: string, gameTitle: string | null): string[] {
  const game = gameName(gameTitle);
  const values = [...(game ? GAME_TAGS[game.toLowerCase()] ?? [game] : []), login, "Twitch", "Shorts"];
  const seen = new Set<string>();
  return values.map(hashtag).filter(tag => {
    const key = tag.toLowerCase();
    if (!tag || key === "безкатегории" || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(tag => `#${tag}`);
}

export function videoTags(login: string, gameTitle: string | null): string[] {
  return descriptionHashtags(login, gameTitle).map(tag => tag.slice(1));
}

export interface ClipSource {
  displayName: string;
  login: string;
  gameTitle: string | null;
}

/** Transcript and detection triggers deliberately cannot supply publication copy. */
export function suggestVideoMetadata(row: ClipSource): VideoMetadata {
  const streamer = displayTranscript((row.displayName || row.login).replace(/[<>]/g, ""));
  const game = displayTranscript(gameName(row.gameTitle));
  const tags = descriptionHashtags(row.login, row.gameTitle);
  let title = [...`${streamer}${game ? ` | ${game}` : ""}`].slice(0, 100).join("");
  const titleTags = [game ? tags[0] : null, `#${hashtag(row.login)}`].filter((tag): tag is string => !!tag && tag !== "#");
  for (const tag of new Set(titleTags)) {
    if ([...`${title} ${tag}`].length <= 100) title += ` ${tag}`;
  }
  return {
    title,
    description: [tags.join(" "), "", `Стример: ${streamer}`, ...(game ? [`Игра: ${game}`] : []),
      `Twitch: https://twitch.tv/${encodeURIComponent(row.login)}`].join("\n"),
    privacy: "private",
  };
}
