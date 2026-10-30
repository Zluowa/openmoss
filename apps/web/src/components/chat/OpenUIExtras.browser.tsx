import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { OpenUIFrame } from "./OpenUIFrame";

const SOURCE = `root = Card([chart, math, drawing, table, tool])
chart = Chart("bar", [{label: "Q1", value: 10}, {label: "Q2", value: 18}], "label", ["value"], "number")
math = Math("E = mc^2")
drawing = Svg([Circle(30, 30, 20, "chart1"), Line(5, 5, 55, 55, "info", 2)], "0 0 80 80")
table = Table(["Name", "Value"], [["Revenue", 18], ["Users", 42]])
$count = 1
tool = Button("Increase", @Set($count, $count + 1))`;

const COLUMN_SOURCE = `root = Card([table])
table = Table([names, values])
names = Col("Metric", ["Revenue", "Users"])
values = Col("Value", [18, 42], "number")`;

it("renders the OpenUI chart, math, SVG, table, and local working tool", async () => {
  const client = new QueryClient();
  const mounted = await render(
    <QueryClientProvider client={client}>
      <OpenUIFrame
        threadId="openui-extras-browser"
        directive={{ code: SOURCE, source: SOURCE, partial: false }}
        isStreaming={false}
      />
    </QueryClientProvider>,
  );
  try {
    await expect.element(mounted.getByText("Revenue")).toBeInTheDocument();
    await expect.element(mounted.getByText("Users")).toBeInTheDocument();
    expect(mounted.baseElement.querySelector("svg")).not.toBeNull();
    expect(mounted.baseElement.querySelector(".katex")).not.toBeNull();
    await expect.element(mounted.getByRole("button", { name: "Increase" })).toBeInTheDocument();
  } finally {
    await mounted.unmount();
  }
});

it("renders OpenUI Col component nodes as table rows", async () => {
  const client = new QueryClient();
  const mounted = await render(
    <QueryClientProvider client={client}>
      <OpenUIFrame
        threadId="openui-col-table-browser"
        directive={{ code: COLUMN_SOURCE, source: COLUMN_SOURCE, partial: false }}
        isStreaming={false}
      />
    </QueryClientProvider>,
  );
  try {
    await expect.element(mounted.getByText("Revenue")).toBeInTheDocument();
    await expect.element(mounted.getByText("Users")).toBeInTheDocument();
  } finally {
    await mounted.unmount();
  }
});
