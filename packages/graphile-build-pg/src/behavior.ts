import type {
  PgSourceExtensions,
  PgTypeCodecExtensions,
  PgSourceRelationExtensions,
} from "@dataplan/pg";
import { isDev } from "graphile-crystal";
import { inspect } from "util";

// NOTE: 'behaviour' is the correct spelling in UK English; we try and stick to
// US English but this function tries to be a bit forgiving.

/**
 * Takes a smart tags object and extracts the 'behavior' (or 'behaviour')
 * property and coerces it to be a string array. Returns null if no behavior
 * was specified (in which case the default behavior should be used).
 */
export function getBehavior(
  extensions:
    | Partial<PgSourceExtensions>
    | Partial<PgSourceRelationExtensions>
    | Partial<PgTypeCodecExtensions>
    | undefined,
): string[] | null {
  const behavior = extensions?.tags?.behavior || extensions?.tags?.behaviour;
  if (behavior == null) {
    return null;
  }
  if (Array.isArray(behavior)) {
    if (isDev && !behavior.every(isValidBehavior)) {
      throw new Error(
        `Invalid value for behavior; expected a string or string array using simple alphanumeric strings, but found ${inspect(
          behavior,
        )}`,
      );
    }
    return behavior;
  }
  if (isValidBehavior(behavior)) {
    return [behavior];
  }
  throw new Error(
    `Invalid value for behavior; expected a string or string array using simple alphanumeric strings, but found ${inspect(
      behavior,
    )}`,
  );
}

/**
 * We're strict with this because we want to be able to expand this in future.
 * For example I want to allow `@behavior all,some` to operate the same as
 * `@behavior all\n@behavior some`. I also want to be able to add
 * `@behavior -all` to remove a previously enabled behavior.
 *
 * @internal
 */
function isValidBehavior(behavior: unknown): behavior is string {
  return (
    typeof behavior === "string" &&
    /^[a-zA-Z]([-_]?[a-zA-Z0-9])+$/.test(behavior)
  );
}