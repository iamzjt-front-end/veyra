import { createSecretRedactor } from "@veyraoss/runtime";

export function redactor(env: NodeJS.ProcessEnv) {
  return createSecretRedactor({ env });
}
