/** Public template previews observed in the installed Codex Images gallery. */
export interface MossImageTemplate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly requiresReference: boolean;
  readonly previewUrl: string;
}
export interface MossImageStyle {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly promptSuffix: string;
  readonly requiresReference: boolean;
  readonly previewUrl: string;
}
const preview = (id: string) => `/images/templates/${id}.png`;
const templates: readonly [string, string, string, string, boolean?][] = [
  [
    "poster",
    "海报",
    "把一个想法变成醒目的海报。",
    "设计一张花卉海报：橙色背景，奶油色卡片，一朵红色罂粟花，顶部大号衬线字 BLOOM。清晰的文字，简洁均衡的版式。",
  ],
  [
    "interior",
    "室内设计",
    "探索房间的布局、材质和光线。",
    "创建一个温暖现代的等距室内设计图：粉色背景，木地板，明亮窗户，米白色沙发，绿植与柔和阳光。",
  ],
  [
    "logo",
    "徽标",
    "为品牌设计一个简洁鲜明的标志。",
    "设计一个海蓝色圆形徽标，中心是线条简洁的鱼，奶油色细线，几何轮廓，平面矢量风格，不添加文字。",
  ],
  [
    "illustration",
    "插画",
    "让人物与故事拥有独特的画面。",
    "创建一幅温暖的手绘插画：一个穿黄色毛衣的人坐着拥抱一只黑白猫，淡紫色背景，柔和线条与自然细节。",
  ],
  [
    "headshot",
    "职业形象照",
    "以你的照片创作自然的职业肖像。",
    "以参考照片中的人物为主体，保留真实面部特征，创建自然专业的职业形象照，柔和棚拍光，浅灰背景，简洁衣着。",
    true,
  ],
  [
    "icons",
    "图标",
    "创建一组风格一致的图标。",
    "设计四个奶油色图标：手势、流星、青蛙和行星，深青色背景，圆润简洁的线条，整齐排列，统一视觉风格。",
  ],
  [
    "product",
    "产品照",
    "为产品设置光线与拍摄场景。",
    "拍摄一只粉色玻璃香薰蜡烛，淡粉色背景与桌面，柔和侧光，清晰玻璃纹理，自然阴影，简洁的产品摄影。",
  ],
  [
    "merch",
    "周边商品",
    "把图案呈现在你喜爱的商品上。",
    "展示一件晾在衣绳上的白色 T 恤，蓝色天空背景，衣服中心印有可爱的绿色青蛙唱片图案，自然光，逼真的布料纹理。",
  ],
  [
    "infographic",
    "信息图",
    "把复杂的内容变成易读的画面。",
    "创建一张解释降雨循环的信息图：浅蓝背景，立体白云、蓝色雨滴、红蓝方向箭头，清晰直观的构图，简洁教育插画。",
  ],
  [
    "flyer",
    "宣传单",
    "用鲜明的版式传递活动与消息。",
    "设计一张创意寻蛙宣传单：黑灰背景，复古印刷纸，中心青蛙照片，标题 LOST FROG，清晰的黑白排版与趣味感。",
  ],
  [
    "book",
    "书籍封面",
    "为一本书设计完整的视觉封面。",
    "创建一本绿色硬壳书的产品照，书名 THE SUNDAY DRAWER，金色衬线排版与安静的日常插画，蓝色背景，侧面柔光。",
  ],
  [
    "app",
    "应用效果图",
    "将应用想法变成可见的界面。",
    "设计一个音乐应用的手机界面效果图，荧光黄绿与粉紫渐变，抽象专辑封面，清晰的播放控制，简洁现代的布局。",
  ],
  [
    "packaging",
    "包装",
    "让包装的材质和品牌形象更鲜明。",
    "创建一个茶叶纸盒包装效果图，奶油色纸张，大号 LEAF 字样，绿色叶片和橙色圆形图案，温暖背景，逼真的纸质纹理。",
  ],
  [
    "advert",
    "广告",
    "为一个品牌设计吸引人的广告。",
    "设计一张粉色护肤品广告：粉色瓶子，手拿产品，明亮粉色背景，红色 Shop now! 字样，大胆简洁的构图。",
  ],
  [
    "thumbnail",
    "缩略图",
    "为视频制作一眼可识别的封面。",
    "设计一张日常视频缩略图，一个人在明亮咖啡馆中，清晰大号白字 one day in my life，淡绿色背景，温暖自然的画面。",
  ],
  [
    "website",
    "网站效果图",
    "探索网站的内容与视觉排版。",
    "设计一个陶艺工作室网站效果图，品牌 Red Kiln，陶土色主视觉，米白背景，陶瓷花瓶与碗，简洁导航和精致的编辑式布局。",
  ],
];
export const MOSS_IMAGE_TEMPLATES: readonly MossImageTemplate[] = templates.map(
  ([id, title, description, prompt, requiresReference]) => ({
    id,
    title,
    description,
    prompt,
    requiresReference: requiresReference === true,
    previewUrl: preview(id),
  }),
);
export const MOSS_IMAGE_STYLES: readonly MossImageStyle[] = [
  {
    id: "soft-watercolor",
    title: "柔和水彩",
    description: "轻薄的颜色叠加与自然纸张纹理。",
    promptSuffix: "使用柔和水彩风格，轻薄的颜色叠加与自然纸张纹理。",
    requiresReference: false,
    previewUrl: preview("illustration"),
  },
  {
    id: "geometric-paper",
    title: "几何纸艺",
    description: "清晰色块与层叠纸片的轻微阴影。",
    promptSuffix: "使用几何纸艺风格，清晰色块、层叠纸片和轻微的自然阴影。",
    requiresReference: false,
    previewUrl: preview("interior"),
  },
  {
    id: "subject-studio",
    title: "主体棚拍",
    description: "保留参考主体，使用柔和棚拍光线。",
    promptSuffix: "保留参考图中主体的形状和主要颜色，使用简洁背景与柔和棚拍光线。",
    requiresReference: true,
    previewUrl: preview("headshot"),
  },
];
