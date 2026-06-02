export type SyncMessage =
  | { type: 'video:open';         url: string; sharerName: string; senderUuid: string; sessionId: string }
  | { type: 'video:stop';         senderUuid: string }
  | { type: 'video:request-sync'; senderUuid: string }
  | { type: 'video:sync-state';   time: number; playing: boolean; senderUuid: string }
  | { type: 'video:heartbeat';    url: string; sharerName: string; time: number; playing: boolean; senderUuid: string; sessionId: string };
