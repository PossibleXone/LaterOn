const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

assert.ok(manifest.action, "manifest 必须保留工具栏 action");
assert.strictEqual(manifest.action.default_popup, undefined, "工具栏图标不能再绑定缩略图 popup");
assert.strictEqual(manifest.side_panel?.default_path, "sidepanel.html", "侧栏入口必须指向真实侧栏页面");
assert.match(
  background,
  /setPanelBehavior\(\{\s*openPanelOnActionClick:\s*true\s*\}\)/,
  "后台必须启用点击图标打开侧栏"
);
assert.match(background, /setupSidePanelAction\(\);[\s\S]*onInstalled/);
assert.match(background, /onInstalled[\s\S]*setupSidePanelAction\(\)/);
assert.match(background, /onStartup[\s\S]*setupSidePanelAction\(\)/);

console.log("PASS Chrome / Edge 工具栏图标统一直接打开侧栏");

// ── 侧栏「添加」在设置打开「先选项目」时的选项目浮层 ──────────────
// 这几条是静态约束，用来钉住这次改动的关键设计：浮层弹在侧栏内部、按需加载，
// 而且后台那条新链路绝不能反过来再去网页里注入一个浮层。
const sidepanel = fs.readFileSync(path.join(ROOT, "sidepanel.js"), "utf8");
const theme = fs.readFileSync(path.join(ROOT, "theme.js"), "utf8");
const pickerUi = fs.readFileSync(path.join(ROOT, "picker-ui.js"), "utf8");

assert.match(sidepanel, /function ensurePickerLoaded\(/, "选项目浮层必须按需加载，不能拖慢侧栏冷启动");
assert.match(sidepanel, /script\.src\s*=\s*"picker-ui\.js"/, "按需加载的必须是共享的 picker-ui.js");
assert.match(sidepanel, /askFolderOnSingle\s*===\s*true/, "侧栏要跟随「先选项目」开关，不能无条件弹浮层");
assert.match(sidepanel, /type:\s*"SAVE_TAB_TO_PROJECT"/, "选好项目后要走 SAVE_TAB_TO_PROJECT 写入指定项目");
assert.match(sidepanel, /anchor:\s*saveButton/, "浮层必须锚在「添加」按钮上（popover 模式），而不是整屏弹窗");
assert.match(sidepanel, /intent:\s*"save"/, "侧栏是「添加」不是「移动」，必须传 intent 让浮层换措辞");

// 开关关闭时必须原样保留老行为：直接交给后台的 QUICK_SAVE_TAB。
assert.match(sidepanel, /type:\s*"QUICK_SAVE_TAB"/, "开关关闭时仍走原有的 QUICK_SAVE_TAB 链路");

const saveToProjectBranch = /message\.type === "SAVE_TAB_TO_PROJECT"([\s\S]*?)\n  \}\n\}\);/.exec(background);
assert.ok(saveToProjectBranch, "后台必须有 SAVE_TAB_TO_PROJECT 分支");
assert.doesNotMatch(
  saveToProjectBranch[1],
  /showPickerOverlay|PENDING_KEY|askFolderThenSave/,
  "SAVE_TAB_TO_PROJECT 不能触发网页内浮层，也不能写批量收藏的待确认批次"
);
assert.match(background, /async function upsertItemForProject\(/, "落库语义要抽成共用助手，避免两处各写一份");
assert.match(background, /upsertItemForProject\(meta, projectId, \{ savedAt: base - i, afterId: previousAddedId \}\)/,
  "整窗收藏也必须改用同一个助手，两条路径的落库语义才一致");

// picker-ui 的措辞原本跟着「是不是贴按钮的浮层」走，默认说「移动到…」。
// 侧栏要的是「贴按钮 + 添加措辞」，所以必须有独立的 intent 开关。
assert.match(pickerUi, /const intent = data\.intent === "save"/, "picker-ui 要支持 intent 参数解耦措辞与形态");
assert.match(pickerUi, /intent === "save" \? copy\.saveTo\(selectedName\(\)\) : copy\.moveTo\(selectedName\(\)\)/,
  "确认按钮文案必须按 intent 而不是按形态来选");

assert.match(theme, /askFolderOnSingle:\s*false/, "默认值必须保持关闭，行为和 Alt+1 一致");

console.log("PASS 侧栏「添加」先选项目：浮层在侧栏内、按需加载、后台不重复注入网页浮层");
