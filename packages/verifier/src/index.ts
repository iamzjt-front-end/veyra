import type { VerificationResult } from "@veyra/protocol";

export interface VerificationRequest {
  commands: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface Verifier {
  verify(request: VerificationRequest): Promise<VerificationResult[]>;
}

/**
 * Shell execution is intentionally not implemented in the architecture scaffold.
 * The v0.1 vertical slice will add a deterministic local command verifier here.
 */
export class ShellVerifier implements Verifier {
  async verify(_request: VerificationRequest): Promise<VerificationResult[]> {
    throw new Error("ShellVerifier is scaffolded but not connected yet.");
  }
}
