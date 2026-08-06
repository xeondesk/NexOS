const CONFIG_PATTERN = /\/next\.config\.(js|ts|mjs|mts)$/;

// Dev hosts the framework must accept. Defaults target NexOS preview
// domains; extend via NEXOS_ALLOWED_DEV_HOSTS (JSON array).
const DEFAULT_DEV_HOSTS = ['*.nexos.build', '*.nexos.run', '*.nexos.net'];

function allowedDevHosts() {
  try {
    const extra = JSON.parse(process.env.NEXOS_ALLOWED_DEV_HOSTS || '[]');
    return Array.isArray(extra) ? extra : [];
  } catch {
    return [];
  }
}

export async function resolve(specifier, context, nextResolve) {
  // When the wrapper imports the original with ?nexos-passthrough, strip the
  // query for resolution, then re-attach it so the load hook sees it.
  if (specifier.includes('?nexos-passthrough')) {
    const clean = specifier.split('?')[0];
    const resolved = await nextResolve(clean, context);
    return { ...resolved, url: resolved.url + '?nexos-passthrough' };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // Intercept next.config.* loading (but not our passthrough re-import)
  if (CONFIG_PATTERN.test(url) && !url.includes('?nexos-passthrough')) {
    const passthroughUrl = url + '?nexos-passthrough';

    // Generate an in-memory wrapper module that imports the original config,
    // resolves function exports, and merges NexOS's overrides.
    const source = `
      import userExport from '${passthroughUrl}';

      export default async function nexosNextConfig(phase, { defaultConfig }) {
        const userConfig = typeof userExport === 'function'
          ? await userExport(phase, { defaultConfig })
          : userExport;

        const devHosts = ${JSON.stringify(DEFAULT_DEV_HOSTS)}.concat(
          JSON.parse(process.env.NEXOS_ALLOWED_DEV_HOSTS || '[]'),
        );

        return {
  ...userConfig,
  distDir: '.next',
  devIndicators: false,
  images: {
    ...userConfig.images,
    unoptimized: process.env.NODE_ENV === 'development',
  },
  logging: {
    ...userConfig.logging,
    fetches: { fullUrl: true, hmrRefreshes: true },
    browserToTerminal: true,
  },
  experimental: {
    ...userConfig.experimental,
    transitionIndicator: true,
    turbopackFileSystemCacheForDev: process.env.TURBOPACK_PERSISTENT_CACHE !== 'false' && process.env.TURBOPACK_PERSISTENT_CACHE !== '0',
    serverActions: {
      ...userConfig.experimental?.serverActions,
      allowedOrigins: [
        ...(userConfig.experimental?.serverActions?.allowedOrigins || []),
        ...devHosts,
      ],
    },
  },
  allowedDevOrigins: [
    ...(userConfig.allowedDevOrigins || []),
    ...devHosts,
  ],
};
      }
    `;

    return { format: 'module', source, shortCircuit: true };
  }

  // Passthrough: load the original file normally
  if (url.includes('?nexos-passthrough')) {
    return nextLoad(url.split('?')[0], context);
  }

  return nextLoad(url, context);
}
