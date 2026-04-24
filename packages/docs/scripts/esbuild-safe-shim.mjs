import shim from './esbuild-safe-shim.cjs';

export const analyzeMetafile = shim.analyzeMetafile;
export const analyzeMetafileSync = shim.analyzeMetafileSync;
export const build = shim.build;
export const buildSync = shim.buildSync;
export const context = shim.context;
export const formatMessages = shim.formatMessages;
export const formatMessagesSync = shim.formatMessagesSync;
export const initialize = shim.initialize;
export const stop = shim.stop;
export const transform = shim.transform;
export const transformSync = shim.transformSync;
export const version = shim.version;

export default shim;
