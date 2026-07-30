// Generic loader-proxy daemon runner, shared by every app-proxy-bearing loader
// (claude-code-loader today; opencode-loader's opt-in path later). Lifts the
// config-dir resolution, logging, start-marker and listen scaffolding that used
// to be duplicated per app inside each loader's own src/proxy.ts. The caller
// injects its OWN createProxyServer/makeDynamicResolver (from its app-proxy,
// e.g. claude-code-proxy or opencode-proxy) and RoutingProfile -- core-loader
// must never import an app-proxy or core-proxy directly (core-libs-stay-generic
// rule), it only owns the provider-discovery half (readDeployedProviders).
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { readDeployedProviders } from "./loader-runtime.js";

export type ProxyHandlerEntry = { provider: string; handlerPath: string };

export type ProxyServerLike = {
  listen: () => Promise<number>;
  close?: () => Promise<void>;
};

// TProfile is left generic (not imported from core-proxy) so this module never
// depends on an app-proxy's RoutingProfile type; callers pass their own profile
// value and its shape is opaque here.
export type StartLoaderProxyOptions<TProfile = unknown> = {
  createProxyServer: (opts: {
    configDir: string;
    profile: TProfile;
    port: number;
    log: (message: string) => void;
    resolveHandler: (providerName: string) => Promise<unknown>;
    notify?: (message: string, level?: string) => void;
  }) => ProxyServerLike;
  makeDynamicResolver: (listProviders: () => ProxyHandlerEntry[]) => (providerName: string) => Promise<unknown>;
  profile: TProfile;
  configDir: string;
  port: number;
  // Optional overrides: the real daemon entry points let these default; tests
  // (and future callers with their own logging setup) can inject their own.
  log?: (message: string) => void;
  reposDir?: string;
  // Routes the proxy's user-notifications to a delivery mechanism the host owns
  // (the core event bus). Left undefined by default, so core-proxy falls back to
  // its own notification append.
  notify?: (message: string, level?: string) => void;
};

export type StartedLoaderProxy = {
  server: ProxyServerLike;
  configDir: string;
  reposDir: string;
  log: (message: string) => void;
};

// Default file logger: <configDir>/logs/YYYY-MM-DD/loader-proxy-<startTime>.log.
// Never throws -- a logging failure must not take the proxy daemon down.
function makeDefaultLog(configDir: string): (message: string) => void {
  const startTime = new Date().toISOString().replace(/:/g, "-").split(".")[0];
  return function log(message: string) {
    try {
      const dateStr = new Date().toISOString().split("T")[0];
      const logsDir = join(configDir, "logs", dateStr);
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
      appendFileSync(
        join(logsDir, "loader-proxy-" + startTime + ".log"),
        "[" + new Date().toISOString() + "] " + message + "\n",
      );
    } catch {}
  };
}

// Stamp a start-marker with THIS daemon's launch time. The `cc`/`oc` wrapper's
// ensure_proxy compares the proxy script's mtime against this marker and
// restarts the daemon when the script is newer -- a healthy daemon is
// otherwise never replaced, so proxy/handler fixes would only take effect
// after a manual kill or a machine reboot.
function stampStartMarker(configDir: string) {
  try {
    const logsDir = join(configDir, "logs");
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, ".proxy-started"), new Date().toISOString());
  } catch {}
}

// Starts an app's loader-proxy daemon: builds the dynamic provider resolver off
// core-loader's own readDeployedProviders, spins up the injected proxy server,
// and stamps the start-marker once listening. Each app's src/proxy.ts becomes a
// thin entry point that just supplies createProxyServer/makeDynamicResolver
// (from its own app-proxy) + profile + port.
export function startLoaderProxy<TProfile = unknown>(
  options: StartLoaderProxyOptions<TProfile>,
): Promise<StartedLoaderProxy> {
  const { createProxyServer, makeDynamicResolver, profile, configDir, port } = options;
  const log = options.log || makeDefaultLog(configDir);
  const reposDir = options.reposDir || join(configDir, "repos");

  const resolveHandler = makeDynamicResolver(() =>
    readDeployedProviders(reposDir).map((p) => ({ provider: p.provider, handlerPath: p.handlerPath })),
  );

  const server = createProxyServer({ configDir, profile, port, log, resolveHandler, notify: options.notify });

  return server.listen().then((boundPort) => {
    stampStartMarker(configDir);
    log("Loader proxy listening on 127.0.0.1:" + (boundPort || port));
    return { server, configDir, reposDir, log };
  });
}
