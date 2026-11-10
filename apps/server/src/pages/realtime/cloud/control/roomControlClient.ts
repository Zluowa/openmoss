import { type KeyObject } from "node:crypto";
import type { LivePairGrant } from "../live/roomLiveAdmission";
import {
  copyRoomBinding,
  envelopeRecord,
  envelopeReference,
  roomIdentity,
  type RoomBinding,
} from "../roomEnvelopeProtocol";
import { type CurrentOwnerAnchorProvider, sameInstalledFloor } from "../roomDeviceInstall";
import { type RoomPrivateStoreAuthority } from "../roomPrivateStoreAuthority";
import { verifyFetched } from "./roomCiphertextStore";
import {
  checkRecoveryFloor,
  copyRecoveryBundle,
  type RecoveryBundle,
} from "../roomRecoveryProtocol";
import {
  CONTROL_LEASE_TTL,
  copyLivePeer,
  livePeerReceipt,
  type LivePeerApproval,
  copyRequest,
  copyView,
  floorAt,
  freshNonce,
  importSpki,
  keyRef,
  parseWire,
  proofBytes,
  receiptBytes,
  reject,
  signBytes,
  verified,
  wire,
  type ControlView,
  type Operation,
} from "./roomControlProtocol";

export interface RoomControlTransport {
  begin(token: string, request: string): Promise<string>;
  finish(token: string, request: string, challenge: string, signature: string): Promise<string>;
  finishCheckpoint?(
    token: string,
    request: string,
    challenge: string,
    signature: string,
    bundle?: RecoveryBundle,
  ): Promise<{ receipt: string; bundle?: RecoveryBundle }>;
  onDisconnect(invalidate: () => void): () => void;
}
export interface RoomControlClientConfig {
  transport: RoomControlTransport;
  authorityPublicKey: string;
  devicePrivateKey: KeyObject;
  profileRef: string;
  room: RoomBinding;
  accountToken: () => Promise<string>;
}
interface Snapshot {
  view: ControlView;
  until: number;
  stop: AbortController;
}
export function openRoomControlClient(options?: RoomControlClientConfig) {
  if (!options) return null;
  const config = options;
  const room = copyRoomBinding(config.room),
    profileRef = envelopeReference(config.profileRef);
  const root = importSpki(config.authorityPublicKey),
    authority = keyRef(root),
    device = config.devicePrivateKey,
    identity = keyRef(device);
  if (device.type !== "private") return reject();
  let closed = false,
    working = false,
    epoch = 0;
  let snapshot: Snapshot | undefined,
    last: ControlView | undefined,
    expiry: ReturnType<typeof setTimeout> | undefined;
  function invalidate() {
    epoch++;
    if (expiry) clearTimeout(expiry);
    snapshot?.stop.abort();
    snapshot = undefined;
  }
  const detach = config.transport.onDisconnect(invalidate);
  function current(requested: RoomBinding) {
    const s = snapshot;
    if (
      closed ||
      !s ||
      s.stop.signal.aborted ||
      performance.now() >= s.until ||
      roomIdentity(requested) !== roomIdentity(room)
    )
      return null;
    const check = () => {
      if (closed || snapshot !== s || s.stop.signal.aborted || performance.now() >= s.until)
        return reject();
    };
    return {
      s,
      check,
      grant: {
        expiresAt: s.until,
        revoked: s.stop.signal,
        assertCurrent: check,
        release() {},
        active: true,
        mayEnroll: true,
        authorityVersion: s.view.revision,
      },
    };
  }
  const control: RoomPrivateStoreAuthority = {
    owner(requested) {
      const c = current(requested);
      if (!c?.s.view.owner) return null;
      const v = c.s.view;
      return {
        ...c.grant,
        target: {
          room,
          profileRef,
          scopeKey: v.scopeKey,
          pageId: v.pageId,
          senderRef: identity,
          fence: v.fence,
        },
        authorizeGenesis: v.head === null,
        confirmedDigest: v.head?.bundleDigest ?? null,
      };
    },
    device(requested) {
      const c = current(requested);
      if (!c?.s.view.head) return null;
      const v = c.s.view;
      return {
        ...c.grant,
        target: { room, profileRef, deviceRef: identity, fence: v.fence },
        approvedDigest: (v.pending ?? v.head!).bundleDigest,
        accepted: v.accepted,
      };
    },
  };
  const anchors: CurrentOwnerAnchorProvider = {
    capture(requested) {
      const c = current(requested);
      if (!c?.s.view.head) return null;
      return {
        anchor: c.s.view.pending ?? c.s.view.head,
        revoked: c.s.stop.signal,
        assertCurrent: c.check,
        release() {},
      };
    },
  };
  async function exchange(
    operation: Operation,
    data?: { upload?: RecoveryBundle },
  ): Promise<{ view: ControlView; bundle?: RecoveryBundle; peer?: LivePeerApproval }> {
    if (closed || working) return reject();
    const upload = data?.upload === undefined ? undefined : copyRecoveryBundle(data.upload);
    if (data && !config.transport.finishCheckpoint) return reject();
    const started = performance.now(),
      generation = epoch,
      until = started + CONTROL_LEASE_TTL;
    const r = copyRequest({ room, keyRef: identity, nonce: freshNonce(), operation }),
      text = wire(r);
    working = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (closed || epoch !== generation || performance.now() >= until) return reject();
    };
    const task = async () => {
      try {
        const token = await config.accountToken();
        check();
        const challenge = await config.transport.begin(token, text);
        check();
        const signature = signBytes(device, proofBytes(authority, r, challenge));
        check();
        const result = data
          ? await config.transport.finishCheckpoint!(token, text, challenge, signature, upload)
          : { receipt: await config.transport.finish(token, text, challenge, signature) };
        check();
        const fields = envelopeRecord(
          parseWire(result.receipt),
          r.operation.kind === "live-peer"
            ? ["view", "signature", "peer", "peerSignature"]
            : ["view", "signature"],
        );
        const view = copyView(fields.view, room);
        if (
          view.profileRef !== profileRef ||
          !verified(root, receiptBytes(authority, r, challenge, view), fields.signature)
        )
          return reject();
        let peer: LivePeerApproval | undefined;
        if (r.operation.kind === "live-peer") {
          peer = copyLivePeer(fields.peer);
          if (
            peer.deviceRef !== r.operation.deviceRef ||
            peer.owner === view.owner ||
            !verified(
              root,
              livePeerReceipt(authority, r, challenge, view, peer),
              fields.peerSignature,
            )
          )
            return reject();
        }
        if (last) {
          if (
            view.revision < last.revision ||
            view.fence < last.fence ||
            view.owner !== last.owner ||
            view.pageId !== last.pageId ||
            view.scopeKey !== last.scopeKey ||
            (last.revision === view.revision && wire(view) !== wire(last))
          )
            return reject();
          if (last.head) {
            if (!view.head) return reject();
            checkRecoveryFloor(view.head, floorAt(last.head));
          }
          if (
            last.accepted &&
            (!view.accepted ||
              view.accepted.version < last.accepted.version ||
              (view.accepted.version === last.accepted.version &&
                !sameInstalledFloor(view.accepted.floor, last.accepted.floor)))
          )
            return reject();
        }
        let bundle: RecoveryBundle | undefined;
        if (r.operation.kind === "fetch") {
          if (!result.bundle) return reject();
          const pin =
            view.head?.bundleDigest === r.operation.digest
              ? view.head
              : view.pending?.bundleDigest === r.operation.digest
                ? view.pending
                : view.accepted?.floor;
          if (!pin) return reject();
          bundle = copyRecoveryBundle(result.bundle);
          verifyFetched(bundle, room, r.operation.digest, pin);
        } else if (result.bundle) return reject();
        if (
          r.operation.kind === "publish" &&
          view.head?.bundleDigest !== r.operation.anchor.bundleDigest
        )
          return reject();
        // A later receipt never extends an already captured P1 lease.
        check();
        if (expiry) clearTimeout(expiry);
        snapshot?.stop.abort();
        last = copyView(view, room);
        snapshot = { view: last, until, stop: new AbortController() };
        expiry = setTimeout(invalidate, Math.max(0, until - performance.now()));
        expiry.unref?.();
        return {
          view: copyView(view, room),
          ...(bundle ? { bundle } : {}),
          ...(peer ? { peer } : {}),
        };
      } finally {
        working = false;
      }
    };
    try {
      // Non-cancellable transport still owns the one in-flight slot until it settles.
      return await Promise.race([
        task(),
        new Promise<never>((_, fail) => {
          timer = setTimeout(() => fail(new Error()), CONTROL_LEASE_TTL);
        }),
      ]);
    } catch {
      invalidate();
      return reject();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return Object.freeze({
    control,
    anchors,
    deviceRef: identity,
    async request(op: Operation) {
      return (await exchange(op)).view;
    },
    async livePair(peerRef: string): Promise<LivePairGrant> {
      const result = await exchange({ kind: "live-peer", deviceRef: peerRef });
      const c = current(room);
      if (!c || !result.peer || c.s.view.revision !== result.view.revision) return reject();
      let used = false;
      return Object.freeze({
        room,
        localRole: result.view.owner ? "host" : "peer",
        localMode: result.peer.localMode,
        peerMode: result.peer.peerMode,
        localSigningKey: device,
        peerPublicKey: result.peer.key,
        expiresAt: c.s.until,
        revoked: c.s.stop.signal,
        assertCurrent() {
          if (used) return reject();
          c.check();
        },
        release() {
          used = true;
        },
      });
    },
    async publishCheckpoint(op: Extract<Operation, { kind: "publish" }>, bundle: RecoveryBundle) {
      return (await exchange(op, { upload: bundle })).view;
    },
    async fetchCheckpoint(digest: string) {
      const result = await exchange({ kind: "fetch", digest }, {});
      if (!result.bundle) return reject();
      return { view: result.view, bundle: result.bundle };
    },
    close() {
      if (!closed) {
        closed = true;
        invalidate();
        detach();
      }
    },
  });
}
