import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CDPSession, Page } from 'puppeteer';

import { AppConfigService } from '../../config/config.service';
import { AvitoAuthService } from './auth.service';
import type { AvitoMessage, StatusChange } from './avito.types';
import { parseMessageFrame } from './message-frame.parser';

const MESSENGER_URL = 'https://www.avito.ru/profile/messenger';

type ScanResult =
  | { ok: true; matches: Array<{ id: string; name: string }> }
  | { ok: false; reason: string };

// Periodic health monitor cadence. Catches DOM-contract drift and WS stalls
// that the reactive paths (MutationObserver, CDP listener) would miss — for
// example, after a full-page navigation that detaches the observer.
const MONITOR_INTERVAL_MS = 30000;

// How long an inbound message addressed to an unknown channel stays buffered
// until refreshTargetChats picks the channel up. Must exceed the worst-case
// gap between channel-list scans (= MONITOR_INTERVAL_MS, when the reactive
// MutationObserver is detached). 2× provides margin for the actual refresh
// to finish and for any timer jitter.
const PENDING_MSG_TTL_MS = MONITOR_INTERVAL_MS * 2;

// Max time without any inbound WS frame (including Avito's keepalive pings)
// before we declare the socket dead. Avito's messenger pings well below this
// threshold during normal operation.
const WS_STALL_THRESHOLD_MS = 90000;

// Debounce window for the channels-list MutationObserver — collapses bursts
// of DOM mutations (typing indicators, read receipts, etc.) into one refresh.
const CHANNEL_LIST_DEBOUNCE_MS = 2000;
// Hard ceiling on debounce stretching. Under sustained churn the basic
// debounce never settles; this guarantees the refresh fires at least every
// CHANNEL_LIST_DEBOUNCE_MAX_MS regardless of how frequent the mutations are.
const CHANNEL_LIST_DEBOUNCE_MAX_MS = 10000;

// Single source of truth for Avito DOM selectors used by the watcher.
// If Avito changes their markup, update these — and only these — to fix it.
const CHANNELS_LIST_SELECTOR = '[data-marker="channels/list"]';
const CHANNEL_ITEM_SELECTOR = '[data-marker="channels/channel"]';
const CHANNEL_USER_TITLE_SELECTOR = '[data-marker="channels/user-title"]';
const CHANNEL_DATA_ID_ATTR = 'data-id';

@Injectable()
export class ChatWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatWatcherService.name);
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private readonly seenMessageIds = new Set<string>();
  private readonly targetChats = new Map<string, string>(); // channelId → partnerName
  private readonly pendingByChannel = new Map<string, { msgs: AvitoMessage[]; expiresAt: number }>();
  private startedAt = 0;
  private stopped = false;
  private lastFrameAt = 0;
  private lastRefreshAt = 0;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly auth: AvitoAuthService,
    private readonly events: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    this.config.validate();
    this.start().catch((err) => {
      this.logger.error(`Chat watcher failed to start: ${(err as Error).message}`);
      this.events.emit('status.change', {
        state: 'error',
        detail: (err as Error).message,
        at: new Date().toISOString(),
      } satisfies StatusChange);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    if (this.cdp) await this.cdp.detach().catch(() => undefined);
    if (this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => undefined);
    }
  }

  /**
   * Hard-stop the watcher on any unrecoverable inconsistency: DOM contract
   * break, WS frame contract break, WS stall, page closed. Surfaces the reason
   * to the operator and tears down resources. Restart the service after
   * investigating the logs.
   */
  private halt(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;

    const detail = `Avito watcher halted: ${reason}. Restart the service.`;
    this.logger.error(detail);
    this.events.emit('status.change', {
      state: 'error',
      detail,
      at: new Date().toISOString(),
    } satisfies StatusChange);

    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.pendingByChannel.clear();
    if (this.cdp) {
      void this.cdp.detach().catch(() => undefined);
      this.cdp = null;
    }
    if (this.page && !this.page.isClosed()) {
      void this.page.close().catch(() => undefined);
    }
  }

  private async start(): Promise<void> {
    this.startedAt = Date.now();
    this.page = await this.auth.ensureAuthorized();

    await this.attachWsInterceptor(this.page);
    await this.page.goto(MESSENGER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Root must be present immediately after DOMContentLoaded (server-rendered).
    const rootHandle = await this.page.$(CHANNELS_LIST_SELECTOR);
    if (!rootHandle) {
      this.halt(`channels-list root selector not found: ${CHANNELS_LIST_SELECTOR}`);
      return;
    }
    await rootHandle.dispose();

    // Initial scan + contract validation + populate targetChatIds.
    await this.refreshTargetChats(this.page);

    // Reactive updates from here on. `installChannelListObserver` self-guards
    // on `stopped` — no need to re-check here.
    await this.installChannelListObserver(this.page);

    // Periodic safety net for things the reactive paths can miss: page
    // navigations that detach the MutationObserver, silent WS disconnects, etc.
    this.monitorTimer = setInterval(() => {
      void this.runHealthCheck().catch(() => undefined);
    }, MONITOR_INTERVAL_MS);
  }

  /**
   * Avito's messenger uses wss://socket.avito.ru
   * We attach a CDP session to receive raw WebSocket frames.
   */
  private async attachWsInterceptor(page: Page): Promise<void> {
    this.cdp = await page.createCDPSession();
    await this.cdp.send('Network.enable');
    // Seed liveness timestamp so the WS-stall check has a sensible baseline
    // before the first frame arrives.
    this.lastFrameAt = Date.now();

    this.cdp.on('Network.webSocketFrameReceived', (params) => {
      // Bump BEFORE any filtering so keepalive/ping frames count as "alive".
      this.lastFrameAt = Date.now();
      const payload = (params as { response?: { payloadData?: string } }).response?.payloadData;
      if (!payload) return;
      this.handleWsFrame(payload);
    });

    this.logger.log('CDP WebSocket interceptor attached');
  }

  /**
   * Periodic safety check fired by the monitor timer. Catches failures the
   * reactive paths can't observe on their own: closed page, dead WS socket,
   * DOM contract drift after a navigation. Any failure routes through halt().
   */
  private async runHealthCheck(): Promise<void> {
    if (this.stopped) return;
    if (!this.page || this.page.isClosed()) {
      this.halt('page closed unexpectedly');
      return;
    }
    const sinceLastFrame = Date.now() - this.lastFrameAt;
    if (sinceLastFrame > WS_STALL_THRESHOLD_MS) {
      this.halt(`WS stalled: no frames received in ${Math.round(sinceLastFrame / 1000)}s`);
      return;
    }
    // Skip DOM probe if a refresh ran recently — observer-triggered scans
    // already cover this window, no point re-scanning.
    if (Date.now() - this.lastRefreshAt < MONITOR_INTERVAL_MS) return;
    // refreshTargetChats has its own contract check that calls halt() on
    // failure — re-using it as the DOM probe avoids duplicating that logic.
    await this.refreshTargetChats(this.page);
  }

  private handleWsFrame(payload: string): void {
    if (this.stopped) return;

    const result = parseMessageFrame(payload);
    switch (result.kind) {
      case 'ignore':
      case 'skip':
        return;
      case 'contract-break':
        this.halt(`WS frame contract break: ${result.reason}`);
        return;
      case 'message': {
        const message: AvitoMessage = {
          id: result.id,
          chatId: result.channelId,
          authorName: this.targetChats.get(result.channelId) ?? 'partner',
          text: result.text,
          createdAt: new Date(result.createdAtMs).toISOString(),
          receivedAt: new Date().toISOString(),
        };
        if (this.targetChats.has(message.chatId)) {
          this.emitMessage(message);
          return;
        }
        // Race: WS frame arrived before the chat list (DOM) updated. Hold the
        // message briefly — when refreshTargetChats() picks up the new channel,
        // we'll flush it.
        this.bufferPending(message);
        return;
      }
    }
  }

  private bufferPending(message: AvitoMessage): void {
    const now = Date.now();
    let entry = this.pendingByChannel.get(message.chatId);
    if (!entry || entry.expiresAt < now) {
      entry = { msgs: [], expiresAt: now + PENDING_MSG_TTL_MS };
      this.pendingByChannel.set(message.chatId, entry);
    }
    entry.msgs.push(message);

    // Opportunistic GC: prune any expired buckets.
    for (const [cid, e] of this.pendingByChannel) {
      if (e.expiresAt < now) this.pendingByChannel.delete(cid);
    }
  }

  private flushPending(channelId: string): void {
    const entry = this.pendingByChannel.get(channelId);
    if (!entry) return;
    this.pendingByChannel.delete(channelId);
    if (entry.expiresAt < Date.now()) return;
    this.logger.log(`Flushing ${entry.msgs.length} pending message(s) for channel ${channelId}`);
    for (const m of entry.msgs) this.emitMessage(m);
  }

  private emitMessage(message: AvitoMessage): void {
    if (this.seenMessageIds.has(message.id)) return;

    const createdMs = Date.parse(message.createdAt);
    if (Number.isFinite(createdMs) && createdMs < this.startedAt) {
      this.seenMessageIds.add(message.id);
      return;
    }

    this.seenMessageIds.add(message.id);
    if (this.seenMessageIds.size > 5000) {
      const arr = Array.from(this.seenMessageIds);
      this.seenMessageIds.clear();
      arr.slice(-2500).forEach((id) => this.seenMessageIds.add(id));
    }

    const preview = message.text.length > 80 ? `${message.text.slice(0, 80)}…` : message.text;
    this.logger.log(
      `New message in ${message.chatId} from ${message.authorName}: ${preview}`,
    );
    this.events.emit('message.new', message);
  }

  private async refreshTargetChats(page: Page): Promise<void> {
    if (this.stopped || page.isClosed()) return;
    const target = this.config.targetUserName.toLowerCase();
    if (!target) return;

    this.logger.log(
      `refreshTargetChats triggered (tracked=${this.targetChats.size}, target="${this.config.targetUserName}")`,
    );

    // Bump BEFORE the async work — the periodic monitor uses this timestamp
    // to decide whether to schedule its own scan.
    this.lastRefreshAt = Date.now();

    const result = await page
      .evaluate(
        (
          rootSelector: string,
          itemSelector: string,
          userTitleSelector: string,
          idAttr: string,
          needle: string,
        ): ScanResult => {
          const root = document.querySelector<HTMLElement>(rootSelector);
          if (!root) {
            return { ok: false, reason: `channels-list root selector not found: ${rootSelector}` };
          }

          const channels = root.querySelectorAll<HTMLElement>(itemSelector);
          let contractSatisfied = false;
          const matches: Array<{ id: string; name: string }> = [];

          for (const ch of channels) {
            const id = ch.getAttribute(idAttr);
            const nameEl = ch.querySelector<HTMLElement>(userTitleSelector);
            const name = (nameEl?.textContent ?? '').trim();

            if (id === null || id.length === 0 || name.length === 0) continue;

            contractSatisfied = true;
            if (name.toLowerCase().includes(needle)) {
              matches.push({ id, name });
            }
          }

          if (!contractSatisfied) {
            return {
              ok: false,
              reason: `no channel matches the expected contract (${itemSelector} + [${idAttr}] + ${userTitleSelector} with text)`,
            };
          }
          return { ok: true, matches };
        },
        CHANNELS_LIST_SELECTOR,
        CHANNEL_ITEM_SELECTOR,
        CHANNEL_USER_TITLE_SELECTOR,
        CHANNEL_DATA_ID_ATTR,
        target,
      )
      .catch((err): ScanResult => ({ ok: false, reason: `evaluate failed: ${(err as Error).message}` }));

    if (!result.ok) {
      this.halt(result.reason);
      return;
    }

    let added = 0;
    for (const m of result.matches) {
      if (!this.targetChats.has(m.id)) {
        this.targetChats.set(m.id, m.name);
        added += 1;
        this.logger.log(`Tracking chat with "${m.name}" (channelId=${m.id})`);
        this.flushPending(m.id);
      }
    }

    if (added > 0) {
      this.events.emit('status.change', {
        state: 'authorized',
        detail: `Tracking ${this.targetChats.size} chat(s) matching "${this.config.targetUserName}"`,
        at: new Date().toISOString(),
      } satisfies StatusChange);
    } else if (this.targetChats.size === 0) {
      this.events.emit('status.change', {
        state: 'authorized',
        detail: `No chat matching "${this.config.targetUserName}" yet`,
        at: new Date().toISOString(),
      } satisfies StatusChange);
    }
  }

  /**
   * Attaches a MutationObserver to the channels-list root for reactive
   * refresh of `targetChatIds`. The caller must have already validated that
   * the root exists; if the root later disappears, `refreshTargetChats` will
   * detect it via the same contract check and call `halt()`.
   */
  private async installChannelListObserver(page: Page): Promise<void> {
    if (this.stopped) return;

    await page.exposeFunction('__avitoChannelListChanged', () => {
      // Page-close in halt() is async — the MutationObserver in the browser
      // can still fire between halt() flipping `stopped` and the page actually
      // closing. Bail here to avoid an `evaluate` on a detaching page.
      if (this.stopped) return;
      void this.refreshTargetChats(page).catch(() => undefined);
    });

    await page.evaluate(
      (selector: string, debounceMs: number, maxWaitMs: number) => {
        const root = document.querySelector<HTMLElement>(selector);
        if (!root) return;

        let debounce: ReturnType<typeof setTimeout> | null = null;
        let firstPendingAt = 0;

        const fire = () => {
          if (debounce) {
            clearTimeout(debounce);
            debounce = null;
          }
          firstPendingAt = 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__avitoChannelListChanged?.();
        };

        const trigger = () => {
          const now = Date.now();
          // Force-fire applies to the *previously accumulated* mutations,
          // not the current one — if we've been stretching the debounce
          // window past the ceiling, flush now and let the current mutation
          // open a fresh window below.
          if (firstPendingAt !== 0 && now - firstPendingAt >= maxWaitMs) {
            fire();
          }
          if (firstPendingAt === 0) firstPendingAt = now;
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(fire, debounceMs);
        };

        new MutationObserver(trigger).observe(root, { childList: true, subtree: true });
      },
      CHANNELS_LIST_SELECTOR,
      CHANNEL_LIST_DEBOUNCE_MS,
      CHANNEL_LIST_DEBOUNCE_MAX_MS,
    );
  }
}
