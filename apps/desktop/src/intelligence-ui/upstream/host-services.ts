// Turnsu adapter for the upstream library. The caller is the current task App.
type Lookup = (kind: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
let lookup: Lookup = async () => { throw new Error("当前宿主未提供公开图片与地图查询连接。"); };
export function configureMedia(value: Lookup) { lookup = value; }
export function lookupMedia(kind: string, args: Record<string, unknown>) { return lookup(kind, args); }
