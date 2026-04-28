import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets();
const watch = process.argv.includes("--watch");

// @kubernetes/client-node is CJS with dynamic require() calls for Node builtins
// that cannot be statically inlined into an ESM bundle — keep it external.
const workerConfig = {
  ...presets.esbuild.worker,
  external: [...(presets.esbuild.worker.external ?? []), "@kubernetes/client-node"],
};

const workerCtx = await esbuild.context(workerConfig);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch()]);
  console.log("esbuild watch mode enabled for worker and manifest");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose()]);
}
