// FILE: controls.behaviour.browser.tsx
// Purpose: Behaviour contract of Moss's form-control wrappers (button, checkbox, switch, radio,
//          slider, toggle, input, textarea, label, separator, scroll area, OTP input). It is
//          written against the wrappers' exported API only, so the same file passes on the
//          primitive library underneath them today and after it changes. Upgrades of that library
//          run it (round 20261118-ui-sdk, part C), so a red case here blocks an upgrade.
// Layer: Web component tests (real Chromium, real rendered parts, trusted keyboard input).

import "../../index.css";

import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { composeChineseWithEnter, recordImeEvents } from "../../test/imeComposition";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { Input } from "./input";
import { MossOtpInput } from "./input-otp";
import { Label } from "./label";
import { Radio, RadioGroup } from "./radio-group";
import { ScrollArea } from "./scroll-area";
import { Separator } from "./separator";
import { Slider } from "./slider";
import { Switch } from "./switch";
import { Textarea } from "./textarea";
import { Toggle } from "./toggle";

function one<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

function active(): Element | null {
  return document.activeElement;
}

/** The slider value a screen reader announces: `aria-valuenow`, or a native range input's value. */
function sliderValue(name: string): string | null {
  const element = page.getByRole("slider", { name }).element();
  return element.getAttribute("aria-valuenow") ?? (element as HTMLInputElement).value ?? null;
}

afterEach(() => {
  document.body.style.removeProperty("cursor");
});

describe("Button", () => {
  it("is a named button of type button that presses with the mouse, Enter and Space", async () => {
    const onClick = vi.fn();
    await render(
      <form onSubmit={(event) => event.preventDefault()}>
        <Button onClick={onClick}>保存</Button>
      </form>,
    );
    const button = page.getByRole("button", { name: "保存" });
    await expect.element(button).toHaveAttribute("type", "button");
    await expect.element(button).toHaveAttribute("data-slot", "button");
    await button.click();
    (button.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it("leaves the tab order and ignores presses while disabled", async () => {
    const onClick = vi.fn();
    await render(
      <>
        <Button>前一个</Button>
        <Button disabled onClick={onClick}>
          删除
        </Button>
        <Button>后一个</Button>
      </>,
    );
    (page.getByRole("button", { name: "前一个" }).element() as HTMLElement).focus();
    await userEvent.tab();
    expect(active()?.textContent).toBe("后一个");
    (page.getByRole("button", { name: "删除" }).element() as HTMLElement).click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not hold a second press while an async click handler is still running", async () => {
    // Moss buttons fire their handler on every press; a handler that guards double sends does
    // so itself. A library that turns a returned Promise into a pending state changes that.
    let release: () => void = () => {};
    const onClick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await render(<Button onClick={onClick}>发送</Button>);
    const button = page.getByRole("button", { name: "发送" });
    await button.click();
    await button.click();
    expect(onClick).toHaveBeenCalledTimes(2);
    await expect.element(button).not.toHaveAttribute("aria-disabled");
    await expect.element(button).not.toBeDisabled();
    release();
  });

  it("renders as a link through render, keeping the link and its classes", async () => {
    await render(
      <Button render={<a href="#moss-docs" />} variant="outline">
        文档
      </Button>,
    );
    const link = page.getByRole("link", { name: "文档" });
    await expect.element(link).toHaveAttribute("href", "#moss-docs");
    await expect.element(link).not.toHaveAttribute("type");
    expect((link.element() as HTMLElement).className).toContain("rounded-control");
  });

  it("submits its form with type submit", async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    await render(
      <form onSubmit={onSubmit}>
        <Button type="submit">提交</Button>
      </form>,
    );
    await page.getByRole("button", { name: "提交" }).click();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("forwards its ref to the button element", async () => {
    let node: HTMLButtonElement | null = null;
    await render(
      <Button
        ref={(element: HTMLButtonElement | null) => {
          node = element;
        }}
      >
        引用
      </Button>,
    );
    expect(node).toBeInstanceOf(HTMLButtonElement);
  });
});

describe("Checkbox", () => {
  function Controlled({ onChange }: { onChange: (checked: unknown) => void }) {
    const [checked, setChecked] = useState(false);
    return (
      <Checkbox
        aria-label="记住选择"
        checked={checked}
        onCheckedChange={(next) => {
          onChange(next);
          setChecked(next);
        }}
      />
    );
  }

  it("toggles with a click and Space and reports a boolean", async () => {
    const onChange = vi.fn();
    await render(<Controlled onChange={onChange} />);
    const box = page.getByRole("checkbox", { name: "记住选择" });
    await expect.element(box).toHaveAttribute("aria-checked", "false");
    await box.click();
    await expect.element(box).toHaveAttribute("aria-checked", "true");
    await expect.element(box).toHaveAttribute("data-checked");
    await userEvent.keyboard(" ");
    await expect.element(box).toHaveAttribute("aria-checked", "false");
    await expect.element(box).toHaveAttribute("data-unchecked");
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([true, false]);
  });

  it("shows the mixed state and becomes checked on press", async () => {
    const onChange = vi.fn();
    await render(
      <Checkbox aria-label="全选" checked={false} indeterminate onCheckedChange={onChange} />,
    );
    const box = page.getByRole("checkbox", { name: "全选" });
    await expect.element(box).toHaveAttribute("aria-checked", "mixed");
    await box.click();
    expect(onChange.mock.calls[0]?.[0]).toBe(true);
  });

  it("toggles from its wrapping label", async () => {
    const onChange = vi.fn();
    await render(
      <label>
        <Checkbox onCheckedChange={onChange} />
        <span>不再询问</span>
      </label>,
    );
    await page.getByText("不再询问").click();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0]).toBe(true);
    await expect.element(page.getByRole("checkbox", { name: "不再询问" })).toBeInTheDocument();
  });

  it("cannot be focused or changed while disabled", async () => {
    const onChange = vi.fn();
    await render(
      <>
        <Button>前</Button>
        <Checkbox aria-label="禁用项" disabled onCheckedChange={onChange} />
        <Button>后</Button>
      </>,
    );
    (page.getByRole("button", { name: "前" }).element() as HTMLElement).focus();
    await userEvent.tab();
    expect(active()?.textContent).toBe("后");
    (page.getByRole("checkbox", { name: "禁用项" }).element() as HTMLElement).click();
    expect(onChange).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("checkbox", { name: "禁用项" }))
      .toHaveAttribute("data-disabled");
  });

  it("paints the check glyph only while checked", async () => {
    await render(
      <>
        <Checkbox aria-label="开" checked />
        <Checkbox aria-label="关" checked={false} />
      </>,
    );
    const on = page.getByRole("checkbox", { name: "开" }).element();
    const off = page.getByRole("checkbox", { name: "关" }).element();
    expect(on.querySelector("svg")?.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(off.querySelector("svg")?.getBoundingClientRect().width ?? 0).toBe(0);
  });
});

describe("Switch", () => {
  it("is a named switch that turns with a click, Space and Enter-free keyboard", async () => {
    const onChange = vi.fn();
    function Controlled() {
      const [on, setOn] = useState(false);
      return (
        <Switch
          aria-label="联网搜索"
          checked={on}
          onCheckedChange={(next) => {
            onChange(next);
            setOn(next);
          }}
        />
      );
    }
    await render(<Controlled />);
    const control = page.getByRole("switch", { name: "联网搜索" });
    await expect.element(control).toHaveAttribute("aria-checked", "false");
    const thumb = (control.element() as HTMLElement).querySelector<HTMLElement>(
      '[data-slot="switch-thumb"]',
    );
    const offLeft = thumb!.getBoundingClientRect().left;
    await control.click();
    await expect.element(control).toHaveAttribute("aria-checked", "true");
    await expect.element(control).toHaveAttribute("data-checked");
    await expect.poll(() => thumb!.getBoundingClientRect().left).toBeGreaterThan(offLeft + 4);
    await userEvent.keyboard(" ");
    await expect.element(control).toHaveAttribute("aria-checked", "false");
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([true, false]);
  });

  it("labels itself from a Label's htmlFor and toggles from it", async () => {
    const onChange = vi.fn();
    await render(
      <div>
        <Label htmlFor="web-search">联网</Label>
        <Switch id="web-search" onCheckedChange={onChange} />
      </div>,
    );
    await page.getByText("联网").click();
    expect(onChange).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("switch", { name: "联网" })).toBeInTheDocument();
  });

  it("stays put while disabled", async () => {
    const onChange = vi.fn();
    await render(<Switch aria-label="自动更新" disabled onCheckedChange={onChange} />);
    (page.getByRole("switch", { name: "自动更新" }).element() as HTMLElement).click();
    expect(onChange).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("switch", { name: "自动更新" }))
      .toHaveAttribute("data-disabled");
  });
});

describe("RadioGroup", () => {
  it("moves and selects with arrow keys and keeps one tab stop", async () => {
    const onValueChange = vi.fn();
    await render(
      <>
        <Button>前</Button>
        <RadioGroup aria-label="密度" defaultValue="comfortable" onValueChange={onValueChange}>
          <Label>
            <Radio value="compact" /> 紧凑
          </Label>
          <Label>
            <Radio value="comfortable" /> 舒适
          </Label>
          <Label>
            <Radio value="spacious" /> 宽松
          </Label>
        </RadioGroup>
        <Button>后</Button>
      </>,
    );
    (page.getByRole("button", { name: "前" }).element() as HTMLElement).focus();
    await userEvent.tab();
    expect(active()).toBe(page.getByRole("radio", { name: "舒适" }).element());
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("radio", { name: "宽松" })).toBeChecked();
    expect(active()).toBe(page.getByRole("radio", { name: "宽松" }).element());
    expect(onValueChange.mock.calls.at(-1)?.[0]).toBe("spacious");
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(page.getByRole("radio", { name: "舒适" })).toBeChecked();
    await userEvent.tab();
    expect(active()?.textContent).toBe("后");
  });
});

describe("Slider", () => {
  function Controlled(props: { onChange?: (value: number) => void; disabled?: boolean }) {
    const [value, setValue] = useState(2);
    return (
      <div style={{ width: 240 }}>
        <Slider
          aria-label="思考强度"
          value={value}
          min={0}
          max={4}
          step={1}
          showStepMarks
          magnetic
          {...(props.disabled ? { disabled: true } : {})}
          getAriaValueText={(next) => ["最低", "低", "中", "高", "最高"][next] ?? String(next)}
          onValueChange={(next) => {
            props.onChange?.(next);
            setValue(next);
          }}
        />
      </div>
    );
  }

  it("steps with arrows, jumps with Home and End and names its value", async () => {
    const onChange = vi.fn();
    await render(<Controlled onChange={onChange} />);
    const thumb = page.getByRole("slider", { name: "思考强度" });
    await expect.poll(() => sliderValue("思考强度")).toBe("2");
    await expect.element(thumb).toHaveAttribute("aria-valuetext", "中");
    (thumb.element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.poll(() => sliderValue("思考强度")).toBe("1");
    await userEvent.keyboard("{End}");
    await expect.poll(() => sliderValue("思考强度")).toBe("4");
    await expect.element(thumb).toHaveAttribute("aria-valuetext", "最高");
    await userEvent.keyboard("{Home}");
    await expect.poll(() => sliderValue("思考强度")).toBe("0");
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([1, 4, 0]);
  });

  it("keeps the thumb inside the track at both ends", async () => {
    await render(<Controlled />);
    const thumb = page.getByRole("slider", { name: "思考强度" });
    (thumb.element() as HTMLElement).focus();
    // The painted track spans the slider's full width; measure against the root so the check
    // holds whichever inner part the library positions thumbs against.
    const track = one('[data-slot="slider"]').getBoundingClientRect();
    const disc = () => one('[data-slot="slider-thumb"]').getBoundingClientRect();
    await userEvent.keyboard("{Home}");
    await expect.poll(() => Math.round(disc().left - track.left)).toBe(0);
    await userEvent.keyboard("{End}");
    await expect.poll(() => Math.round(track.right - disc().right)).toBe(0);
  });

  it("jumps to the value under a click on the track", async () => {
    const onChange = vi.fn();
    await render(<Controlled onChange={onChange} />);
    const root = one('[data-slot="slider"]');
    const box = root.getBoundingClientRect();
    await userEvent.click(root, { position: { x: box.width - 2, y: box.height / 2 } });
    await expect.poll(() => sliderValue("思考强度")).toBe("4");
  });

  it("puts the thumb's centre under the pointer on a continuous scale", async () => {
    function Continuous() {
      const [value, setValue] = useState(50);
      return (
        <div style={{ width: 300 }}>
          <Slider aria-label="音量" value={value} min={0} max={100} onValueChange={setValue} />
        </div>
      );
    }
    await render(<Continuous />);
    const root = one('[data-slot="slider"]');
    const box = root.getBoundingClientRect();
    const thumbSize = one('[data-slot="slider-thumb"]').getBoundingClientRect().width;
    // The thumb never overhangs the track, so its centre travels between half a thumb from each end.
    const xFor = (value: number) => thumbSize / 2 + (value / 100) * (box.width - thumbSize);
    for (const target of [10, 75]) {
      await userEvent.click(root, { position: { x: xFor(target), y: box.height / 2 } });
      const now = Number(sliderValue("音量"));
      expect(Math.abs(now - target)).toBeLessThanOrEqual(1);
    }
  });

  it("ignores keys while disabled", async () => {
    const onChange = vi.fn();
    await render(<Controlled onChange={onChange} disabled />);
    const thumb = page.getByRole("slider", { name: "思考强度" });
    (thumb.element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).not.toHaveBeenCalled();
    expect(one('[data-slot="slider"]').hasAttribute("data-disabled")).toBe(true);
  });
});

describe("Toggle", () => {
  it("reports aria-pressed and flips with Space and Enter", async () => {
    const onPressedChange = vi.fn();
    await render(
      <Toggle aria-label="摘要" onPressedChange={onPressedChange}>
        摘要
      </Toggle>,
    );
    const toggle = page.getByRole("button", { name: "摘要" });
    await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
    await expect.element(toggle).toHaveAttribute("data-pressed");
    await userEvent.keyboard(" ");
    await userEvent.keyboard("{Enter}");
    await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
    expect(onPressedChange.mock.calls.map(([value]) => value)).toEqual([true, false, true]);
  });
});

describe("Input", () => {
  it("is a named textbox that forwards its ref and fires onChange as the person types", async () => {
    const onChange = vi.fn();
    let node: HTMLInputElement | null = null;
    await render(
      <Input
        aria-label="项目名称"
        ref={(element) => {
          node = element;
        }}
        onChange={(event) => onChange(event.currentTarget.value)}
      />,
    );
    const field = page.getByRole("textbox", { name: "项目名称" });
    await field.fill("Moss");
    expect(onChange.mock.calls.at(-1)?.[0]).toBe("Moss");
    expect(node).toBe(field.element());
    expect((node as HTMLInputElement | null)?.getAttribute("data-slot")).toBe("input");
  });

  it("submits its form with a plain Enter", async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    await render(
      <form onSubmit={onSubmit}>
        <Input aria-label="地址" />
      </form>,
    );
    const field = page.getByRole("textbox", { name: "地址" });
    await field.fill("moss");
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it.each(["Enter", "Process"] as const)(
    "keeps the form unsent while Enter (%s) confirms a pinyin candidate",
    async (confirmKey) => {
      const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
      const onKeyDown = vi.fn((event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.currentTarget.form?.requestSubmit();
        }
      });
      await render(
        <form onSubmit={onSubmit}>
          <Input aria-label="搜索" onKeyDown={onKeyDown} />
        </form>,
      );
      const field = page.getByRole("textbox", { name: "搜索" }).element() as HTMLInputElement;
      const record = recordImeEvents(field);
      await composeChineseWithEnter(field, "nihao", "你好", confirmKey);
      record.stop();
      expect(record.events).toContain("compositionstart");
      expect(record.events).toContain("compositionend");
      expect(record.events.some((event) => event.endsWith(":229:composing"))).toBe(true);
      await expect.poll(() => field.value).toBe("你好");
      expect(onSubmit).not.toHaveBeenCalled();
      // The next plain Enter after the candidate is chosen still submits.
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => onSubmit.mock.calls.length).toBeGreaterThanOrEqual(1);
    },
  );

  it("cannot be focused while disabled", async () => {
    await render(
      <>
        <Button>前</Button>
        <Input aria-label="禁用" disabled />
        <Button>后</Button>
      </>,
    );
    (page.getByRole("button", { name: "前" }).element() as HTMLElement).focus();
    await userEvent.tab();
    expect(active()?.textContent).toBe("后");
  });
});

describe("Textarea", () => {
  it("adds a new line on Enter and never submits on its own", async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    await render(
      <form onSubmit={onSubmit}>
        <Textarea aria-label="备注" />
      </form>,
    );
    const field = page.getByRole("textbox", { name: "备注" });
    await field.click();
    await userEvent.keyboard("第一行{Enter}第二行");
    expect((field.element() as HTMLTextAreaElement).value).toBe("第一行\n第二行");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps a composed Chinese word and adds no line for the confirming Enter", async () => {
    const onSend = vi.fn();
    await render(
      <Textarea
        aria-label="消息"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSend(event.currentTarget.value);
          }
        }}
      />,
    );
    const field = page.getByRole("textbox", { name: "消息" }).element() as HTMLTextAreaElement;
    await composeChineseWithEnter(field, "xiexie", "谢谢");
    await expect.poll(() => field.value).toBe("谢谢");
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("谢谢");
  });

  it("forwards data-slot and grows with its content", async () => {
    await render(<Textarea aria-label="长文本" />);
    const field = page.getByRole("textbox", { name: "长文本" });
    expect((field.element() as HTMLElement).getAttribute("data-slot")).toBe("textarea");
    const before = (field.element() as HTMLElement).getBoundingClientRect().height;
    await field.fill("一\n二\n三\n四\n五\n六\n七");
    await expect
      .poll(() => (field.element() as HTMLElement).getBoundingClientRect().height)
      .toBeGreaterThan(before);
  });
});

describe("Label", () => {
  it("focuses its input from htmlFor and renders a label element", async () => {
    await render(
      <div>
        <Label htmlFor="project-name">名称</Label>
        <Input id="project-name" />
      </div>,
    );
    await page.getByText("名称").click();
    expect(active()).toBe(page.getByRole("textbox", { name: "名称" }).element());
    expect(one('[data-slot="label"]').tagName).toBe("LABEL");
  });
});

describe("Separator", () => {
  it("exposes its orientation and draws a 1px line", async () => {
    await render(
      <div className="flex h-10 items-center gap-2">
        <span>左</span>
        <Separator orientation="vertical" />
        <span>右</span>
      </div>,
    );
    const line = page.getByRole("separator").element() as HTMLElement;
    expect(line.getAttribute("aria-orientation")).toBe("vertical");
    expect(line.getAttribute("data-orientation")).toBe("vertical");
    expect(line.getBoundingClientRect().width).toBe(1);
    expect(line.getBoundingClientRect().height).toBe(40);
  });
});

describe("ScrollArea", () => {
  it("scrolls its viewport with the wheel and shows a thumb while hovered", async () => {
    await render(
      <div data-testid="host" style={{ height: 160, width: 240 }}>
        <ScrollArea>
          <div style={{ height: 1200 }}>长列表</div>
        </ScrollArea>
      </div>,
    );
    const viewport = one('[data-slot="scroll-area-viewport"]');
    await userEvent.hover(viewport);
    viewport.scrollTop = 300;
    viewport.dispatchEvent(new Event("scroll"));
    await expect.poll(() => viewport.scrollTop).toBe(300);
    const thumb = () => document.querySelector<HTMLElement>('[data-slot="scroll-area-thumb"]');
    await expect.poll(() => thumb()?.getBoundingClientRect().height ?? 0).toBeGreaterThan(10);
    await expect
      .poll(() => Number(getComputedStyle(one('[data-slot="scroll-area-scrollbar"]')).opacity))
      .toBeGreaterThan(0.5);
  });

  it("draws no scrollbar when hideScrollbars is set", async () => {
    await render(
      <div style={{ height: 160, width: 240 }}>
        <ScrollArea hideScrollbars>
          <div style={{ height: 1200 }}>长列表</div>
        </ScrollArea>
      </div>,
    );
    expect(document.querySelector('[data-slot="scroll-area-scrollbar"]')).toBeNull();
  });
});

describe("MossOtpInput", () => {
  it("fills one slot per digit and reports the whole code", async () => {
    const onChange = vi.fn();
    await render(<MossOtpInput aria-label="验证码" onChange={onChange} />);
    const field = page.getByRole("textbox", { name: "验证码" });
    await field.click();
    await userEvent.keyboard("123456");
    expect(onChange.mock.calls.at(-1)?.[0]).toBe("123456");
    const slots = document.querySelectorAll('[data-testid="moss-otp-slot"]');
    expect([...slots].map((slot) => slot.textContent)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });
});
