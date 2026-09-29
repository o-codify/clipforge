"""Prepare an offline A/B review page from local test artifacts."""
from pathlib import Path
import shutil
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'data/reviews/media-protection'
source=ROOT/'out/dota_2/sany_jeweler/v2859643784/20260923-205312-2e8f2a/001_reaction_2496.mp4'
shutil.copyfile(source,OUT/'sany-original.mp4')
html='''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClipForge · Проверка обработки</title>
<style>
:root{color-scheme:dark;font:16px/1.55 system-ui;background:#111015;color:#efedf5}
*{box-sizing:border-box}body{margin:0}header{padding:30px 5vw;border-bottom:1px solid #514060;background:#1b1425}
main{max-width:1300px;padding:30px;margin:auto}h1{font-size:clamp(26px,4vw,44px);margin:8px 0}h2{font-size:25px;margin:0 0 18px}h3{font-size:17px}
p{max-width:88ch;color:#c7bfce}small,.muted{color:#b2a7bf}.tag{font:12px monospace;letter-spacing:2px;color:#ba8eff}
section{margin:0 0 36px;padding:26px;border:1px solid #43344e;background:#1b1721}
label{display:block;margin:10px 0 5px}button,select,a.action{background:#2b2039;color:#fff;border:1px solid #775294;padding:10px 14px;border-radius:3px;font:inherit;cursor:pointer}
button:hover,select:hover{border-color:#c29aff}.active{background:#9146ff}a{color:#d3b5ff}video{width:100%;height:480px;background:#08070b;display:block}audio{width:100%}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.card{min-width:0}.callout{border-left:4px solid #9146ff;padding:12px 18px;background:#291e37}
nav{display:flex;gap:12px;flex-wrap:wrap;margin-top:18px}img{width:100%;display:block}.actions{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}
table{width:100%;border-collapse:collapse}td,th{padding:12px;text-align:left;border-bottom:1px solid #43344e}th{color:#c4a0f5}
@media(max-width:750px){.grid{grid-template-columns:1fr}main{padding:16px}section{padding:18px}video{height:420px}}
</style>
<header><div class="tag">CLIPFORGE / ЛОКАЛЬНАЯ ПРОВЕРКА</div><h1>Звук, реклама и ресурсы</h1>
<p class="callout">Текущий режим: только скрытие QR-кодов и рекламных баннеров. Исходный звук сохраняется; подавление музыки, паузы речи и фоновая музыка отключены. Сравнение аудиоэкспериментов сохранено ниже как архив.</p>
<nav><a href="#video">Готовый клип</a><a href="#audio">Сравнение звука</a><a href="#ads">Реклама</a><a href="#resources">Ресурсы</a><a href="#music">Музыка для фона</a></nav></header>
<main>
<section id="video"><h2>01 / Клип Sany_Jeweler · исходный звук</h2>
<p>Слева исходник. Справа версия после проверки рекламы с исходной аудиодорожкой. В этом клипе рекламные области не найдены. Старые аудиоэксперименты доступны в списке для сравнения; в обработке они отключены.</p>
<div class="grid"><div class="card"><h3>Исходник · 34 секунды</h3><video id="original" src="sany-original.mp4" controls preload="none"></video></div>
<div class="card"><label for="variant">Версия</label><select id="variant"><option value="sany-ads-hidden.mp4">Текущий режим — исходный звук</option><option value="sany-cleaned.mp4">Архив: DeepFilterNet + паузы речи</option><option value="sany-silent.mp4">Архив: звук полностью отключён</option></select><video id="cleaned" src="sany-ads-hidden.mp4" controls preload="none"></video></div></div>
<div class="actions"><button id="switch">Перейти к другой версии с этого места</button></div>
<p class="callout">Звук текущей версии побайтово совпадает с исходной аудиодорожкой. Подавление музыки и обнуление пауз отключены, чтобы сохранить звуки игры.</p></section>
<section id="audio"><h2>02 / Архив сравнения методов на одинаковых 20 секундах</h2>
<div class="grid"><div><label for="clip">Клип</label><select id="clip"><option value="sany">Sany_Jeweler · музыка из эфира</option><option value="recrent">Recrent · второй образец</option></select></div>
<div><label for="method">Вариант</label><select id="method"><option value="original">Исходник</option><option value="deepfilter">DeepFilterNet</option><option value="dtln">DTLN</option><option value="filter">Обычный фильтр + denoise</option><option value="deepfilter-gated">DeepFilterNet + паузы речи (Sany)</option><option value="dtln-gated">DTLN + паузы речи (Sany)</option><option value="mute">Отключённый звук</option></select></div></div>
<h3 id="audio-title">Sany_Jeweler · исходник</h3><audio id="audio-player" src="sany-original.wav" controls preload="none"></audio>
<p>Положение сохраняется при смене метода. Громкость файлов не выравнивалась: снижение общей громкости само по себе не доказывает удаление музыки.</p>
<table><thead><tr><th>Контрольная смесь</th><th>SI-SDR, дБ</th><th>Музыка в паузах</th></tr></thead><tbody>
<tr><td>Исходник</td><td>−0,06</td><td>Сохранена</td></tr>
<tr><td>DTLN</td><td>1,71</td><td>Примерно −3 дБ</td></tr>
<tr><td>DeepFilterNet</td><td>4,08</td><td>Примерно −3,25 дБ</td></tr>
<tr><td>DeepFilterNet + известные паузы речи</td><td>5,61</td><td>Обнулена в размеченных паузах</td></tr></tbody></table>
<p>Это искусственная смесь с известной речью и музыкой, а не оценка авторских прав. Чем выше SI-SDR, тем ближе результат к чистой речи в данном тесте. Повторное распознавание реальных клипов выявило потери/замены отдельных слов; экспертная оценка на слух не проводилась.</p>
</section>
<section id="ads"><h2>03 / QR-код и рекламный баннер</h2><p>Контролируемый тестовый кадр. Найденные области закрываются непрозрачно на протяжении всего клипа.</p>
<div class="grid"><div><h3>До обработки</h3><img src="ads-fixture-before.png" alt="Тестовый кадр с QR и рекламным баннером"></div><div><h3>После обработки</h3><img src="ads-fixture-after.png" alt="Те же области закрыты масками"></div></div>
<p>Проверены все 30 кадров выходного ролика на QR, два кадра — на текст баннера. Центральная область не закрыта. На реальном Sany-клипе детектор не нашёл таких вставок.</p>
<p class="callout">Короткие вспышки, неизвестные логотипы и реклама без текста могут остаться. В интерфейсе клипа есть ручное выделение областей; рекламные монологи и слишком крупные вставки отклоняются.</p>
</section>
<section id="resources"><h2>04 / Другие приложения в приоритете</h2>
<table><tbody><tr><th>Начало работы</th><td>120 секунд без ввода + 15 секунд стабильного запаса</td></tr>
<tr><th>CPU / RAM</th><td>Общий целевой потолок 90%; запас RAM не меньше 10% и 1,5 ГиБ</td></tr>
<tr><th>При активности</th><td>Пауза тяжёлых процессов; через минуту — освобождение их памяти. При нехватке RAM/VRAM — через 5 секунд</td></tr>
<tr><th>Сеть</th><td>До 10 Мбит/с вниз и 5 Мбит/с вверх, со снижением при занятой сети</td></tr>
<tr><th>GPU</th><td>Контроль нагрузки и свободной памяти; регулирование паузами, а не жёсткий мгновенный предел</td></tr>
<tr><th>Продолжение передач</th><td>S3 — с сохранённого смещения; YouTube — с подтверждённых байтов той же сессии</td></tr></tbody></table>
<p>Проверено на отдельном тестовом дереве Windows-процессов и подставных сетевых ответах. Рабочий воркер, публикации и производственная БД не использовались для этих тестов.</p></section>
<section id="music"><h2>05 / Фоновая музыка — отдельно</h2>
<p><a href="https://support.google.com/youtube/answer/3376882?hl=en" target="_blank" rel="noreferrer">YouTube Audio Library</a> — первый выбор для YouTube, с фильтром «Attribution not required». Для CC BY нужен указанный credit.</p>
<p><a href="https://streambeats.com/licensing/" target="_blank" rel="noreferrer">StreamBeats</a> — игровые видео и стримы с монетизацией; lofi, synthwave, electronic. По опубликованной лицензии credit не обязателен, отдельно распространять музыку нельзя.</p>
<p><a href="https://ncs.io/usage-policy" target="_blank" rel="noreferrer">NCS</a> — игровые ролики независимых авторов с обязательным credit, включая их спонсорский контент. Брендам и сервисам для продвижения собственных товаров/услуг нужно отдельно связаться с NCS. Не выбран для автоматического добавления.</p>
<p>Фоновая музыка в примеры не добавлена. Для каждой будущей композиции нужно сохранять источник, лицензию и требуемое указание автора.</p></section>
<small>26 сентября 2026 · Локальный результат · Сетевые ресурсы для проигрывания не нужны</small>
</main>
<script>
const original=document.querySelector('#original'),cleaned=document.querySelector('#cleaned'),audio=document.querySelector('#audio-player');
const players=[original,cleaned,audio];let active=original;
for(const p of players)p.addEventListener('play',()=>{players.forEach(other=>{if(other!==p)other.pause()});active=p});
function replace(p,src){const t=p.currentTime,playing=!p.paused;p.pause();p.src=src;p.addEventListener('loadedmetadata',()=>{p.currentTime=Math.min(t,p.duration||t);if(playing)p.play().catch(()=>{})},{once:true});p.load()}
document.querySelector('#variant').onchange=e=>replace(cleaned,e.target.value);
document.querySelector('#switch').onclick=()=>{const from=active===cleaned?cleaned:original,to=from===original?cleaned:original;const t=from.currentTime;from.pause();const go=()=>{to.currentTime=t;to.play().catch(()=>{})};if(to.readyState>=1)go();else{to.addEventListener('loadedmetadata',go,{once:true});to.load()}};
const clip=document.querySelector('#clip'),method=document.querySelector('#method');
function choose(){for(const option of method.options)option.disabled=clip.value!=='sany'&&option.value.endsWith('-gated');if(method.selectedOptions[0].disabled)method.value='deepfilter';replace(audio,clip.value+'-'+method.value+'.wav');document.querySelector('#audio-title').textContent=clip.selectedOptions[0].textContent+' · '+method.selectedOptions[0].textContent}
clip.onchange=choose;method.onchange=choose;
</script></html>'''
(OUT/'index.html').write_text(html,encoding='utf-8')
print(OUT/'index.html')
