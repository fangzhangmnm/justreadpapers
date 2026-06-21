// app 级单例:persistence(装配一次)+ 派生访问器。组件直接 import(单 app,模块单例够用;
// 不走 Vue provide/inject 是为了不动 vue.d.ts shim,语义等价)。
// 反应式 UI 状态(当前篇/页/同步态)随 #1 cloud 接入再长;现在 viewer 控件只需要 settings。
import { createPersistence } from "./persistence/index.ts";
import type { Persistence, Settings } from "./persistence/index.ts";

let _p: Persistence | null = null;
/** 懒装配 persistence(首次用时建;createOneDriveProvider 只配置不连网,安全)。 */
export function persistence(): Persistence {
  if (!_p) _p = createPersistence();
  return _p;
}
/** 设备本地设置面(zoom factor / spread / theme)。app 调这个,不碰 localStorage。 */
export function settings(): Settings {
  return persistence().settings;
}
