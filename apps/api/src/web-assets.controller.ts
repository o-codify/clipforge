import { Controller, Get, Inject, NotFoundException, Param, Res } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import type { FastifyReply } from 'fastify';
import { CONFIG, type ApiConfig } from './config.js';
import { Public } from './auth/auth.guard.js';

@Controller('api/web-assets')
export class WebAssetsController {
  constructor(@Inject(CONFIG) private readonly config: ApiConfig) {}

  @Public()
  @Get('*path')
  async asset(@Param('path') path: string, @Res() reply: FastifyReply): Promise<void> {
    const root=resolve(this.config.data,'web-assets');
    const file=await realpath(resolve(root,path)).catch(()=>null);
    const part=file && relative(root,file);
    if(!file || !part || part.startsWith('..') || isAbsolute(part)) throw new NotFoundException();
    const types: Record<string,string>={'.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
      '.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'};
    const type=types[extname(file)];
    if(!type) throw new NotFoundException();
    const info=await stat(file).catch(()=>null);
    if(!info?.isFile()) throw new NotFoundException();
    reply.header('content-type',type).header('content-length',info.size)
      .header('cache-control','public, max-age=31536000, immutable').header('x-content-type-options','nosniff');
    return reply.send(createReadStream(file));
  }
}
