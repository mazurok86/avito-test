// Discriminator we trust as the messenger-message contract. Any frame matching
// this MUST conform to the schema enforced by `parseMessageFrame`; deviations
// are treated as a contract break and halt the watcher.
const MESSAGE_DISCRIMINATOR = 'Message';

export type ParsedFrame =
  | { kind: 'ignore' } // not a Message frame — silently drop
  | { kind: 'skip' } // is a Message, but not one we emit (echo/deleted/non-text/empty)
  | {
      kind: 'message';
      id: string;
      channelId: string;
      text: string;
      createdAtMs: number;
    }
  | { kind: 'contract-break'; reason: string };

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Parses a raw WS payload against the `type: "Message"` contract.
 *
 * Note the two different `type` fields: top-level `raw.type` is the frame
 * discriminator; nested `value.type` is the message subtype (text/system/image).
 *
 * Three outcomes worth distinguishing:
 *  - `ignore`: payload is not a Message frame at all (ping, other top-level
 *    type, non-JSON). Silently dropped.
 *  - `skip`: it IS a Message frame, but not one we relay (deleted, non-text
 *    subtype, echoed-back-to-us, empty body). Not a contract break.
 *  - `contract-break`: discriminator matched, but the required schema doesn't
 *    hold. Caller MUST halt — silently dropping these would mask Avito's
 *    backend changes and let messages quietly disappear.
 *
 * Required schema once `raw.type === 'Message'`:
 *   value.id: non-empty string
 *   value.channelId: non-empty string
 *   at least one of: value.initBackendActionTimestamp | value.initActionTimestamp
 *     | value.created (all numeric)
 *   if value.type === 'text' (or absent → treated as text):
 *     value.body: object with `text: string`
 *
 * Extra fields are tolerated — we don't use `.strict()`-style validation
 * because Avito routinely adds metadata fields without breaking the contract.
 */
export function parseMessageFrame(payload: string): ParsedFrame {
  if (!payload || payload[0] !== '{') return { kind: 'ignore' };

  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return { kind: 'ignore' };
  }
  if (!isObject(raw)) return { kind: 'ignore' };
  if (raw.type !== MESSAGE_DISCRIMINATOR) return { kind: 'ignore' };

  // Past this point, the frame claims to be a Message. Schema MUST hold.
  const value = raw.value;
  if (!isObject(value)) {
    return { kind: 'contract-break', reason: '`value` is missing or not an object' };
  }

  if (typeof value.id !== 'string' || !value.id) {
    return { kind: 'contract-break', reason: '`value.id` is missing or not a non-empty string' };
  }
  if (typeof value.channelId !== 'string' || !value.channelId) {
    return {
      kind: 'contract-break',
      reason: '`value.channelId` is missing or not a non-empty string',
    };
  }

  const tsBackend = value.initBackendActionTimestamp;
  const tsAction = value.initActionTimestamp;
  const tsCreated = value.created;
  const hasTimestamp =
    typeof tsBackend === 'number' ||
    typeof tsAction === 'number' ||
    typeof tsCreated === 'number';
  if (!hasTimestamp) {
    return {
      kind: 'contract-break',
      reason:
        'no timestamp field present (expected one of initBackendActionTimestamp/initActionTimestamp/created)',
    };
  }

  if (value.isDeleted === true) return { kind: 'skip' };

  // type: absent → treat as 'text' (legacy frames); present → must be a string.
  if (value.type !== undefined && typeof value.type !== 'string') {
    return { kind: 'contract-break', reason: '`value.type` is present but not a string' };
  }
  if (typeof value.type === 'string' && value.type !== 'text') {
    return { kind: 'skip' }; // system/image/etc. — not relayed
  }

  if (!isObject(value.body)) {
    return {
      kind: 'contract-break',
      reason: '`value.body` is missing or not an object on a text message',
    };
  }
  if (typeof value.body.text !== 'string') {
    return {
      kind: 'contract-break',
      reason: '`value.body.text` is missing or not a string on a text message',
    };
  }
  if (!value.body.text) return { kind: 'skip' };

  // uid/fromUid are optional in shape but, when present, must be strings.
  if (value.uid !== undefined && typeof value.uid !== 'string') {
    return { kind: 'contract-break', reason: '`value.uid` is present but not a string' };
  }
  if (value.fromUid !== undefined && typeof value.fromUid !== 'string') {
    return { kind: 'contract-break', reason: '`value.fromUid` is present but not a string' };
  }
  // `uid` is our recipient uid; `fromUid` is the sender. They're equal only
  // when we sent the message ourselves and Avito echoed it back.
  if (value.uid && value.fromUid && value.uid === value.fromUid) {
    return { kind: 'skip' };
  }

  const createdAtMs =
    typeof tsBackend === 'number'
      ? tsBackend
      : typeof tsAction === 'number'
        ? tsAction
        : Math.floor((tsCreated as number) / 10000); // 100-ns ticks → ms

  return {
    kind: 'message',
    id: value.id,
    channelId: value.channelId,
    text: value.body.text,
    createdAtMs,
  };
}
