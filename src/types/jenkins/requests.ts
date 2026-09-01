/**
 * Jenkins API request contracts.
 */

export type TriggerBuildParams = Record<string, string>;

/**
 * Input for `createItem`. Exactly one of `configXml` or `copyFrom` must be
 * set; `copyFrom` is an item path Jenkins resolves against `parentUrl`
 * (prefix with "/" for a full name from the controller root).
 */
export type CreateItemOptions = {
  name: string;
  /** Folder to create the item in; defaults to the controller root. */
  parentUrl?: string;
} & (
  | { configXml: string; copyFrom?: never }
  | { copyFrom: string; configXml?: never }
);
