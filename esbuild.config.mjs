import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

// @kubernetes/client-node is CJS with dynamic require() calls for Node builtins
// that cannot be statically inlined into an ESM bundle — keep it external.
const workerConfig = {
  ...presets.esbuild.worker,
  external: [...(presets.esbuild.worker.external ?? []), "@kubernetes/client-node"],
};

if (!presets.esbuild.ui) {
  throw new Error("esbuild UI preset missing — check uiEntry in createPluginBundlerPresets");
}

const workerCtx = await esbuild.context(workerConfig);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(presets.esbuild.ui);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}
