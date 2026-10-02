/** Domain operations for one assigned media task. Never SQL or storage credentials. */
export interface RemoteMediaAccess {
  call<T=unknown>(operation:string,input?:unknown):Promise<T>;
  uploadClip(id:string,file:string):Promise<{videoKey:string;posterKey:string}>;
  downloadClip(id:string,file:string):Promise<void>;
  restoreSources?(root:string,select:(name:string)=>boolean):Promise<void>;
}
