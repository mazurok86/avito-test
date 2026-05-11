import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import type { AuthCodeRequest, AvitoMessage, StatusChange } from '../avito/avito.types';
import { StatusService } from '../status/status.service';

@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class MessagesGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(MessagesGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(private readonly status: StatusService) {}

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
    const snapshot = this.status.getSnapshot();
    if (snapshot.status) client.emit('status:change', snapshot.status);
    if (snapshot.awaitingCode) client.emit('auth:needs_code', snapshot.awaitingCode);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @OnEvent('message.new')
  onMessage(message: AvitoMessage): void {
    this.server.emit('message:new', message);
  }

  @OnEvent('status.change')
  onStatusChange(payload: StatusChange): void {
    this.server.emit('status:change', payload);
  }

  @OnEvent('auth.needs_code')
  onAuthNeedsCode(payload: AuthCodeRequest): void {
    this.server.emit('auth:needs_code', payload);
  }

  @OnEvent('auth.code_accepted')
  onAuthCodeAccepted(): void {
    this.server.emit('auth:code_accepted', { at: new Date().toISOString() });
  }
}
