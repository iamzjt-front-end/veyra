import { createSecretRedactor } from "@veyra/runtime";

export function redactor(env: NodeJS.ProcessEnv) {
  return createSecretRedactor({ env });
}
