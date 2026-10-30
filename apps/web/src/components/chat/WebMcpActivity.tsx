// FILE: WebMcpActivity.tsx
// Purpose: Render strictly decoded native WebMCP child activities after an MCP row.
// Layer: Chat presentation component
// Exports: WebMcpActivity

import { useState, type ReactNode } from "react";

import type { CodexWebMcpCall } from "@synara/contracts";
import { SiteFavicon } from "../SiteFavicon";
import { GlobeIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { formatMcpJson } from "./McpToolResultDetails";
import { McpCodePane } from "./McpCodePane";
import { ToolActivityDisclosure } from "./ToolActivityDisclosure";

type WebMcpActivityCall = CodexWebMcpCall;

export interface WebMcpActivityProps {
  readonly calls: ReadonlyArray<WebMcpActivityCall>;
  readonly fallbackHostname?: string | undefined;
  readonly parentCallId: string;
  readonly compact: boolean;
  readonly fontSizePx: number;
}

function parseWebMcpJson(
  value: string,
  truncated: boolean,
): { readonly parsed: boolean; readonly value: unknown } {
  if (truncated) return { parsed: false, value };
  try {
    return { parsed: true, value: JSON.parse(value) as unknown };
  } catch {
    return { parsed: false, value };
  }
}

function humanizeToolCallIdentifier(value: string): string {
  const spaced = value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  if (spaced.length === 0) return value;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function webMcpToolFields(call: WebMcpActivityCall): Record<string, unknown> {
  const fields: Record<string, unknown> = { name: call.name };
  if (call.title !== undefined) fields.title = call.title;
  if (call.description !== undefined) fields.description = call.description;
  if (call.sourceHostname !== undefined) fields.website = call.sourceHostname;
  if (call.readOnlyHint !== undefined) fields.readOnlyHint = call.readOnlyHint;
  if (call.kind === "invokeTool" && call.inputJson !== undefined) {
    fields.input = parseWebMcpJson(call.inputJson, call.inputTruncated === true).value;
  }
  if (call.kind === "invokeTool" && call.inputTruncated === true) {
    fields.inputTruncated = true;
  }
  return fields;
}

function WebMcpJsonBlock(props: {
  readonly title: string;
  readonly value: string;
  readonly parse: boolean;
  readonly dataAttribute: string;
}) {
  const parsedValue = props.parse ? parseWebMcpJson(props.value, false) : null;
  return (
    <section data-webmcp-json-section={props.dataAttribute}>
      <McpCodePane title={props.title} tabIndex={0} data-webmcp-json={props.dataAttribute}>
        {props.parse && parsedValue?.parsed ? formatMcpJson(parsedValue.value) : props.value}
      </McpCodePane>
    </section>
  );
}

function WebMcpCallActivity(props: {
  readonly call: WebMcpActivityCall;
  readonly fallbackHostname: string | undefined;
  readonly parentCallId: string;
  readonly index: number;
  readonly fontSizePx: number;
}) {
  const { call, fallbackHostname, parentCallId, index, fontSizePx } = props;
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label =
    call.kind === "listTools"
      ? t("chat.webMcp.listTools")
      : (call.title ?? humanizeToolCallIdentifier(call.name));
  const hostname = call.sourceHostname ?? fallbackHostname;
  const leadingIcon = hostname ? (
    <SiteFavicon url={`https://${hostname}`} className="icon-xs shrink-0 text-text/60" />
  ) : (
    <GlobeIcon className="icon-xs shrink-0 text-text/60" />
  );
  const toolFields = webMcpToolFields(call);
  const activityKey = `${parentCallId}:webmcp:${index}:${call.name}`;
  return (
    <div
      className="min-w-0"
      data-webmcp-activity="true"
      data-webmcp-call-kind={call.kind}
      data-webmcp-call-name={call.name}
      data-webmcp-activity-key={activityKey}
    >
      <ToolActivityDisclosure
        label={label}
        leadingIcon={leadingIcon}
        open={open}
        onToggle={setOpen}
        fontSizePx={fontSizePx}
        renderChildren={() => (
          <div className="min-w-0" data-webmcp-activity-body="true">
            <div className="flex min-w-0 max-w-full flex-col gap-2">
              <WebMcpJsonBlock
                title={
                  call.kind === "invokeTool" && call.inputTruncated === true
                    ? t("chat.webMcp.tool.inputTruncated")
                    : t("chat.webMcp.tool")
                }
                value={formatMcpJson(toolFields)}
                parse={false}
                dataAttribute="tool"
              />
              {call.outputJson !== undefined ? (
                <WebMcpJsonBlock
                  title={
                    call.outputTruncated === true
                      ? t("chat.webMcp.result.truncated")
                      : t("chat.webMcp.result")
                  }
                  value={call.outputJson}
                  parse={call.outputTruncated !== true}
                  dataAttribute="result"
                />
              ) : null}
            </div>
          </div>
        )}
      />
    </div>
  );
}

export function WebMcpActivity(props: WebMcpActivityProps): ReactNode {
  if (props.calls.length === 0) return null;
  return (
    <div
      className="flex min-w-0 flex-col gap-[var(--conversation-grouped-item-gap,4px)]"
      data-webmcp-activities="true"
      data-density={props.compact ? "compact" : "default"}
    >
      {props.calls.map((call, index) => (
        <WebMcpCallActivity
          // The ordered index is part of the durable child identity contract.
          // oxlint-disable-next-line react/no-array-index-key
          key={`${props.parentCallId}:webmcp:${index}:${call.name}`}
          call={call}
          fallbackHostname={props.fallbackHostname}
          parentCallId={props.parentCallId}
          index={index}
          fontSizePx={props.fontSizePx}
        />
      ))}
    </div>
  );
}
