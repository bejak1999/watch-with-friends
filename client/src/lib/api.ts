export class ApiError extends Error {
  status: number;
  /** Seconds to wait before retrying, sent with 429 responses. */
  retryAfter?: number;
  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new ApiError(
      data?.error || `Request failed (${res.status})`,
      res.status,
      typeof data?.retryAfter === 'number' ? data.retryAfter : undefined
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),

  async upload<T>(path: string, file: File, onProgress?: (pct: number) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const form = new FormData();
      form.append('file', file);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api${path}`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let data: any = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
        else reject(new ApiError(data?.error || `Upload failed (${xhr.status})`, xhr.status));
      };
      xhr.onerror = () => reject(new ApiError('Upload failed - connection lost', 0));
      xhr.send(form);
    });
  },
};

/* ---------------------------------------------------------------- */
/* Shared types                                                      */
/* ---------------------------------------------------------------- */

export type MediaSourceKind =
  | 'youtube'
  | 'vimeo'
  | 'twitch'
  | 'twitch_live'
  | 'ard'
  | 'zdf'
  | 'arte'
  | 'srg'
  | 'dailymotion'
  | 'peertube'
  | 'archive'
  | 'mediathek'
  | 'direct'
  | 'upload';

export interface MediaItem {
  source: MediaSourceKind;
  sourceId: string;
  url?: string | null;
  title: string;
  author?: string | null;
  duration?: number | null;
  thumbnail?: string | null;
}

export interface QueueItem extends MediaItem {
  id: string;
  addedBy: string | null;
  addedByName: string | null;
  addedAt: number;
  playedAt: number | null;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  avatarColor: string;
  avatarUrl: string | null;
  prefs: Record<string, unknown>;
  createdAt: number;
}

export interface PlaybackState {
  currentItemId: string | null;
  isPlaying: boolean;
  position: number;
  rate: number;
  stateAt: number;
  repeatMode: 'off' | 'one' | 'all';
  shuffle: boolean;
  serverNow?: number;
}

export interface RoomSnapshot {
  id: string;
  name: string;
  topic: string | null;
  ownerId: string | null;
  ownerName: string | null;
  inviteToken: string;
  isPublic: boolean;
  controlMode: 'everyone' | 'hosts';
  queueMode: 'everyone' | 'hosts';
  waitForBuffer: boolean;
  createdAt: number;
  myRole: 'owner' | 'host' | 'member' | null;
  permissions: { canControl: boolean; canQueue: boolean; canManage: boolean };
  playback: PlaybackState;
}

export interface RoomSummary {
  id: string;
  name: string;
  topic: string | null;
  ownerId: string | null;
  ownerName: string | null;
  isPublic: boolean;
  createdAt: number;
  updatedAt: number;
  memberCount: number;
  onlineCount: number;
  queueCount: number;
  nowPlaying: string | null;
  thumbnail: string | null;
  myRole: 'owner' | 'host' | 'member' | null;
}

export interface Member {
  userId: string;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
  role: 'owner' | 'host' | 'member';
  banned: boolean;
  online: boolean;
  buffering: boolean;
  position: number | null;
}

export interface ChatMessage {
  id: string;
  userId: string | null;
  kind: string;
  body: string;
  createdAt: number;
  displayName: string | null;
  avatarColor: string | null;
  avatarUrl: string | null;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  description: string | null;
  isShared: boolean;
  ownerId: string | null;
  ownerName: string | null;
  itemCount: number;
  cover: string | null;
  createdAt: number;
  updatedAt: number;
  mine: boolean;
}

export interface StorageStats {
  globalUsed: number;
  globalLimit: number;
  userUsed: number;
  userLimit: number;
  maxFileSize: number;
  enabled: boolean;
}
