export type AuthState =
  | 'idle'
  | 'starting'
  | 'logging_in'
  | 'awaiting_code'
  | 'authorized'
  | 'error';

export interface StatusChange {
  state: AuthState;
  detail?: string;
  at: string;
}

export interface AvitoMessage {
  id: string;
  chatId: string;
  authorName: string;
  text: string;
  createdAt: string;
  receivedAt: string;
}

export interface AuthCodeRequest {
  reason: string;
  at: string;
}
