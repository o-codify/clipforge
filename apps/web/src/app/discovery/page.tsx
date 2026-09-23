"use client";

/**
 * Поиск стримеров на Twitch.
 *
 * То, ради чего площадка может работать сама: перебрать каталог по игре
 * и языку, оценить кандидатов и подключить тех, кто подходит. Оценка -
 * формула по зрителям, фолловерам и просмотрам архивов; пока не набрана
 * статистика публикаций, обучать модель не на чем.
 */
import { useEffect, useState } from "react";

import { Select, SearchSelect } from "@/components/Select";
import { Button, Card, JobButton, Pill } from "@/components/ui";
import { api, type Candidate } from "@/lib/api";
import { toast } from "@/lib/toast";

interface Status {
  available: boolean;
  note: string;
}

interface TopGame {
  id: string;
  name: string;
  boxArt: string;
  known: boolean;
}

export default function DiscoveryPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [topGames, setTopGames] = useState<TopGame[]>([]);
  const [game, setGame] = useState("Dota 2");
  const [language, setLanguage] = useState("ru");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<Status>("/api/discovery/status").then((value) => {
      setStatus(value);
      if (value.available) {
        void api.get<TopGame[]>("/api/discovery/games?limit=30").then(setTopGames);
      }
    });
  }, []);

  const scan = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ found: number; candidates: Candidate[] }>(
        "/api/discovery/scan",
        { game, language, limit: 12 },
      );
      // Успех виден по появившейся таблице - отдельная надпись не нужна.
      setCandidates(result.candidates);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const ignore = async (login: string) => {
    await api.post(`/api/discovery/ignore/${login}`);
    setCandidates((list) => list.filter((c) => c.login !== login));
  };

  if (status && !status.available) {
    return (
      <>
        <h1>Поиск стримеров</h1>
        <Card className="empty">
          {status.note}
          <br />
          <br />
          Регистрация приложения на dev.twitch.tv бесплатная. Тип клиента —
          Confidential, иначе секрет не выдаётся.
        </Card>
      </>
    );
  }

  return (
    <>
      <h1>Поиск стримеров</h1>
      <p className="sub">
        Перебор каталога Twitch по игре и языку. Оценка — по зрителям,
        фолловерам и просмотрам архивов.
      </p>

      <div className="actions">
        <SearchSelect label="Игра или категория" value={game} onValueChange={setGame} options={topGames.map(g=>({value:g.name,label:g.name}))}/>
        <Select label="Язык эфира" value={language} onValueChange={setLanguage} options={[{value:"ru",label:"Русский"},{value:"en",label:"Английский"}]}/>
        <Button variant="primary" icon="◎" busy={busy} onClick={scan}>
          Искать
        </Button>
        {candidates.length > 0 && (
          <span className="muted">Найдено {candidates.length}</span>
        )}
      </div>

      {candidates.length > 0 && (
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>Канал</th>
                <th className="num">Зрителей</th>
                <th className="num">Фолловеров</th>
                <th className="num">Архивов</th>
                <th className="num">Оценка</th>
                <th>Почему</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr key={candidate.login}>
                  <td>
                    <a
                      href={`https://twitch.tv/${candidate.login}`}
                      target="_blank"
                      rel="noopener"
                    >
                      {candidate.displayName}
                    </a>
                  </td>
                  <td className="num">{candidate.viewers.toLocaleString("ru-RU")}</td>
                  <td className="num">{candidate.followers.toLocaleString("ru-RU")}</td>
                  <td className="num">{candidate.archives}</td>
                  <td className="num">
                    <span
                      className={`pill${candidate.score > 0.8 ? " ok" : candidate.score === 0 ? " bad" : ""}`}
                    >
                      {candidate.score.toFixed(3)}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: "var(--dim)" }}>{candidate.reason}</td>
                  <td>
                    {candidate.connected ? (
                      <Pill tone="ok">Подключён</Pill>
                    ) : (
                      <div style={{ display: "flex", gap: 6 }}>
                        {/* Подключение - обход архивов: кнопка сама
                            показывает очередь и ход, а после завершения
                            живое обновление сменит её на «подключён». */}
                        <JobButton
                          size="sm"
                          variant="primary"
                          target={candidate.login}
                          kinds={["index-channel"]}
                          disabled={candidate.score === 0}
                          onRun={() =>
                            api.post("/api/jobs/index-channel", {
                              login: candidate.login, limit: 20, withChapters: true,
                            })
                          }
                        >
                          Подключить
                        </JobButton>
                        <Button size="sm" variant="ghost" onClick={() => ignore(candidate.login)}>
                          Мимо
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
