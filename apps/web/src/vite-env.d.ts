/// <reference types="vite/client" />

declare module "rhino3dm/rhino3dm.module.min.js" {
  const factory: (opts?: { locateFile?: (path: string) => string }) => Promise<unknown>;
  export default factory;
}
