// 后台冷启动体积回归：网页内执行的大函数必须留在独立文件里，不能重新塞回 service worker。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const background = read("background.js");
const metadata = read("content-metadata.js");
const translation = read("content-translation.js");
const picker = read("content-folder-picker.js");

// 上限从 80000 放宽到 84000：侧栏「先选项目再添加」需要在后台加一条消息分支
// （SAVE_TAB_TO_PROJECT）和共用的落库助手。那属于消息处理与写库，本来就该待在
// service worker 里，不是这条守卫针对的「网页内执行的大函数」。
// 真正要守住的仍然是下面几条：注入用的函数必须留在独立文件，不能塞回后台。
assert.ok(Buffer.byteLength(background) < 84000, `background.js 重新膨胀到 ${Buffer.byteLength(background)} bytes`);
assert.ok(!background.includes("function extractPageMetadataForShortcut"), "网页提取函数不应在后台冷启动时解析");
assert.ok(!background.includes("function togglePageTranslation"), "翻译函数不应在后台冷启动时解析");
assert.ok(!background.includes("function showFolderPickerOverlay"), "批量选择浮层不应在后台冷启动时解析");

assert.ok(metadata.includes("function extractPageMetadataForShortcut"));
assert.ok(translation.includes("function togglePageTranslation"));
assert.ok(picker.includes("function showFolderPickerOverlay"));
assert.match(background, /files:\s*\["content-metadata\.js"\]/);
assert.match(background, /files:\s*\["content-translation\.js"\]/);
assert.match(background, /files:\s*\["picker-ui\.js",\s*"content-folder-picker\.js"\]/);
assert.match(picker, /function safeRuntimeMessage\(message\)/);
assert.match(picker, /try \{ return Promise\.resolve\(chrome\.runtime\.sendMessage\(message\)\)\.catch\(\(\) => null\); \}\s*catch \{ return Promise\.resolve\(null\); \}/);

console.log("PASS background 模块按需注入，冷启动脚本", Buffer.byteLength(background), "bytes");
