export type MediaSource = 'youtube' | 'vimeo' | 'twitch' | 'twitch_live' | 'direct' | 'upload';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  is_disabled: number;
  avatar_color: string;
  prefs: string;
  upload_quota_bytes: number | null;
  created_at: number;
  last_login_at: number | null;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  avatarColor: string;
  prefs: Record<string, unknown>;
  createdAt: number;
}

export interface RoomRow {
  id: string;
  name: string;
  topic: string | null;
  owner_id: string | null;
  invite_token: string;
  is_public: number;
  control_mode: 'everyone' | 'hosts';
  queue_mode: 'everyone' | 'hosts';
  wait_for_buffer: number;
  created_at: number;
  updated_at: number;
  current_item_id: string | null;
  position: number;
  is_playing: number;
  rate: number;
  state_at: number;
  repeat_mode: 'off' | 'one' | 'all';
  shuffle: number;
}

export interface QueueItemRow {
  id: string;
  room_id: string;
  sort: number;
  source: MediaSource;
  source_id: string;
  url: string | null;
  title: string;
  author: string | null;
  duration: number | null;
  thumbnail: string | null;
  added_by: string | null;
  added_at: number;
  played_at: number | null;
}

export interface MediaItem {
  source: MediaSource;
  sourceId: string;
  url?: string | null;
  title: string;
  author?: string | null;
  duration?: number | null;
  thumbnail?: string | null;
}

export type RoomRole = 'owner' | 'host' | 'member';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}
