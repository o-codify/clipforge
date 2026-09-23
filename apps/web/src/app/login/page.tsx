"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/api/auth/login", { login, password });
      router.replace("/");
    } catch (problem) {
      setError(
        problem instanceof ApiError && problem.status === 401
          ? "Неверный логин или пароль"
          : String(problem),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>
          <img src="/glitch.svg" alt="" width={26} height={26} />
          ClipForge
        </h1>
        <input
          className="field" placeholder="Логин" value={login} autoFocus
          onChange={(e) => setLogin(e.target.value)}
        />
        <input
          className="field" type="password" placeholder="Пароль" value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="error">{error}</div>}
        <Button variant="primary" busy={busy}>
          Войти
        </Button>
        <div className="note">
          Вход для пользователей с аккаунтом ClipForge.
        </div>
        <nav aria-label="О сервисе" className="login-legal">
          <Link href="/about">О ClipForge</Link>
          <Link href="/privacy">Конфиденциальность</Link>
          <Link href="/terms">Условия</Link>
        </nav>
      </form>
    </div>
  );
}
