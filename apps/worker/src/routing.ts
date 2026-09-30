import { QUEUES, type QueueName } from '@clipforge/jobs';

export function servesQueue(role: 'control' | 'media' | 'all', queue: QueueName): boolean {
  if (role === 'all') return true;
  return role === 'media'
    ? queue.startsWith('heavy.') && queue !== QUEUES.prepareStreamer
    : queue === QUEUES.indexChannel || queue === QUEUES.publishClip || queue === QUEUES.refreshYoutube || queue===QUEUES.prepareStreamer || queue===QUEUES.publishBatchClip;
}
