export interface InstallContext {
  /** Directory where the IDE keeps its config. */
  ideConfigDir: string;
  /** Absolute path to the colony CLI entrypoint (the .js file). */
  cliPath: string;
  /**
   * Absolute path to the Node binary used to launch the CLI. IDE configs
   * must spawn `nodeBin cliPath …`, not `cliPath …` — on Windows spawning
   * a raw .js fails with EFTYPE (no associated exec handler).
   */
  nodeBin: string;
  /** Absolute path to the local data dir (e.g., ~/.colony). */
  dataDir: string;
}

export interface Installer {
  id: string;
  label: string;
  detect(ctx: InstallContext): Promise<boolean>;
  install(ctx: InstallContext): Promise<string[]>;
  uninstall(ctx: InstallContext): Promise<string[]>;
}
