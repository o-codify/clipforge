import type {vods,runs,clips,transcripts,vodAudioSettings,vodAdSettings} from '@clipforge/db';
export type VodData=typeof vods.$inferSelect;
export type RunData=typeof runs.$inferSelect;
export type ClipData=typeof clips.$inferSelect;
export type TranscriptData=typeof transcripts.$inferSelect;
export type RenderSnapshot={
  resuming:RunData|null;audioSettings:Awaited<ReturnType<typeof vodAudioSettings>>;
  adsSettings:Awaited<ReturnType<typeof vodAdSettings>>;developmentMode:boolean;
  previousClips:{id:string}[];covered:{start:number|null;end:number|null}[];channelName:string;
};
