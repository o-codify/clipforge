/**
 * Отдача клипов браузеру.
 *
 * Обычной отдачей файла целиком не обойтись: без поддержки Range браузер
 * не умеет перематывать - он запрашивает кусок с нужной позиции и, не
 * получив 206, либо качает файл заново с начала, либо блокирует
 * перемотку вовсе.
 *
 * Путь к файлу берётся из базы по идентификатору клипа, а не из адреса
 * запроса. Принимать путь снаружи нельзя ни в каком виде: это прямая
 * дорога к чтению произвольного файла с диска.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

import { Controller, Get, Inject, NotFoundException, Param, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { storageFromEnv } from "@clipforge/storage";

import { CurrentViewer } from "../auth/auth.guard.js";
import type { Viewer } from "../auth/auth.service.js";
import { CatalogService } from "../catalog/catalog.service.js";
import { CONFIG, type ApiConfig } from "../config.js";

const RANGE = /bytes=(\d*)-(\d*)/;

@Controller("media")
export class MediaController {
  private readonly storage = storageFromEnv();
  constructor(
    private readonly catalog: CatalogService,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get("clip/:id")
  async clip(
    @CurrentViewer() viewer: Viewer | null,
    @Param("id") id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const media = await this.catalog.clipMedia(viewer, id);
    if (media?.storage && this.storage) {
      reply.header("cache-control", "private, no-store");
      return reply.redirect(await this.storage.readUrl(media.storage.videoKey), 302);
    }
    const path = media ? `${media.outDir}/${media.file}` : null;
    if (!path || !existsSync(path)) throw new NotFoundException("нет такого клипа");

    const size = statSync(path).size;
    const match = RANGE.exec(request.headers.range ?? "");

    reply.header("accept-ranges", "bytes");
    reply.header("content-type", "video/mp4");
    // Файл под этим адресом не меняется: имя клипа включает версию.
    reply.header("cache-control", "private, max-age=86400");

    if (!match) {
      reply.header("content-length", String(size));
      return reply.send(createReadStream(path));
    }

    const [, rawStart, rawEnd] = match as unknown as [string, string, string];
    let start: number;
    let end: number;
    if (rawStart) {
      start = Number(rawStart);
      end = rawEnd ? Number(rawEnd) : size - 1;
    } else {
      // bytes=-N - последние N байт.
      start = Math.max(0, size - Number(rawEnd || 0));
      end = size - 1;
    }
    end = Math.min(end, size - 1);

    if (start > end || start >= size) {
      reply.code(416).header("content-range", `bytes */${size}`);
      return reply.send();
    }

    reply
      .code(206)
      .header("content-length", String(end - start + 1))
      .header("content-range", `bytes ${start}-${end}/${size}`);
    return reply.send(createReadStream(path, { start, end }));
  }

  /**
   * Кадр из клипа для карточки в списке.
   *
   * Кадры кладутся в кэш: тянуть их ffmpeg-ом на каждую перерисовку
   * списка из тридцати клипов - это тридцать запусков процесса. Кадр
   * берётся на 2.5-й секунде: на первой клип ещё проявляется из
   * затемнения, и превью выходило чёрным.
   */
  @Get("poster/:id")
  async poster(
    @CurrentViewer() viewer: Viewer | null,
    @Param("id") id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const media = await this.catalog.clipMedia(viewer, id);
    if (media?.storage && this.storage) {
      reply.header("cache-control", "private, no-store");
      return reply.redirect(await this.storage.readUrl(media.storage.posterKey), 302);
    }
    const path = media ? `${media.outDir}/${media.file}` : null;
    if (!path || !existsSync(path)) throw new NotFoundException("нет такого клипа");

    const cacheDir = join(this.config.data, "cache", "posters");
    const key = createHash("sha1")
      .update(`${path}|${statSync(path).mtimeMs}`)
      .digest("hex")
      .slice(0, 16);
    const target = join(cacheDir, `${key}.jpg`);

    if (!existsSync(target)) {
      await mkdir(cacheDir, { recursive: true });
      await new Promise<void>((resolve) => {
        const child = spawn(
          "ffmpeg",
          ["-v", "error", "-y", "-ss", "2.5", "-i", path,
           "-frames:v", "1", "-vf", "scale=270:-2", target],
          { windowsHide: true },
        );
        child.on("close", () => resolve());
        child.on("error", () => resolve());
      });
    }

    if (!existsSync(target)) throw new NotFoundException("кадр не получен");
    reply.header("content-type", "image/jpeg");
    reply.header("cache-control", "private, max-age=86400");
    return reply.send(createReadStream(target));
  }
}
