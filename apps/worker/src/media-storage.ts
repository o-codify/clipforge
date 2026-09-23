import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type { Context } from "./context.js";

export async function storeClip(ctx: Context, id: string, file: string) {
  if (!ctx.storage) return null;
  const poster = `${file}.jpg`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-y", "-ss", "2.5", "-i", file,
      "-frames:v", "1", "-vf", "scale=270:-2", poster], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Poster generation timed out")); }, 60_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Poster generation failed")); });
  });
  await access(poster);
  const videoKey = ctx.storage.key(id, "video.mp4");
  const posterKey = ctx.storage.key(id, "poster.jpg");
  await ctx.storage.uploadFile(videoKey, file, "video/mp4");
  await ctx.storage.uploadFile(posterKey, poster, "image/jpeg");
  return { videoKey, posterKey };
}
