import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import type { AuthCodeRequest, StatusChange } from '../avito/avito.types';

export interface StatusSnapshot {
  status: StatusChange | null;
  awaitingCode: AuthCodeRequest | null;
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
  private status: StatusChange | null = null;
  private awaitingCode: AuthCodeRequest | null = null;

  @OnEvent('status.change')
  onStatusChange(payload: StatusChange): void {
    this.status = payload;
    // Any state transition out of awaiting_code invalidates a pending 2FA prompt
    // (login succeeded, errored, or restarted). Keep the snapshot consistent.
    if (payload.state !== 'awaiting_code') {
      this.awaitingCode = null;
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

  getSnapshot(): StatusSnapshot {
    return {
      status: this.status,
      awaitingCode: this.awaitingCode,
    };
  }
}
