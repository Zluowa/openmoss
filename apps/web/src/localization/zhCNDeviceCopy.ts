// FILE: zhCNDeviceCopy.ts
// Purpose: Simplified Chinese for the iOS Simulator panel: picker, controls, setup and toasts.
// Layer: Pure localization data
// Device names, runtimes and Xcode versions pass through the patterns untouched. Setup commands
// such as `xcodebuild -license accept` stay literal because they are never in this table.

import { lookupPhrase, phraseTranslator } from "./zhCNPhraseTable";

const DEVICE_COPY: Readonly<Record<string, string>> = {
  // Picker and states
  "iOS Simulator": "iOS 模拟器",
  "Choose a simulator": "选择模拟器",
  "No simulators found": "未找到模拟器",
  "Choose a simulator to start streaming it here.": "选择模拟器，即可在这里显示它的画面。",
  "Xcode is a free download from Apple and needs about 10 GB of disk space.":
    "Xcode 可从 Apple 免费下载，需要约 10 GB 磁盘空间。",
  "Shut down": "关机",
  Booting: "正在启动",
  Booted: "已启动",
  "Shutting down": "正在关机",
  "Anything running on the simulator closes. Booting it again takes about a minute.":
    "模拟器上运行的所有内容都会关闭。再次启动大约需要一分钟。",
  "This browser cannot decode the simulator stream. Chrome, Edge, or Safari 17+ support the WebCodecs video decoder Moss uses.":
    "此浏览器无法解码模拟器画面。Chrome、Edge 或 Safari 17 及以上版本支持 Moss 使用的 WebCodecs 视频解码器。",
  "Keep them all running": "让它们继续运行",

  // Controls
  "Home ⌘⇧H": "主页 ⌘⇧H",
  "Rotate view": "旋转视图",
  "Save screenshot": "保存截图",
  "Record video": "录制视频",
  "Shut down simulator": "关闭模拟器",
  "Detach simulator": "断开模拟器",
  "Volume up": "音量加",
  "Volume down": "音量减",
  Lock: "锁定",

  // Setup
  "Setup steps": "设置步骤",
  "Set up the iOS Simulator": "设置 iOS 模拟器",
  "Progress updates automatically as each step finishes.": "每完成一步，进度都会自动更新。",
  "iOS Simulator needs macOS": "iOS 模拟器需要 macOS",
  "Simulator helper could not start": "模拟器助手无法启动",
  "Open Mac App Store": "打开 Mac App Store",
  "Checking for Xcode…": "正在检查 Xcode…",
  "Checking your setup…": "正在检查你的设置…",
  "Install Xcode": "安装 Xcode",
  "Install Xcode from the App Store, then open it once.": "从 App Store 安装 Xcode，然后打开一次。",
  "Point the command line tools at Xcode": "把命令行工具指向 Xcode",
  "Accept the Xcode license": "接受 Xcode 许可协议",
  "Install an iOS simulator runtime": "安装 iOS 模拟器运行时",
  "Build the Moss device helper": "构建 Moss 设备助手",
  "Built automatically the first time you attach a device.": "第一次连接设备时会自动构建。",

  // Toasts and stream errors
  "The simulator did not respond.": "模拟器没有响应。",
  "Could not open that simulator": "无法打开那个模拟器",
  "Could not free a simulator slot": "无法腾出模拟器名额",
  "Could not detach the simulator": "无法断开模拟器",
  "Could not shut down the simulator": "无法关闭模拟器",
  "Could not press that button": "无法按下那个按钮",
  "The simulator did not start recording.": "模拟器没有开始录制。",
  "Recording saved": "录制内容已保存",
  "Could not stop recording": "无法停止录制",
  "The recording may be incomplete.": "录制内容可能不完整。",
  "Screenshot saved": "截图已保存",
  "Could not save the screenshot": "无法保存截图",
  "The simulator did not accept that input": "模拟器没有接受这次输入",
  "The input could not be delivered.": "无法传送这次输入。",
  "The simulator stream sent parameters Moss could not read.":
    "模拟器画面发来了 Moss 无法读取的参数。",
  "The video decoder failed.": "视频解码器出错。",
  "The video decoder could not be configured.": "无法配置视频解码器。",
  "A video frame could not be decoded.": "无法解码视频帧。",
  "The simulator stream sent a frame Moss could not read.": "模拟器画面发来了 Moss 无法读取的帧。",
  "The simulator stream disconnected.": "模拟器画面已断开。",
};

const DEVICE_CAPABILITY: Readonly<Record<string, string>> = {
  "screen capture": "屏幕截取",
  "touch and keyboard input": "触控和键盘输入",
  "accessibility inspection": "辅助功能检查",
  "video encoding": "视频编码",
};
const CAPABILITY = Object.keys(DEVICE_CAPABILITY).join("|");
const CAPABILITY_LIST = `(?:${CAPABILITY})(?:, (?:${CAPABILITY}))*(?: and (?:${CAPABILITY}))?`;

function zhCnCapabilityList(list: string): string {
  return (list.toLowerCase().match(new RegExp(CAPABILITY, "g")) ?? [])
    .map((capability) => lookupPhrase(DEVICE_CAPABILITY, capability) ?? capability)
    .join("、");
}

const DEGRADED_NOTICE = new RegExp(
  `^(${CAPABILITY_LIST}) unavailable(?: with Xcode(?: build)? (\\S+))?(?: — (${CAPABILITY_LIST}) unaffected)?\\.$`,
  "i",
);

export const translateZhCnDeviceCopyText = phraseTranslator(DEVICE_COPY, [
  [
    DEGRADED_NOTICE,
    ({ 1: broken = "", 2: xcode, 3: working }) => {
      const onXcode = xcode ? `（Xcode ${xcode}）` : "";
      const unaffected = working ? `，${zhCnCapabilityList(working)}不受影响` : "";
      return `${zhCnCapabilityList(broken)}不可用${onXcode}${unaffected}。`;
    },
  ],
  [
    /^This Moss server runs on (.+)\. Simulators are only available when the server runs on a Mac with Xcode installed\.$/,
    "这台 Moss 服务器运行在 $1 上。只有当服务器运行在装有 Xcode 的 Mac 上时才能使用模拟器。",
  ],
  [/^Shut down this simulator\?$/, "关闭这个模拟器？"],
  [/^Shut down (.+)\?$/, "关闭 $1？"],
  // The boot-limit dialog says "that simulator" until it knows the device's name.
  [/^Shut down a simulator to start that simulator$/, "关闭一个模拟器以启动那个模拟器"],
  [/^Shut down a simulator to start (.+)$/, "关闭一个模拟器以启动 $1"],
  [
    /^Moss keeps at most (\d+) simulators running at once, because each one holds a few gigabytes of memory\. Pick one to shut down — anything running on it closes — and (.+) starts in its place\.$/,
    ({ 1: limit, 2: device = "" }) =>
      `Moss 最多同时运行 ${limit} 个模拟器，因为每个都会占用几 GB 内存。请选择一个关闭（上面运行的所有内容都会关闭），${device === "that simulator" ? "那个模拟器" : `${device} `}会在它的位置启动。`,
  ],
  [/^Shut down (.+)$/, "关闭 $1"],
  [/^((?:iPhone|iPad|Apple)\b.*) screen$/, "$1 屏幕"],
]);
