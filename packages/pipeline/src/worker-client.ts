/**
 * Клиент python-воркера.
 *
 * Держит один долгоживущий процесс и разговаривает с ним построчным
 * JSON. Задания идут по очереди: воркер однопоточный и работает с
 * видеокартой, поэтому параллельные запросы всё равно упёрлись бы в неё,
 * зато поделили бы память и замедлили оба.
 *
 * Процесс поднимается лениво - при первом задании. Это важно для
 * бэкенда: он стартует за миллисекунды и не ждёт, пока где-то там
 * загрузится CUDA.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

import {
  workerMessageSchema,
  type WorkerEvent,
  type WorkerOp,
  workerOps,
} from "@clipforge/contracts";

export interface WorkerClientOptions {
  /** Интерпретатор: python из venv, где стоят CUDA-библиотеки. */
  pythonBin: string;
  /** Каталог с пакетом clipforge_worker. */
  workerRoot: string;
  /** Рабочий каталог процесса: относительные пути считаются от него. */
  cwd: string;
  env?: Record<string, string>;
  /** Сколько ждать ответа. Расшифровка часового эфира идёт ~10 минут. */
  timeoutMs?: number;
  onEvent?: (event: WorkerEvent) => void;
  onStderr?: (line: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onEvent?: (event: WorkerEvent) => void;
}

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly type: string,
    readonly traceback?: string,
  ) {
    super(message);
    this.name = "WorkerError";
  }
}

export class PythonWorker {
  private child?: ChildProcessWithoutNullStreams;
  private reader?: Interface;
  private readonly pending = new Map<string, Pending>();
  /** Очередь: воркер обрабатывает задания по одному. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: WorkerClientOptions) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;

    const child = spawn(this.options.pythonBin, ["-m", "clipforge_worker"], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env,
        PYTHONPATH: this.options.workerRoot,
        // Без этого кириллица в логах воркера превращается в мусор:
        // консоль Windows по умолчанию не в UTF-8.
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
      },
      windowsHide: true,
    });

    this.child = child;
    this.reader = createInterface({ input: child.stdout });
    this.reader.on("line", (line) => this.onLine(line));

    createInterface({ input: child.stderr }).on("line", (line) => {
      this.options.onStderr?.(line);
    });

    child.on("exit", (code, signal) => {
      const reason = new Error(
        `воркер завершился: код ${code ?? "нет"}, сигнал ${signal ?? "нет"}`,
      );
      for (const [id, task] of this.pending) {
        clearTimeout(task.timer);
        task.reject(reason);
        this.pending.delete(id);
      }
      this.child = undefined;
    });

    return child;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Посторонний вывод в stdout ломал бы протокол молча, поэтому он
      // виден как предупреждение, а не проглатывается.
      this.options.onStderr?.(`не JSON в stdout: ${trimmed.slice(0, 200)}`);
      return;
    }

    const message = workerMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.options.onStderr?.(`неизвестное сообщение: ${trimmed.slice(0, 200)}`);
      return;
    }

    const data = message.data;
    if ("event" in data) {
      this.options.onEvent?.(data);
      this.pending.get(data.id)?.onEvent?.(data);
      return;
    }

    const task = this.pending.get(data.id);
    if (!task) return;
    clearTimeout(task.timer);
    this.pending.delete(data.id);

    if (data.ok) {
      task.resolve(data.result);
    } else {
      task.reject(
        new WorkerError(data.error.message, data.error.type, data.error.traceback),
      );
    }
  }

  /**
   * Выполнить операцию. Параметры и результат проверяются схемами из
   * contracts: расхождение формы между сторонами всплывает здесь, а не
   * через три шага в виде undefined.
   */
  async call<K extends WorkerOp>(
    op: K,
    params: unknown,
    hooks: { onEvent?: (event: WorkerEvent) => void } = {},
  ): Promise<ReturnType<(typeof workerOps)[K]["result"]["parse"]>> {
    const spec = workerOps[op];
    const parsedParams = spec.params.parse(params ?? {});

    const run = async () => {
      const child = this.start();
      const id = randomUUID();

      const timeoutMs = this.options.timeoutMs ?? 60 * 60 * 1000;
      const raw = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`воркер не ответил за ${timeoutMs} мс на ${op}`));
        }, timeoutMs);
        this.pending.set(id, {
          resolve,
          reject,
          timer,
          ...(hooks.onEvent ? { onEvent: hooks.onEvent } : {}),
        });
        child.stdin.write(`${JSON.stringify({ id, op, params: parsedParams })}\n`);
      });

      return spec.result.parse(raw);
    };

    // Задания выстраиваются в цепочку. Ошибка одного не должна рвать
    // очередь: следующий запускается независимо от исхода предыдущего.
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result as never;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.stdin.write("exit\n");
    child.stdin.end();
    const closed = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(timer);
    this.reader?.close();
    this.child = undefined;
  }
}
