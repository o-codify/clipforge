import {Body,Controller,Get,Inject,Post} from '@nestjs/common';
import {z} from 'zod';
import type {Database} from '@clipforge/db';
import {storageFromEnv} from '@clipforge/storage';
import {cacheManifest,pruneCloudMedia} from '@clipforge/worker/media-retention';
import {AdminOnly} from './auth/auth.guard.js';
import {DATABASE} from './config.js';

@Controller('api/storage')
@AdminOnly()
export class StorageController {
  constructor(@Inject(DATABASE) private readonly db:Database){}
  @Get('manifest') async manifest(){const storage=storageFromEnv();if(!storage)throw new Error('S3 не настроено');return cacheManifest(this.db,storage);}
  @Post('cleanup') async cleanup(@Body() raw:unknown){const {apply}=z.object({apply:z.boolean().default(false)}).strict().parse(raw);
    const storage=storageFromEnv();if(!storage)throw new Error('S3 не настроено');return pruneCloudMedia(this.db,storage,apply);}
}
