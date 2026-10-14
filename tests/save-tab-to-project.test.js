// 模拟验证：侧栏「添加」在设置打开「先选项目」时走的新链路（SAVE_TAB_TO_PROJECT）——
// 把当前标签页直接写进用户选定的项目。
//
// 这条链路存在的意义：以前侧栏「添加」只能收进「等待整理」，想指定项目就得让后台
// 往网页里注入一个浮层（quickSave → askFolderThenSave）。现在选项目改在侧栏自己的
// 浮层里完成，后台只需要负责「写进这个项目」。所以这里重点验三件事：
//  1) 能写进指定项目，并记住「上次用过的项目」；
//  2) 网址已经收过时不复制第二条，而是把已有那条「搬家」过去（和整窗收藏同一套语义）；
//  3) 这条链路绝不触发网页内的选项目浮层，也不写批量收藏的待确认批次。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");
const { URL } = require("url");

const SOURCE = path.resolve(__dirname, "..", "background.js");
const src = fs.readFileSync(SOURCE, "utf8");

const PENDING_KEY = "laterOnPendingBatch";
const LAST_PROJECT_KEY = "laterOnLastProjectId";
const FOLDER_ID = "folder-rl";
const OTHER_FOLDER_ID = "folder-work";
const PAGE_URL = "https://zhuanlan.zhihu.com/p/123";
const DUP_URL = "https://dup.com/old";
const FRESH_URL = "https://fresh.example.com/a";
const FRESH_URL_2 = "https://fresh.example.com/b";
const PROTECTED_URL = "chrome://settings";

function makeTab(id, url, title) {
  return {
    id,
    url,
    title,
    favIconUrl: `${url.startsWith("http") ? new URL(url).origin : "chrome://settings"}/favicon.ico`,
    windowId: 1,
    active: true,
    status: "complete"
  };
}

const tab = makeTab(1, PAGE_URL, "Diffusion Model + RL 前沿进展");
const protectedTab = makeTab(2, PROTECTED_URL, "设置");
const dupTab = makeTab(3, DUP_URL, "早就收藏过的一篇");
const freshTab = makeTab(4, FRESH_URL, "全新的一篇");
const freshTab2 = makeTab(5, FRESH_URL_2, "另一篇全新的");

const tabsById = new Map([[1, tab], [2, protectedTab], [3, dupTab], [4, freshTab], [5, freshTab2]]);
// 不带 tabId 时后台会去查「当前活动标签页」；测试里可以换掉它来验这条回落分支。
let activeTabForQuery = tab;

const store = {
  laterOnItems: [
    {
      id: "old-1", title: "早就收藏过的一篇", description: "暂无摘要", image: "", favicon: "",
      source: "dup.com", projectId: OTHER_FOLDER_ID, url: DUP_URL, savedAt: 1, status: "unread"
    }
  ],
  laterOnProjects: [
    { id: FOLDER_ID, name: "Diffusion Model + RL", createdAt: 1 },
    { id: OTHER_FOLDER_ID, name: "工作", createdAt: 1 }
  ],
  laterOnSettings: {}
};
const session = {};

const pills = [];
const overlays = [];
const windowsCreated = [];
const bus = {};

const chrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: store[keys] };
        if (Array.isArray(keys)) {
          const out = {};
          keys.forEach((k) => { out[k] = store[k]; });
          return out;
        }
        return { ...store };
      },
      async set(obj) { Object.assign(store, obj); },
      async remove(key) { delete store[key]; }
    },
    session: {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: session[keys] };
        return { ...session };
      },
      async set(obj) { Object.assign(session, obj); },
      async remove(key) { delete session[key]; }
    },
    onChanged: { addListener() {} }
  },
  tabs: {
    query: () => Promise.resolve([activeTabForQuery]),
    get: (id) => (tabsById.has(id) ? Promise.resolve(tabsById.get(id)) : Promise.reject(new Error("no tab"))),
    update: async () => {},
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
    onCreated: { addListener() {} }
  },
  windows: {
    get: async () => ({ left: 0, top: 0, width: 1440, height: 900 }),
    create: async (options) => { windowsCreated.push(options); return { id: 99 }; },
    remove: async () => {},
    update: async () => {}
  },
  scripting: {
    insertCSS: async () => {},
    executeScript(options) {
      const tabId = options.target?.tabId;
      // 网页内选项目浮层：这条链路一次都不该走到这里。走到就说明又去注入网页浮层了。
      if (options.files?.includes("content-folder-picker.js")) {
        overlays.push({ tabId, payload: options.args?.[0] });
        return Promise.resolve([{ result: undefined }]);
      }
      if (typeof options.func === "function" && String(options.func).includes("lateron-folder-picker")) {
        return Promise.resolve([{ result: true }]);
      }
      // 页内药丸提示：侧栏场景的反馈由侧栏自己给，这里也不该出现。
      if (Array.isArray(options.args?.[0])) {
        pills.push({ tabId, items: options.args[0] });
        return Promise.resolve([{ result: undefined }]);
      }
      if (!options.files?.includes("content-metadata.js")) return Promise.resolve([{ result: undefined }]);
      const target = tabsById.get(tabId);
      if (!target) return Promise.resolve([{ result: null }]);
      return Promise.resolve([{
        result: {
          title: target.title,
          description: `这是 ${target.title} 的摘要`,
          image: `https://img.example.com/${tabId}.jpg`,
          favicon: target.favIconUrl,
          source: target.url.startsWith("http") ? new URL(target.url).hostname : "chrome",
          url: target.url,
          titleFrom: "meta-title",
          imageFrom: "share"
        }
      }]);
    }
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  contextMenus: { removeAll: (cb) => cb && cb(), create() {}, onClicked: { addListener() {} } },
  runtime: {
    getURL: (path) => `chrome-extension://lateron/${path}`,
    sendMessage: async () => undefined,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { bus.listener = fn; } }
  },
  commands: { onCommand: { addListener() {} } }
};

function send(message) {
  return new Promise((resolve) => {
    const kept = bus.listener(message, { tab: { id: 1 } }, resolve);
    if (!kept) resolve(undefined);
  });
}

const sandbox = {
  chrome, crypto: webcrypto, URL, setTimeout, clearTimeout, console, Date, Promise, JSON, Set, Map,
  importScripts() {},
  LaterOnUrl: {
    normalize(value) {
      try { const url = new URL(value); url.hash = ""; return url.href.replace(/\/$/, ""); }
      catch { return String(value || ""); }
    }
  }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "background.js" });

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};

(async () => {
  // ── 第 1 步：把一篇新网页写进指定项目 ────────────────────────
  console.log("── 第 1 步：写进指定项目 ──");
  const res = await send({ type: "SAVE_TAB_TO_PROJECT", projectId: FOLDER_ID, tabId: 1, source: "panel" });
  check("返回成功", res?.ok === true, JSON.stringify(res));
  const saved = store.laterOnItems.find((entry) => entry.url === PAGE_URL);
  check("这一篇被收藏了", !!saved, saved ? saved.title : "没找到");
  check("落在用户选的项目里（不是等待整理）", saved?.projectId === FOLDER_ID, `projectId=${JSON.stringify(saved?.projectId)}`);
  check("回传了写入的那条记录，侧栏才能立刻高亮", res?.item?.id === saved?.id, `${res?.item?.id} / ${saved?.id}`);
  check("回传项目名，方便侧栏提示", res?.projectName === "Diffusion Model + RL", String(res?.projectName));
  check("记住了「上次用过的项目」", store[LAST_PROJECT_KEY] === FOLDER_ID, String(store[LAST_PROJECT_KEY]));

  // 这三条是这次改动的核心约束：侧栏自己弹浮层，后台就不能再弹一遍。
  check("没有注入网页内选项目浮层", overlays.length === 0, `浮层 ${overlays.length}`);
  check("没有写批量收藏的待确认批次", session[PENDING_KEY] === undefined, JSON.stringify(session[PENDING_KEY] ?? null));
  check("没有弹页内药丸提示", pills.length === 0, `药丸 ${pills.length}`);
  check("没有开任何独立窗口", windowsCreated.length === 0, `窗口 ${windowsCreated.length}`);

  // ── 第 2 步：网址已经收过 → 搬家，不复制第二条 ────────────────
  console.log("\n── 第 2 步：已收藏过的网址改归属 ──");
  const dupBefore = store.laterOnItems.filter((entry) => entry.url === DUP_URL).length;
  const res2 = await send({ type: "SAVE_TAB_TO_PROJECT", projectId: FOLDER_ID, tabId: 3, source: "panel" });
  const dupAfter = store.laterOnItems.filter((entry) => entry.url === DUP_URL);
  check("没有复制出第二条", dupAfter.length === dupBefore && dupAfter.length === 1, `${dupAfter.length} 条`);
  check("已有那条被搬进所选项目", dupAfter[0]?.projectId === FOLDER_ID, `projectId=${JSON.stringify(dupAfter[0]?.projectId)}`);
  check("结果里说明是「搬家」而不是新增", res2?.moved === true && res2?.duplicated === true, JSON.stringify(res2));
  check("搬家时不虚报新增数量", res2?.added === 0, `added=${res2?.added}`);

  // ── 第 3 步：项目在浮层打开期间被删掉 → 回落等待整理 ──────────
  console.log("\n── 第 3 步：目标项目已经不存在 ──");
  const res3 = await send({ type: "SAVE_TAB_TO_PROJECT", projectId: "早就删掉的项目", tabId: 4, source: "panel" });
  const fresh = store.laterOnItems.find((entry) => entry.url === FRESH_URL);
  check("仍然收藏成功，不留悬空归属", !!fresh && (fresh.projectId || null) === null, `projectId=${JSON.stringify(fresh?.projectId)}`);
  check("回落到「等待整理」", res3?.projectName === "等待整理", String(res3?.projectName));
  check("响应里的 projectId 是 null", res3?.projectId === null, String(res3?.projectId));
  check("不会把已删项目记成「上次用过的项目」", store[LAST_PROJECT_KEY] !== "早就删掉的项目", String(store[LAST_PROJECT_KEY]));

  // ── 第 4 步：不带 tabId → 用当前活动标签页 ────────────────────
  console.log("\n── 第 4 步：不带 tabId 时回落到活动标签页 ──");
  activeTabForQuery = freshTab2;
  const res4 = await send({ type: "SAVE_TAB_TO_PROJECT", projectId: FOLDER_ID, source: "panel" });
  const viaActive = store.laterOnItems.find((entry) => entry.url === FRESH_URL_2);
  check("收藏的是当前活动标签页", !!viaActive, viaActive ? viaActive.title : "没找到");
  check("同样落在所选项目里", viaActive?.projectId === FOLDER_ID, `projectId=${JSON.stringify(viaActive?.projectId)}`);
  check("返回成功", res4?.ok === true, JSON.stringify(res4));

  // ── 第 5 步：受保护页面 / 标签页已关闭 ────────────────────────
  console.log("\n── 第 5 步：不能收藏的情况 ──");
  const countBefore = store.laterOnItems.length;
  const res5 = await send({ type: "SAVE_TAB_TO_PROJECT", projectId: FOLDER_ID, tabId: 2, source: "panel" });
  check("chrome:// 页面明确失败，而不是静默无反应", res5?.ok === false && !!res5?.error, JSON.stringify(res5));
  check("失败时一条都不写", store.laterOnItems.length === countBefore, `${store.laterOnItems.length} / ${countBefore}`);

  const res6 = await send({ type: "SAVE_TAB_TO_PROJECT", projectId: FOLDER_ID, tabId: 404, source: "panel" });
  check("标签页已经关掉时明确失败", res6?.ok === false && !!res6?.error, JSON.stringify(res6));

  // ── 第 6 步：这条链路不会顺手改掉单篇快捷键的行为 ───────────────
  console.log("\n── 第 6 步：不影响原有的 QUICK_SAVE_TAB 链路 ──");
  store.laterOnSettings = { askFolderOnSingle: false };
  const quick = await send({ type: "QUICK_SAVE_TAB", source: "panel" });
  check("开关关闭时仍然直接收藏、不弹浮层", quick?.ok === true && !quick?.pending, JSON.stringify(quick));
  check("原有链路仍然会弹页内结果药丸", pills.length === 1, `药丸 ${pills.length}`);
  check("原有链路仍然不注入选项目浮层", overlays.length === 0, `浮层 ${overlays.length}`);

  console.log(failures ? `\n有 ${failures} 项没通过 ❌` : "\n全部检查通过 🎉");
  process.exit(failures ? 1 : 0);
})();
