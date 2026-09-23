/**
 * Автоматический расчёт вертикальной сетки и сборка графа фильтров.
 *
 * Координаты панелей нигде не вписаны руками: у каждого стримера своя
 * раскладка, и она меняется от эфира к эфиру. Поэтому:
 *
 *   вебка   - из детектора лиц (python-воркер, операция facecam);
 *   игра    - кадрирование под фиксированный блок с сохранением пропорций;
 *   высоты  - доли холста, а не пиксели.
 *
 * Пропорции панели камеры НЕ навязываются. Вебки бывают и 16:9, и почти
 * квадратные; притягивание к общему формату либо растянет лицо, либо
 * обрежет его. Камере даётся доля высоты холста, ширина получается из её
 * собственных пропорций, по бокам остаётся размытый фон.
 */

export const OUT_WIDTH = 1080;
export const OUT_HEIGHT = 1920;

/** Основная палитра Twitch в записи для ffmpeg. */
export const TWITCH_BLACK = "0x000000";
export const PURPLE = "0x9146FF";

const BORDER = 5;
const ACCENT_W = 120;
const ACCENT_H = 5;

/** Доли холста. Меняются здесь, а не по всему коду. */
const TOP_MARGIN = 0.055; // воздух сверху + строка плашки источника
const CAM_HEIGHT = 0.3; // высота панели камеры
const GAP = 0.012; // зазор между панелями
const SUBTITLE_ZONE = 0.21; // низ под ленту субтитров (три строки)

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const aspect = (r: Rect): number => (r.h ? r.w / r.h : 1);
export const asCrop = (r: Rect): string => `crop=${r.w}:${r.h}:${r.x}:${r.y}`;

/** Готовая панель: что вырезать из исходника и куда положить на холст. */
export interface Panel {
  crop: Rect;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Grid {
  name: string;
  game: Panel;
  cam: Panel | null;
  minimap?: Panel | null;
  /** Верх зоны субтитров: лента растёт вниз отсюда. */
  subTop: number;
  /** Где лежит акцентная полоса под шапкой. */
  accentY: number;
  /** blur - размытый кадр, black - сплошной Black Ops. */
  background: "blur" | "black";
  blur: number;
  darken: number;
}

/** Чётный размер - требование кодеков с yuv420p. */
const even = (value: number): number => Math.floor(value / 2) * 2;

export function describeGrid(grid: Grid): string {
  const parts = [`игра ${grid.game.w}x${grid.game.h} @y${grid.game.y}`];
  parts.push(
    grid.cam
      ? `камера ${grid.cam.w}x${grid.cam.h} @y${grid.cam.y}`
      : "камеры нет",
  );
  return parts.join(", ");
}

export interface GridOptions {
  background?: "blur" | "black";
  blur?: number;
  darken?: number;
  name?: string;
  minimapRect?: Rect | null;
}

export function computeGrid(
  sourceW: number,
  sourceH: number,
  camRect: Rect | null,
  options: GridOptions = {},
): Grid {
  const top = Math.trunc(OUT_HEIGHT * TOP_MARGIN);
  const gap = Math.trunc(OUT_HEIGHT * GAP);
  const subs = Math.trunc(OUT_HEIGHT * SUBTITLE_ZONE);

  let camPanel: Panel | null = null;
  const usedTop = top + even(OUT_HEIGHT * CAM_HEIGHT) + gap;

  if (camRect && camRect.w > 0 && camRect.h > 0) {
    let camH = even(OUT_HEIGHT * CAM_HEIGHT);
    let camW = even(camH * aspect(camRect));

    // Слишком широкую камеру ограничиваем шириной холста, пересчитывая
    // высоту, чтобы не искажать лицо.
    if (camW > OUT_WIDTH) {
      camW = OUT_WIDTH;
      camH = even(camW / aspect(camRect));
    }

    camPanel = {
      crop: camRect,
      x: Math.trunc((OUT_WIDTH - camW) / 2),
      y: top,
      w: camW,
      h: camH,
    };
  }

  // Camera visibility must not change the game panel's scale or aspect ratio.
  const gameH = even(OUT_HEIGHT - top - even(OUT_HEIGHT * CAM_HEIGHT) - gap - subs);
  const gameW = OUT_WIDTH;

  // Fill the existing block without bars or stretching. Keep the original
  // camera-aware horizontal framing; panel placement never depends on camera.
  const targetAspect = gameW / gameH;
  const cropW = even(Math.min(sourceW, sourceH * targetAspect));
  const cropH = even(Math.min(sourceH, sourceW / targetAspect));
  let cropX = Math.trunc((sourceW-cropW)/2);
  if (camRect && camRect.w > 0 && camRect.h > 0) {
    const right = camRect.x+camRect.w;
    if (cropX < right && camRect.x < cropX+cropW) {
      cropX = camRect.x+camRect.w/2 < sourceW/2
        ? Math.min(right,sourceW-cropW) : Math.max(0,camRect.x-cropW);
    }
  }
  const gamePanel: Panel = {
    crop: { x: cropX, y: Math.trunc((sourceH-cropH)/2), w: cropW, h: cropH },
    x: 0,
    y: usedTop,
    w: gameW,
    h: gameH,
  };

  let minimap: Panel | null = null;
  const map = options.minimapRect;
  if (map && map.w > 0 && map.h > 0) {
    const mapW = even(Math.min(488, OUT_WIDTH-80-gap-(camPanel?.w ?? 488)));
    const mapH = even(mapW/aspect(map));
    // Never shrink or widen the face just to accommodate an optional map.
    if (mapW >= 160 && mapH <= even(OUT_HEIGHT*CAM_HEIGHT)) {
      const rowW = (camPanel?.w ?? 488)+gap+mapW;
      const left = Math.trunc((OUT_WIDTH-rowW)/2);
      if (camPanel) camPanel.x = left;
      minimap = {crop:map,x:left+(camPanel?.w ?? 488)+gap,
        y:top+even((OUT_HEIGHT*CAM_HEIGHT-mapH)/2),w:mapW,h:mapH};
    }
  }

  return {
    name: options.name ?? "auto",
    game: gamePanel,
    cam: camPanel,
    minimap,
    subTop: usedTop + gameH + gap,
    // Полоса идёт посередине между шапкой и первой панелью.
    accentY: Math.max(0, top - Math.trunc(gap / 2)),
    background: options.background ?? "blur",
    blur: options.blur ?? 22,
    darken: options.darken ?? 0.22,
  };
}

// --- граф фильтров ----------------------------------------------------

export interface Overlay {
  /** Номер входа ffmpeg: логотип подаётся отдельным -i. */
  input: number;
  x: number;
  y: number;
  w: number;
  from?: number;
  to?: number;
  fade?: number;
}

export interface Scrim {
  from: number;
  fade: number;
  opacity: number;
}

export interface FilterOptions {
  subtitlesPath?: string;
  overlays?: Overlay[];
  scrim?: Scrim;
  duration?: number;
  fps?: number;
}

export function buildFilter(grid: Grid, options: FilterOptions = {}): string {
  const { subtitlesPath, overlays = [], scrim } = options;
  const duration = options.duration ?? 0;
  const fps = options.fps ?? 30;

  const blurred = grid.background !== "black";

  // При размытом фоне нужна ещё одна копия кадра, при сплошном - нет.
  const streams = (blurred ? 1 : 0) + 1 + (grid.cam ? 1 : 0) + (grid.minimap ? 1 : 0);
  const parts: string[] = [
    `[0:v]split=${streams}` +
      Array.from({ length: streams }, (_, i) => `[s${i}]`).join(""),
  ];
  let next = 0;

  if (blurred) {
    parts.push(
      `[s${next}]scale=${OUT_WIDTH}:${OUT_HEIGHT}:force_original_aspect_ratio=increase,` +
        `crop=${OUT_WIDTH}:${OUT_HEIGHT},gblur=sigma=${grid.blur},` +
        `eq=brightness=-${grid.darken.toFixed(2)}:saturation=0.55[bg]`,
    );
    next += 1;
  } else {
    parts.push(
      `color=c=${TWITCH_BLACK}:s=${OUT_WIDTH}x${OUT_HEIGHT}` +
        `:d=${Math.max(duration, 1).toFixed(3)}:r=${fps},format=rgba[bg]`,
    );
  }

  // Панели оформлены одинаково: фирменная рамка по контуру. Одинаковая
  // обводка связывает камеру и геймплей в один блок, а не два случайно
  // положенных рядом куска.
  const frame = `drawbox=x=0:y=0:w=iw:h=ih:color=${PURPLE}@0.95:t=${BORDER}`;

  const game = grid.game;
  parts.push(
    `[s${next}]${asCrop(game.crop)},scale=${game.w}:${game.h},${frame}[game]`,
  );
  next += 1;
  parts.push(`[bg][game]overlay=${game.x}:${game.y}[stage1]`);
  let last = "stage1";

  if (grid.cam) {
    const cam = grid.cam;
    parts.push(
      `[s${next}]${asCrop(cam.crop)},scale=${cam.w}:${cam.h},${frame}[cam]`,
    );
    parts.push(`[${last}][cam]overlay=${cam.x}:${cam.y}[stage2]`);
    last = "stage2";
    next += 1;
  }

  if (grid.minimap) {
    const map = grid.minimap;
    parts.push(`[s${next}]${asCrop(map.crop)},scale=${map.w}:${map.h},${frame}[minimap]`);
    parts.push(`[${last}][minimap]overlay=${map.x}:${map.y}[withmap]`);
    last = "withmap";
  }

  // Фирменная полоса под шапкой - тонкий акцент, который держит верхнюю
  // часть кадра и отделяет локап от панелей.
  parts.push(
    `[${last}]drawbox=x=${Math.trunc((OUT_WIDTH - ACCENT_W) / 2)}:y=${grid.accentY}` +
      `:w=${ACCENT_W}:h=${ACCENT_H}:color=${PURPLE}@0.9:t=fill[accent]`,
  );
  last = "accent";

  // Затемнение под карточку концовки. Отдельный слой с плавным
  // появлением, а не enable у drawbox: enable - жёсткое включение, и
  // подложка выскакивала скачком, пока текст рядом проявлялся плавно.
  //
  // Рисуется ffmpeg-ом, а не в ASS: субтитры вшиваются последним
  // фильтром, и подложка из ASS легла бы ПОВЕРХ логотипа, погасив его.
  if (scrim) {
    parts.push(
      `color=c=black:s=${OUT_WIDTH}x${OUT_HEIGHT}:d=${duration.toFixed(3)}:r=${fps},` +
        `format=rgba,` +
        `fade=t=in:st=${scrim.from.toFixed(3)}:d=${scrim.fade.toFixed(2)}:alpha=1,` +
        // Верхний предел непрозрачности ставится ПОСЛЕ fade, иначе
        // подложка ушла бы в полностью чёрный экран.
        `colorchannelmixer=aa=${scrim.opacity.toFixed(2)}[scrimsrc]`,
    );
    parts.push(`[${last}][scrimsrc]overlay=0:0[scrimmed]`);
    last = "scrimmed";
  }

  // Логотипы подаются отдельными входами ffmpeg - это оригинальные файлы
  // из брендбука. Пропорции сохраняются (-1 по высоте): растягивать
  // логотип гайдлайны запрещают.
  //
  // Появление и уход - через fade по альфа-каналу. Для этого картинка
  // подаётся зацикленной (-loop 1) и с ограниченной длительностью, иначе
  // у неё нет временной шкалы и fade применить не к чему.
  overlays.forEach((item, i) => {
    const tag = `ov${i}`;
    let chain = `[${item.input}:v]scale=${item.w}:-1,format=rgba`;
    const fade = item.fade ?? 0.4;
    if (item.from !== undefined) {
      chain += `,fade=t=in:st=${item.from.toFixed(3)}:d=${fade.toFixed(2)}:alpha=1`;
    }
    if (item.to !== undefined) {
      chain += `,fade=t=out:st=${(item.to - fade).toFixed(3)}:d=${fade.toFixed(2)}:alpha=1`;
    }
    parts.push(`${chain}[${tag}]`);
    parts.push(`[${last}][${tag}]overlay=${item.x}:${item.y}[st${i}]`);
    last = `st${i}`;
  });

  parts.push(
    subtitlesPath
      ? `[${last}]subtitles='${subtitlesPath}'[vout]`
      : `[${last}]null[vout]`,
  );

  return parts.join(";");
}
