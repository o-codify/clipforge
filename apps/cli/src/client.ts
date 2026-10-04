/** HTTP-only platform client. No database, server environment or Google tokens. */
export class PlatformClient {
  readonly origin:string;
  private cookie='';
  private ownsSession=false;

  constructor(baseUrl:string, session?:string) {
    const url=new URL(baseUrl);
    if(url.username||url.password||url.search||url.hash||url.pathname!=='/') throw new Error('CLIPFORGE_URL должен содержать только адрес платформы');
    const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if(url.protocol!=='https:'&&!(local&&url.protocol==='http:')) throw new Error('Для удалённой платформы необходим HTTPS');
    this.origin=url.origin;
    if(session) {
      if(!/^[A-Za-z0-9_-]+$/.test(session)) throw new Error('Неверный формат сессии');
      this.cookie=`clipforge_session=${session}`;
    }
  }

  private async response(path:string, method:string, body?:unknown) {
    if(!path.startsWith('/api/')||new URL(path,this.origin).origin!==this.origin) throw new Error('Допустим только API выбранной платформы');
    let response:Response;
    try {
      response=await fetch(new URL(path,this.origin),{
        method,redirect:'error',signal:AbortSignal.timeout(path.startsWith('/api/storage/')?300_000:30_000),
        headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),...(this.cookie?{Cookie:this.cookie}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
      });
    } catch {
      throw new Error(method==='GET'?'API недоступен или не ответил вовремя':'Ответ API не получен. Проверьте состояние операции перед повтором.');
    }
    if(!response.ok) {
      if(response.status===401) throw new Error('Требуется вход в ClipForge');
      if(response.status===403) throw new Error('Недостаточно прав или включён просмотр от имени пользователя');
      const data=await response.json().catch(()=>null) as {message?:unknown}|null;
      const message=typeof data?.message==='string'?data.message.slice(0,500):`HTTP ${response.status}`;
      throw new Error(message);
    }
    return response;
  }

  async login(login:string,password:string) {
    if(this.cookie) return;
    const response=await this.response('/api/auth/login','POST',{login,password});
    const cookie=response.headers.getSetCookie().find(value=>value.startsWith('clipforge_session='))?.split(';')[0];
    if(!cookie) throw new Error('API не выдал сессию');
    this.cookie=cookie;
    this.ownsSession=true;
  }

  async request<T=unknown>(path:string,method='GET',body?:unknown):Promise<T> {
    return (await this.response(path,method,body)).json() as Promise<T>;
  }

  async close() {
    if(!this.ownsSession) return;
    try {await this.request('/api/auth/logout','POST',{});}
    finally {this.cookie='';this.ownsSession=false;}
  }
}
