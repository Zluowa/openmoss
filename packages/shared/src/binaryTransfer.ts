// Shared route names keep browser uploads and server handlers on the same protocol surface.
export const ATTACHMENT_UPLOAD_ROUTE_PATH = "/api/attachments/upload" as const;
export const ATTACHMENT_CANCEL_ROUTE_PATH = "/api/attachments/cancel" as const;
export const VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH = "/api/voice/transcribe" as const;
export const LIBRARY_UPLOAD_ROUTE_PATH = "/api/library/upload" as const;
/** One file into the 资料库 as raw bytes (`?name=&mimeType=`); the WebSocket caps a message at 2 MiB. */
export const LIBRARY_IMPORT_ROUTE_PATH = "/api/library/import" as const;
