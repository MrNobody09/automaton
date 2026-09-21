export interface VitestTopologyProject {
  name: string;
  allowOnly: boolean | undefined;
  setupFiles: string[];
}

export interface VitestTopology {
  files: string[];
  projects: VitestTopologyProject[];
}

export function selectTestShard<T>(files: T[], shardIndex: number, shardTotal: number): T[];
export function inspectVitestTopology(repoRoot: string): Promise<VitestTopology>;
export function discoverTestFiles(repoRoot: string): Promise<string[]>;
