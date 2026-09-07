export interface AgentConfig {
  provider: string;
  model?: string;
  options?: Record<string, unknown>;
}

export interface VeyraConfig {
  version: number;
  project?: {
    name?: string;
  };
  agents: Record<string, AgentConfig>;
  workflow: {
    use: string;
  };
  runtime?: {
    maxFixIterations?: number;
    stateDir?: string;
  };
  approval?: {
    requiredFor?: string[];
  };
}
