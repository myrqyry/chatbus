export type BadgeProvider = 'twitch' | 'kick' | 'youtube' | '7tv' | 'bttv' | 'ffz' | 'custom';
export type BadgeScope = 'native' | 'channel' | 'global' | 'user' | 'custom';

export interface IdentityFetchOptions {
  signal?: AbortSignal;
  bypassCache?: boolean;
  cacheTtlMs?: number;
}

export interface BadgeImage {
  url: string;
  width?: number;
  height?: number;
  format?: string;
  scale?: number;
}

export interface Badge {
  id: string;
  provider: BadgeProvider;
  scope: BadgeScope;
  version?: string;
  name?: string;
  title?: string;
  tooltip?: string;
  images: BadgeImage[];
  slot?: number;
  replaces?: string;
  color?: string;
  raw?: unknown;
}

export interface BadgeRef {
  id: string;
  provider: BadgeProvider;
  version?: string;
  info?: string;
}

export interface NamePaintStop {
  at: number;
  color: number;
  centerAt?: [number, number];
}

export interface NamePaintGradient {
  function?: string;
  canvasRepeat?: string;
  canvasSize?: [number, number];
  at?: [number, number];
  stops: NamePaintStop[];
  imageUrl?: string;
  shape?: string;
  angle?: number;
  repeat?: boolean;
}

export interface NamePaintShadow {
  xOffset: number;
  yOffset: number;
  radius: number;
  color: number;
}

export interface NamePaintText {
  weight?: number;
  variant?: string;
  transform?: string;
  stroke?: { width: number; color: number };
  shadows?: NamePaintShadow[];
}

export interface NamePaint {
  id: string;
  provider: '7tv' | 'custom';
  name?: string;
  color?: number;
  gradients?: NamePaintGradient[];
  shadows?: NamePaintShadow[];
  text?: NamePaintText;
  function?: string;
  repeat?: boolean;
  angle?: number;
  shape?: string;
  imageUrl?: string;
  stops?: NamePaintStop[];
  raw?: unknown;
}

export interface UserCosmetics {
  provider: '7tv' | 'custom';
  userId?: string;
  username?: string;
  displayName?: string;
  namePaint?: NamePaint;
  badges: Badge[];
}

export interface EnrichmentResult<T> {
  value: T | null;
  ok: boolean;
  error?: string;
}
