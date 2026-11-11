// FILE: server.d.mts
// Purpose: Types for importing the MCP Apps fixture server from TypeScript tests.

import type http from "node:http";

export declare const WIDGET_URI: string;
export declare const FILE_URI: string;
export declare const tools: ReadonlyArray<Record<string, unknown>>;
export declare function widgetHtml(): string;
export declare function startHttp(port: number, host?: string): Promise<http.Server>;
