import "graphile-config";
import "graphile-build-pg";
import { PgSource, PgSourceParameter, PgTypeCodec } from "@dataplan/pg";
import { inspect } from "util";
import { PgProc } from "pg-introspection";

declare global {
  namespace GraphileConfig {
    interface GatherHelpers {
      pgV4SmartTags: Record<string, never>;
    }
  }
}

const v4ComputedColumnChecks = (
  s: PgSource<any, any, any, any>,
  pgProc: PgProc,
): boolean => {
  const args = pgProc.getArguments();
  const firstArg = args[0];

  // Has to be in same schema
  if (args[0].type.typnamespace !== pgProc.pronamespace) {
    return false;
  }

  // Has to start with the name prefix
  if (!pgProc.proname.startsWith(args[0].name + "_")) {
    return false;
  }

  return true;
};

export const PgV4BehaviorPlugin: GraphileConfig.Plugin = {
  name: "PgV4BehaviorPlugin",
  description:
    "For compatibility with PostGraphile v4 schemas, this plugin updates the default behaviors of certain things.",
  version: "0.0.0",

  gather: {
    hooks: {
      pgProcedures_PgSource(info, event) {
        const { source: s } = event;
        // Apply default behavior
        const behavior = [];
        const firstParameter = (
          s as PgSource<any, any, any, PgSourceParameter[]>
        ).parameters[0];
        if (s.isMutation && s.parameters) {
          behavior.push("-query_field mutation_field -type_field");
        } else if (
          s.parameters &&
          s.parameters?.[0]?.codec?.columns &&
          !s.isMutation &&
          v4ComputedColumnChecks(s, event.pgProc)
        ) {
          behavior.push("-query_field -mutation_field type_field");
        } else if (
          !s.isMutation &&
          s.parameters &&
          // Don't default to this being a query_field if it looks like a computed column function
          (!firstParameter?.codec?.columns ||
            firstParameter?.codec?.extensions?.isTableLike === false)
        ) {
          behavior.push("query_field -mutation_field -type_field");
        } else {
          behavior.push("-query_field -mutation_field -type_field");
        }

        if (!s.extensions) {
          s.extensions = Object.create(null);
        }
        if (!s.extensions!.tags) {
          s.extensions!.tags = Object.create(null);
        }
        const b = s.extensions!.tags!.behavior;
        if (!b) {
          s.extensions!.tags!.behavior = behavior;
        } else if (typeof b === "string") {
          s.extensions!.tags!.behavior = [...behavior, b];
        } else if (Array.isArray(b)) {
          s.extensions!.tags!.behavior = [...behavior, ...b];
        } else {
          throw new Error(
            `${s}.extensions.tags.behavior has unknown shape '${inspect(b)}'`,
          );
        }
      },
    },
  },
};
