import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { MESSAGE_SYNC, type PageRealtimeRoom, type RoomConnection } from "../PageRealtimeRoom";
import { applyPlateValue } from "../pageYjsContent";

/** An editor's real y-protocols update frame. The client chooses body bytes only;
 * the server identifies the contributing source from the admitted connection. */
export function sendRoomEdit(
  room: PageRealtimeRoom,
  connection: RoomConnection,
  target: readonly unknown[],
) {
  const editor = new Y.Doc();
  try {
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(room.doc));
    const previous = Y.encodeStateVector(editor);
    applyPlateValue(editor, target, null);
    const frame = encoding.createEncoder();
    encoding.writeVarUint(frame, MESSAGE_SYNC);
    syncProtocol.writeUpdate(frame, Y.encodeStateAsUpdate(editor, previous));
    return room.receive(connection, encoding.toUint8Array(frame));
  } finally {
    editor.destroy();
  }
}
