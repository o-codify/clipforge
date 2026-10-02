type Chapter={title:string;start:number;end:number};
export const gameSlug=(title:string)=>title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'_').replace(/^_|_$/g,'');
export function gameWindows(chapters:Chapter[],game:string) {
  return chapters.filter(c=>gameSlug(c.title)===gameSlug(game)&&Number.isFinite(c.start)&&Number.isFinite(c.end)&&c.start>=0&&c.end>c.start);
}
export function insideGame(chapters:Chapter[],game:string,start:number,end:number) {
  return gameWindows(chapters,game).some(c=>start>=c.start&&end<=c.end);
}
