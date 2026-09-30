import {QUEUES} from './index.js';

// Fixed single-assignment budgets. Selection is by capability, never by a
// worker-supplied queue list. Platform secrets stay on the control service.
export const WORKER_PROFILES = {
  catalog: {label:'Каталог',cpu:.25,memoryGb:.25,downloadKbps:1000,uploadKbps:500,
    queues:[QUEUES.indexChannel]},
  speech: {label:'Распознавание речи',cpu:2,memoryGb:6,downloadKbps:10000,uploadKbps:5000,
    queues:[QUEUES.transcribeVod]},
  render: {label:'Монтаж и анализ изображения',cpu:2,memoryGb:2,downloadKbps:10000,uploadKbps:5000,
    queues:[QUEUES.renderRun,QUEUES.renderVariant,QUEUES.analyzeVod,QUEUES.facecamVod,QUEUES.inspectAds,QUEUES.cleanClip,QUEUES.restoreAudio]},
  media: {label:'Полный конвейер',cpu:2,memoryGb:6,downloadKbps:10000,uploadKbps:5000,
    queues:Object.values(QUEUES).filter(q=>q.startsWith('heavy.')&&q!==QUEUES.prepareStreamer)},
} as const;
export type WorkerProfile=keyof typeof WORKER_PROFILES;
