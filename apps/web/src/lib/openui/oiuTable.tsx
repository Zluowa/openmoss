// @ts-nocheck
"use client";

import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { inline } from "./oiuMarkdown";
import { cx } from "./oiuStyle";

const NUMERIC = /^[-+−]?[$€£¥₹]?\s?\d[\d,]*(\.\d+)?\s?(%|[kKmMbB]|bn)?$/;
const componentProps = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object") return null;
  const props = (value as { props?: unknown }).props;
  return props && typeof props === "object" && !Array.isArray(props)
    ? (props as Record<string, unknown>)
    : (value as Record<string, unknown>);
};
const isElement = (value: unknown) =>
  !!value &&
  typeof value === "object" &&
  ((value as { type?: unknown }).type === "element" ||
    (value as { type?: unknown }).type === "component");

export const Table = defineComponent({
  name: "Table",
  props: z.object({
    columns: z.array(z.any()),
    rows: z.array(z.array(z.any())).optional(),
  }),
  description:
    "Each row lists its cells in column order; a cell may be a component. Number columns align right.",
  component: ({ props, renderNode }) => {
    const legacyColumns = (Array.isArray(props.columns) ? props.columns : [])
      .map((column) => componentProps(column))
      .filter((column): column is Record<string, unknown> => column !== null && "data" in column);
    const columns = legacyColumns.length
      ? legacyColumns.map((c) => String(c.label ?? ""))
      : Array.isArray(props.columns)
        ? props.columns.map((c) => String(c ?? ""))
        : [];
    const rows = legacyColumns.length
      ? Array.from(
          {
            length: Math.max(
              0,
              ...legacyColumns.map((c) => (Array.isArray(c.data) ? c.data.length : 0)),
            ),
          },
          (_, row) => legacyColumns.map((c) => (Array.isArray(c.data) ? c.data[row] : null)),
        )
      : ((Array.isArray(props.rows) ? props.rows : []).filter(Array.isArray) as unknown[][]);
    // A column of numbers (or amounts like "$1.2k" and "45%") aligns right.
    const numeric = columns.map((_, c) => {
      const cells = rows
        .map((r) => r[c])
        .filter(
          (v) =>
            v != null &&
            v !== "" &&
            !(typeof v === "string" && /^(n\/a|\u2014|\u2013|-)$/i.test(v.trim())),
        );
      return (
        cells.length > 0 &&
        cells.every(
          (v) => typeof v === "number" || (typeof v === "string" && NUMERIC.test(v.trim())),
        )
      );
    });
    const cell = (value: unknown) =>
      isElement(value)
        ? renderNode(value)
        : typeof value === "number"
          ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
          : inline(String(value ?? ""));
    return (
      <div className="iui-table-scroll">
        <table className="iui-table">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={i} className={cx(numeric[i] && "is-numeric")}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {columns.map((_, c) => (
                  <td key={c} className={cx(numeric[c] && "is-numeric")}>
                    {cell(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
});
