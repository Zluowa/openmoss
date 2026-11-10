// FILE: mossImagesDiscoveryCatalog.ts
// Purpose: Moss original image inspiration, prompts and owned preview assets.
// Layer: Image discovery catalog
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
const preview = (id: string) => `/images/templates/${id}.webp`;
const templates: readonly [string, string, string, string, boolean?][] = [
  [
    "poster",
    "海报",
    "把一个想法变成醒目的海报。",
    "设计一张原创植物海报：象牙白纸张上绘制山茶花与枝叶，搭配清晰的 GARDEN NOTES 衬线标题，细腻印刷纹理，留白克制而均衡，不添加水印或署名。",
  ],
  [
    "interior",
    "室内设计",
    "探索房间的布局、材质和光线。",
    "创建一间阳光充足的创意工作室等距剖面图：浅橡木地板、拱形高窗、橄榄绿亚麻沙发、铁锈色扶手椅、绘图桌与大型绿植，暖白灰泥墙和浅杏色背景，柔和日光与细腻立体材质。",
  ],
  [
    "logo",
    "徽标",
    "为品牌设计一个简洁鲜明的标志。",
    "设计一个原创几何徽标：圆角菱形中包含山谷与初升太阳，暖铜色和象牙白图形配深午夜青背景，轮廓利落，负空间均衡，图形居中并留出呼吸空间，不添加文字。",
  ],
  [
    "illustration",
    "插画",
    "让人物与故事拥有独特的画面。",
    "创作一幅温暖的水粉与彩铅插画：穿钴蓝毛衣的年轻女子坐在赤陶色弧形长椅上读书，身旁有小白鸟，头顶是结满黄色柠檬的树，深绿叶片与奶油白背景，柔和纸张纹理。",
  ],
  [
    "headshot",
    "职业形象照",
    "以你的照片创作自然的职业肖像。",
    "以参考照片中的人物为主体，保留本人真实面部特征，创作自然专业的半身职业肖像：藏青色外套搭配米白上衣、暖灰摄影棚背景、柔和窗光、自然神态和真实肤质。保持参考人物的眼镜等识别特征，不替换成预览中的虚构人物。",
    true,
  ],
  [
    "icons",
    "图标",
    "创建一组风格一致的图标。",
    "设计一组四枚风格统一的立体旅行图标，整齐排列为二乘二网格：青绿色旅行箱、珊瑚色指南针、象牙白相机、白云后的黄色太阳。浅蓝背景，圆润黏土质感与细腻投影，不添加文字。",
  ],
  [
    "product",
    "产品照",
    "为产品设置光线与拍摄场景。",
    "拍摄一组精致茶具产品照：钴蓝釉面陶瓷茶壶搭配小茶碗，放置在奶油色石台上，暖黄色背景，一枝白色梅花从画面侧边伸入。使用优雅侧光，呈现真实釉面、材质和自然阴影。",
  ],
  [
    "merch",
    "周边商品",
    "把图案呈现在你喜爱的商品上。",
    "制作原创周边商品效果图：厚实的象牙白帆布托特包挂在橡木挂钩上，浅暖灰石膏墙背景。包身印有海军蓝与珊瑚色的抽象日出和海浪图案，无文字，呈现细腻棉布纹理与自然阳光。",
  ],
  [
    "infographic",
    "信息图",
    "把复杂的内容变成易读的画面。",
    "创作一张解释种子发芽的信息图：在连续的土壤剖面上从左至右展示豆子发芽至长出绿叶的四个阶段，地下根系清楚可见，顶部有太阳和水滴，阶段之间用简洁箭头连接。奶油白背景，鼠尾草绿与金黄色的立体纸艺插画，无文字。",
  ],
  [
    "flyer",
    "宣传单",
    "用鲜明的版式传递活动与消息。",
    "设计一张虚构爵士活动的原创宣传单：午夜蓝纸张，象牙白大标题 AFTER HOURS 和小字 JAZZ CLUB，搭配金色小号、珊瑚红圆形与层叠纸片图形。排版清晰有节奏，不添加真实场馆或地址。",
  ],
  [
    "book",
    "书籍封面",
    "为一本书设计完整的视觉封面。",
    "创作一本森林绿布面精装书的三分之四角度产品照：封面书名 NIGHT GARDENS，金色衬线排版，原创植物枝叶与弯月压纹，呈现精致烫金和布面细节，象牙白桌面、柔和鼠尾草绿背景。",
  ],
  [
    "app",
    "应用效果图",
    "将应用想法变成可见的界面。",
    "设计一款原创专注计时器手机应用效果图：正面单台手机，奶油白界面，标题 Focus，珊瑚色圆形进度环和清晰的 25:00，深蓝文字、简洁播放按钮和三个小进度点，浅蓝背景，间距自然精确。",
  ],
  [
    "packaging",
    "包装",
    "让包装的材质和品牌形象更鲜明。",
    "设计虚构乌龙茶品牌 MIST 的包装效果图：两只长方形纸盒搭配小茶罐，象牙白哑光纸张，原创深青色山形与铜色小太阳，大字 MIST 和小字 OOLONG TEA，暖沙色背景、亚麻布与柔和侧光。",
  ],
  [
    "advert",
    "广告",
    "为一个品牌设计吸引人的广告。",
    "为虚构柑橘汽水 SUNNY 制作原创广告：橙色铝罐放在橘色小台上，细腻冷凝水珠与悬浮的鲜橙切片，钴蓝背景和明亮日光。奶油白标题 A LITTLE SUNSHINE，构图简洁鲜明。",
  ],
  [
    "thumbnail",
    "缩略图",
    "为视频制作一眼可识别的封面。",
    "设计一张原创陶艺周末视频封面：虚构年轻女子穿浅蓝围裙，在阳光充足的陶艺工作室桌旁展示刚制作的陶杯，背景陶器和工具自然虚化，清晰奶油白大字 POTTERY WEEKEND，画面温暖明亮。",
  ],
  [
    "website",
    "网站效果图",
    "探索网站的内容与视觉排版。",
    "设计虚构植物设计工作室 FERN STUDIO 的原创网站效果图：象牙白背景、深绿字体，导航 Work、About、Contact，主视觉为赤陶器皿与自然绿枝，搭配大号衬线标题 A slower kind of beauty，双栏编辑式布局与充足留白。",
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
    title: "手绘水粉",
    description: "温暖水粉色块与细腻彩铅、纸张纹理。",
    promptSuffix: "使用温暖的手绘水粉与彩铅风格，柔和色块、细腻线条和自然纸张纹理。",
    requiresReference: false,
    previewUrl: preview("illustration"),
  },
  {
    id: "geometric-paper",
    title: "立体空间",
    description: "柔和黏土材质、立体空间与自然日光。",
    promptSuffix: "使用精致的黏土质感三维插画风格，柔和日光、清晰空间结构与细腻自然阴影。",
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
