declare const __VEYRA_EXTENSION_BUILD__: string;
/** Build-time content identity, shared by the worker, page receiver and all UI surfaces. */
export const BUILD_ID =
  typeof __VEYRA_EXTENSION_BUILD__ === "string" ? __VEYRA_EXTENSION_BUILD__ : "development";
