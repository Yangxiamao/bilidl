// 插件自己的 IndexedDB：tasks 存下载任务（含断点续传的进度位图），kv 存设置和保存目录的句柄。
// Worker、弹出页、设置页都是插件自己的来源，看到的是同一个数据库。
let dbp = null;

export function openDb() {
  dbp ??= new Promise((ok, bad) => {
    const r = indexedDB.open("bilidl-dl", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("tasks", { keyPath: "id" });
      r.result.createObjectStore("kv");
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((ok, bad) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => ok(req?.result);
    t.onerror = () => bad(t.error);
    t.onabort = () => bad(t.error);
  });
}

export const getAll = () => tx("tasks", "readonly", s => s.getAll());
export const putTask = task => tx("tasks", "readwrite", s => s.put(task));
export const delTask = id => tx("tasks", "readwrite", s => s.delete(id));
export const kvGet = key => tx("kv", "readonly", s => s.get(key));
export const kvSet = (key, value) => tx("kv", "readwrite", s => value === undefined ? s.delete(key) : s.put(value, key));

export const DEFAULT_SETTINGS = { workers: 16, format: "mp4" };
export const getSettings = async () => ({ ...DEFAULT_SETTINGS, ...(await kvGet("settings")) });
