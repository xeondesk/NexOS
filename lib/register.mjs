import { register } from 'node:module';

// NODE_OPTIONS reaches every node process in the dev tree, including the
// pnpm CLI itself. pnpm 11 probes for <workspace>/.pnpmfile.mjs with a bare
// import() and swallows the failure only when util.types.isNativeError(err)
// is true — but errors that cross the module-customization-hooks worker
// thread lose their native-error brand, so registering ANY hook inside pnpm
// turns a missing pnpmfile into a fatal "Error during pnpmfile execution"
// and kills the dev server. Skip registration in pnpm processes; the hooks
// are only needed once a framework process (next dev) loads next.config.*,
// and NODE_OPTIONS still propagates there through pnpm's environment.
const entry = process.argv[1] ?? '';
const isPnpmProcess = /(^|\/)pnpm(\.(c|m)?js)?$/.test(entry);

if (!isPnpmProcess) {
  // Required for .ts configs: tells Next.js to use import() instead of
  // readFileSync + SWC, which would bypass all loader hooks.
  process.env.__NEXT_NODE_NATIVE_TS_LOADER_ENABLED = 'true';

  register(new URL('./config-loader.mjs', import.meta.url));
}
