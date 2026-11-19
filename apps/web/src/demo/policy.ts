/** Whether the showcase drawing should load: `?demo` forces, `?blank` and `?open=` (a file is on its way) skip, otherwise only the web build's first-ever open. */
export function shouldLoadDemo(search: string, seen: boolean, tauri: boolean, empty: boolean): boolean {
  const q = new URLSearchParams(search);
  if (q.has("blank") || q.has("open")) return false;
  if (q.has("demo")) return true;
  return !tauri && !seen && empty;
}
