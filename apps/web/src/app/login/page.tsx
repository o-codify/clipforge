"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { PublicPage } from "@/components/PublicPage";

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
    <PublicPage current="/login"><div className="login">
      <section className="login-identity" aria-label="ClipForge"><span>CLIPFORGE / ИЗ ЭФИРА В КЛИП</span><h1>Момент<br/><em>остаётся.</em></h1><p>Стримеры, игры и короткие истории.</p></section>
      <form onSubmit={submit}>
        <h2>Вход</h2>
        <label>Логин<input
          className="field" placeholder="Ваш логин" aria-label="Логин" value={login} autoFocus required maxLength={64} autoComplete="username"
          onChange={(e) => setLogin(e.target.value)}
        /></label>
        <label>Пароль<input
          className="field" type="password" aria-label="Пароль" value={password} required maxLength={200} autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        /></label>
        {error && <div className="error">{error}</div>}
        <Button variant="primary" busy={busy}>
          Войти
        </Button>
      </form>
    </div></PublicPage>
  );
}
