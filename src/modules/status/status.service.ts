import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import type {
  AuthCodeRequest,
  AuthCredentialsRequest,
  StatusChange,
} from '../avito/avito.types';

export interface StatusSnapshot {
  status: StatusChange;
  awaitingCode: AuthCodeRequest | null;
  awaitingCredentials: AuthCredentialsRequest | null;
}

/**
 * Single source of truth for the watcher/auth lifecycle as observed from the
 * outside. Subscribes to domain events and aggregates them into a snapshot.
 *
 * Consumers (StatusController, MessagesGateway) read the snapshot instead of
 * asking individual services — this keeps replay logic, polling endpoints and
 * gateway broadcasts in sync from one place.
 */
@Injectable()
export class StatusService {
  // Initial snapshot: nothing has started yet. Clients that connect before
  // the auth flow kicks off get a meaningful state instead of null.
  private status: StatusChange = { state: 'idle', at: new Date().toISOString() };
  private awaitingCode: AuthCodeRequest | null = null;
  private awaitingCredentials: AuthCredentialsRequest | null = null;

  @OnEvent('status.change')
  onStatusChange(payload: StatusChange): void {
    this.status = payload;
    // Any state transition out of awaiting_code/awaiting_credentials
    // invalidates the corresponding pending prompt (login succeeded, errored,
    // or restarted). Keep the snapshot consistent so reconnecting clients
    // don't get a stale "please enter code/credentials" panel.
    if (payload.state !== 'awaiting_code') {
      this.awaitingCode = null;
    }
    if (payload.state !== 'awaiting_credentials') {
      this.awaitingCredentials = null;
    }
  }

  @OnEvent('auth.needs_code')
  onAuthNeedsCode(payload: AuthCodeRequest): void {
    this.awaitingCode = payload;
  }

  @OnEvent('auth.code_accepted')
  onAuthCodeAccepted(): void {
    this.awaitingCode = null;
  }

  @OnEvent('auth.needs_credentials')
  onAuthNeedsCredentials(payload: AuthCredentialsRequest): void {
    this.awaitingCredentials = payload;
  }

  getSnapshot(): StatusSnapshot {
    return {
      status: this.status,
      awaitingCode: this.awaitingCode,
      awaitingCredentials: this.awaitingCredentials,
    };
  }
}
