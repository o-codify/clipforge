import {Controller,Get,Post,Body,Param,Headers,Res,Header} from '@nestjs/common';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import type {FastifyReply} from 'fastify';
import {Public} from './auth/auth.guard.js';
import {WorkerGatewayService} from './worker-gateway.service.js';

@Controller('api/worker-gateway')
@Public() // Every endpoint except the credential exchange/bootstrap validates its own worker bearer key.
export class WorkerGatewayController {
  constructor(private readonly gateway:WorkerGatewayService){}
  @Get('bootstrap') @Header('content-type','application/javascript') @Header('cache-control','no-store') bootstrap(){return this.gateway.bootstrap();}
  @Post('enroll') enroll(@Body() body:unknown){return this.gateway.enroll(body);}
  @Get('manifest') manifest(@Headers('authorization') auth?:string){return this.gateway.manifest(auth);}
  @Get('bundle') async bundle(@Headers('authorization') auth:string|undefined,@Res() reply:FastifyReply){const file=await this.gateway.bundle(auth);return reply.header('content-length',(await stat(file)).size).header('content-type','application/gzip').header('cache-control','no-store').send(createReadStream(file));}
  @Post('installation') installation(@Headers('authorization') auth:string|undefined,@Body() body:unknown){return this.gateway.installation(auth,body);}
  @Post('heartbeat') heartbeat(@Headers('authorization') auth:string|undefined,@Body() body:unknown){return this.gateway.heartbeat(auth,body);}
  @Post('next') next(@Headers('authorization') auth?:string){return this.gateway.next(auth);}
  @Post('tasks/:id/operation') operation(@Headers('authorization') auth:string|undefined,@Param('id') id:string,@Body() body:unknown){return this.gateway.operation(auth,id,body);}
  @Post('tasks/:id/progress') progress(@Headers('authorization') auth:string|undefined,@Param('id') id:string,@Body() body:unknown){return this.gateway.progress(auth,id,body);}
  @Post('tasks/:id/finish') finish(@Headers('authorization') auth:string|undefined,@Param('id') id:string,@Body() body:unknown){return this.gateway.finish(auth,id,body);}
  @Post('tasks/:id/uploads') upload(@Headers('authorization') auth:string|undefined,@Param('id') id:string,@Body() body:unknown){return this.gateway.beginUpload(auth,id,body);}
  @Post('tasks/:id/uploads/:upload/chunk') chunk(@Headers('authorization') auth:string|undefined,@Param('id') id:string,@Param('upload') upload:string,@Body() body:unknown){return this.gateway.chunk(auth,id,upload,body);}
  @Post('tasks/:id/uploads/:upload/commit') commit(@Headers('authorization') auth:string|undefined,@Param('id') id:string,@Param('upload') upload:string){return this.gateway.commitUpload(auth,id,upload);}
  @Get('tasks/:id/source/:clip') async source(@Headers('authorization') auth:string|undefined,@Param('id') id:string,@Param('clip') clip:string,@Res() reply:FastifyReply){const source=await this.gateway.source(auth,id,clip);return reply.header('content-type','video/mp4').header('content-length',source.size).send(source.body);}
}
