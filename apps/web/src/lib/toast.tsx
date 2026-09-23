"use client";

/**
 * Уведомления поверх страницы.
 *
 * Единственный законный способ сказать что-то вне основного потока
 * вёрстки. Вставка текста в страницу («задача поставлена» под кнопкой)
 * сдвигала всё, что ниже, - от одного клика дёргалась вся страница.
 * Тост живёт в фиксированном слое и не двигает ничего.
 *
 * Использовать только для того, чего не видно по самой странице:
 * ошибок и редких подтверждений без визуального следа. Успех действия
 * должен показывать сам интерфейс - кнопка перешла в состояние «идёт»,
 * появилась строка в списке, сменилась плашка.
 */
import { useEffect, useState } from "react";

export interface ToastItem {
  id: number;
  message: string;
  kind: "info" | "error";
}

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
let listener: Listener | null = null;
let nextId = 1;

const push = (message: string, kind: ToastItem["kind"]): void => {
  const item = { id: nextId++, message, kind };
  items = [...items.slice(-2), item];
  listener?.(items);
  setTimeout(() => {
    items = items.filter((existing) => existing.id !== item.id);
    listener?.(items);
  }, 4500);
};

export const toast = {
  info: (message: string) => push(message, "info"),
  /** Ошибки режутся до вменяемой длины: простыня стека никому не нужна. */
  error: (message: string) => push(message.slice(0, 200), "error"),
};

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>([]);

  useEffect(() => {
    listener = setList;
    return () => {
      listener = null;
    };
  }, []);

  if (list.length === 0) return null;

  return (
    <div className="toaster" role="status">
      {list.map((item) => (
        <div key={item.id} className={`toast toast-${item.kind}`}>
          {item.message}
        </div>
      ))}
    </div>
  );
}
