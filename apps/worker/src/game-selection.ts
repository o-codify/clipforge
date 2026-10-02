type Chapter={title:string;start:number;end:number};
export const gameSlug=(title:string)=>title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'_').replace(/^_|_$/g,'');
export function gameWindows(chapters:Chapter[],game:string) {
  return chapters.filter(c=>gameSlug(c.title)===gameSlug(game)&&Number.isFinite(c.start)&&Number.isFinite(c.end)&&c.start>=0&&c.end>c.start);
}
export function insideGame(chapters:Chapter[],game:string,start:number,end:number) {
  return gameWindows(chapters,game).some(c=>start>=c.start&&end<=c.end);
}
export function selectedGameWindow(chapters:Chapter[],game:string,range?:{start:number;end:number}) {
  const chapter=range?gameWindows(chapters,game).find(c=>range.start>=c.start&&range.end<=c.end):gameWindows(chapters,game)[0];
  if(!chapter)throw new Error('Отрезок должен находиться внутри главы выбранной игры');
  const start=range?.start??chapter.start,end=range?.end??Math.min(chapter.end,start+5400);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end-start>5400)throw new Error('Неверный отрезок эфира');
  return {start,end,title:chapter.title};
}
