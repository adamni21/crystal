import type { PromiseOrDirect } from "grafast";
import type { GatherPluginContext } from "graphile-build";
import type { PluginHook } from "graphile-config";
import type {
  Introspection,
  PgAttribute,
  PgClass,
  PgConstraint,
} from "pg-introspection";
import { parseSmartComment } from "pg-introspection";

import { version } from "../version.js";
import { escapeSqlIdentifier } from "pg-sql2";

declare global {
  namespace GraphileConfig {
    interface GatherHelpers {
      pgFakeConstraints: Record<string, never>;
    }
    interface GatherHooks {
      pgFakeConstraints_constraint: PluginHook<
        (event: {
          introspection: Introspection;
          databaseName: string;
          entity: PgConstraint;
        }) => PromiseOrDirect<void>
      >;
    }
  }
}

interface State {
  fakeId: number;
}
interface Cache {}

export const PgFakeConstraintsPlugin: GraphileConfig.Plugin = {
  name: "PgFakeConstraintsPlugin",
  description:
    "Looks for the @primaryKey, @foreignKey, @unique and @nonNull smart comments and changes the Data Sources such that it's as if these were concrete constraints",
  version: version,
  after: ["smart-tags"],

  gather: {
    namespace: "pgFakeConstraints",
    helpers: {},
    initialState: () => ({
      fakeId: 0,
    }),
    hooks: {
      // We detect "fake" foreign key constraints during the "introspection"
      // phase (which runs first) because we need it to already be established
      // for _all_ classes by the time pgTables_PgSourceBuilder_relations is
      // called (otherwise we may get race conditions and relations only being
      // defined in one direction).
      async pgIntrospection_introspection(info, event) {
        const { introspection } = event;

        for (const pgClass of introspection.classes) {
          const { tags } = pgClass.getTagsAndDescription();

          if (tags.primaryKey) {
            await processUnique(info, event, pgClass, tags.primaryKey, true);
          }

          if (tags.unique) {
            if (Array.isArray(tags.unique)) {
              for (const uniq of tags.unique) {
                await processUnique(info, event, pgClass, uniq);
              }
            } else {
              await processUnique(info, event, pgClass, tags.unique);
            }
          }
        }

        // For us to reference fake primary keys, we need to complete adding
        // primary keys/uniques before we try adding foreign keys.
        for (const pgClass of introspection.classes) {
          const { tags } = pgClass.getTagsAndDescription();

          if (tags.foreignKey) {
            if (Array.isArray(tags.foreignKey)) {
              for (const fk of tags.foreignKey) {
                await processFk(info, event, pgClass, fk);
              }
            } else {
              await processFk(info, event, pgClass, tags.foreignKey);
            }
          }
        }

        for (const pgAttr of introspection.attributes) {
          const tags = pgAttr.getTags();
          if (tags?.notNull) {
            pgAttr.attnotnull = true;
          }
        }
      },
    },
  } as GraphileConfig.PluginGatherConfig<"pgFakeConstraints", State, Cache>,
};

function parseConstraintSpec(rawSpec: string) {
  const [spec, ...tagComponents] = rawSpec.split(/\|/);
  return [spec, tagComponents.join("\n")];
}

function attributesByNames(
  pgClass: PgClass,
  names: string[] | null,
  identity: () => string,
): PgAttribute[] {
  const allAttrs = pgClass.getAttributes();
  if (!names) {
    const pk = pgClass.getConstraints().find((con) => con.contype === "p");
    if (pk) {
      return pk.conkey!.map((n) => allAttrs.find((a) => a.attnum === n)!);
    } else {
      throw new Error(
        `No columns specified for '${pgClass.getNamespace()!.nspname}.${
          pgClass.relname
        }' (oid: ${pgClass._id}) and no PK found.`,
      );
    }
  } else {
    const attrs = names.map(
      (col) => allAttrs.find((attr) => attr.attname === col)!,
    );
    for (let i = 0, l = attrs.length; i < l; i++) {
      const attr = attrs[i];
      const col = names[i];
      if (!attr) {
        throw new Error(
          `${identity()} referenced non-existent column '${col}'; known columns: ${allAttrs
            .filter((a) => a.attnum >= 0)
            .map((attr) => attr.attname)
            .join(", ")}`,
        );
      }
    }

    return attrs;
  }
}

async function processUnique(
  info: GatherPluginContext<State, Cache>,
  event: {
    databaseName: string;
    introspection: Introspection;
  },
  pgClass: PgClass,
  rawSpec: string | true | (string | true)[],
  primaryKey = false,
) {
  const identity = () =>
    `${pgClass.getNamespace()!.nspname}.${pgClass.relname}`;
  const { introspection, databaseName } = event;
  const tag = primaryKey ? "primaryKey" : "unique";
  if (typeof rawSpec !== "string") {
    throw new Error(
      `Invalid '@${tag}' smart tag on ${identity()}; expected a string`,
    );
  }
  const [spec, extraDescription] = parseConstraintSpec(rawSpec);
  const columns = spec.split(",");
  const attrs = attributesByNames(
    pgClass,
    columns,
    () => `'@${tag}' smart tag on ${identity()}`,
  );

  if (primaryKey) {
    // All primary key columns are non-null
    for (const attr of attrs) {
      attr.attnotnull = true;
    }
  }

  const tagsAndDescription = parseSmartComment(extraDescription);

  const id = `FAKE_${pgClass.getNamespace()!.nspname}_${
    pgClass.relname
  }_${tag}_${info.state.fakeId++}`;

  // Now we fake the constraint
  const pgConstraint: PgConstraint = {
    _id: id,
    conname: id,
    connamespace: pgClass.relnamespace,
    contype: primaryKey ? "p" : "u",
    condeferrable: false,
    condeferred: false,
    convalidated: true,
    conrelid: pgClass._id,
    contypid: "0",
    conindid: "0",
    confrelid: "0",
    confupdtype: null,
    confdeltype: null,
    confmatchtype: null,
    conislocal: true,
    coninhcount: 0,
    connoinherit: null,
    conkey: attrs.map((c) => c.attnum),
    confkey: null,
    conpfeqop: null,
    conppeqop: null,
    conffeqop: null,
    conexclop: null,
    conbin: null,
    getClass: () => pgClass,
    getAttributes: () => attrs,
    getDescription: () => extraDescription,
    getTagsAndDescription: () => tagsAndDescription,
    getTags: () => tagsAndDescription.tags,
    getForeignClass: () => undefined,
    getForeignAttributes: () => undefined,
    getNamespace: () => pgClass.getNamespace(),
    getType: () => undefined,
  };

  await addConstraint(info, introspection, databaseName, pgConstraint);
}

const removeQuotes = (str: string) => {
  const trimmed = str.trim();
  if (trimmed[0] === '"') {
    if (trimmed[trimmed.length - 1] !== '"') {
      throw new Error(
        `We failed to parse a quoted identifier '${str}'. Please avoid putting quotes or commas in smart comment identifiers (or file a PR to fix the parser).`,
      );
    }
    return trimmed.slice(1, -1);
  } else {
    // PostgreSQL lower-cases unquoted columns, so we should too.
    return trimmed.toLowerCase();
  }
};

const parseSqlColumnArray = (str: string) => {
  if (!str) {
    throw new Error(`Cannot parse '${str}'`);
  }
  const parts = str.split(",");
  return parts.map(removeQuotes);
};

const parseSqlColumnString = (str: string) => {
  if (!str) {
    throw new Error(`Cannot parse '${str}'`);
  }
  return removeQuotes(str);
};

async function processFk(
  info: GatherPluginContext<State, Cache>,
  event: {
    databaseName: string;
    introspection: Introspection;
  },
  pgClass: PgClass,
  rawSpec: string | true | (string | true)[],
) {
  const identity = () =>
    `${pgClass.getNamespace()!.nspname}.${pgClass.relname}`;
  const { databaseName, introspection } = event;
  if (typeof rawSpec !== "string") {
    throw new Error(
      `Invalid '@foreignKey' smart tag on ${identity()}; expected a string`,
    );
  }
  const [spec, extraDescription] = parseConstraintSpec(rawSpec);
  const matches = spec.match(
    /^\(([^()]+)\) references ([^().]+)(?:\.([^().]+))?(?:\s*\(([^()]+)\))?$/i,
  );
  if (!matches) {
    throw new Error(
      `Invalid @foreignKey syntax on '${identity()}'; expected something like "(col1,col2) references schema.table (c1, c2)", you passed '${spec}'`,
    );
  }
  const [, rawColumns, rawSchemaOrTable, rawTableOnly, rawForeignColumns] =
    matches;
  const rawSchema = rawTableOnly
    ? rawSchemaOrTable
    : `"${pgClass.getNamespace()!.nspname}"`;
  const rawTable = rawTableOnly || rawSchemaOrTable;
  const columns: string[] = parseSqlColumnArray(rawColumns);
  const foreignSchema: string = parseSqlColumnString(rawSchema);
  const foreignTable: string = parseSqlColumnString(rawTable);
  const foreignColumns: string[] | null = rawForeignColumns
    ? parseSqlColumnArray(rawForeignColumns)
    : null;

  const foreignPgClass = await info.helpers.pgIntrospection.getClassByName(
    databaseName,
    foreignSchema,
    foreignTable,
  );
  if (!foreignPgClass) {
    throw new Error(
      `Invalid @foreignKey on '${identity()}'; referenced non-existent table/view '${foreignSchema}.${foreignTable}'. Note that this reference must use *database names* (i.e. it does not respect @name). (${rawSpec})`,
    );
  }
  const keyAttibutes = attributesByNames(
    pgClass,
    columns,
    () => `'@foreignKey' smart tag on ${identity()} local columns`,
  );
  const foreignKeyAttibutes = attributesByNames(
    foreignPgClass,
    foreignColumns,
    () => `'@foreignKey' smart tag on ${identity()} remote columns`,
  );

  // Check that this is unique
  const isUnique = foreignPgClass.getConstraints().some((foreignConstraint) => {
    if (
      foreignConstraint.contype !== "p" &&
      foreignConstraint.contype !== "u"
    ) {
      return false;
    }
    const attrs = foreignConstraint.getAttributes();
    return (
      attrs &&
      attrs.length === foreignKeyAttibutes.length &&
      attrs.every((attr) => foreignKeyAttibutes.includes(attr))
    );
  });

  if (!isUnique) {
    throw new Error(
      `Invalid @foreignKey on '${identity()}'; referenced non-unique combination of columns '${foreignSchema}.${foreignTable}' (${foreignKeyAttibutes
        .map((k) => k.attname)
        .join(
          ", ",
        )}). If this list of columns is truly unique you should add a unique constraint to the table:

ALTER TABLE ${escapeSqlIdentifier(foreignSchema)}.${escapeSqlIdentifier(
        foreignTable,
      )}
  ADD UNIQUE (${foreignKeyAttibutes
    .map((k) => escapeSqlIdentifier(k.attname))
    .join(", ")});

or use a '@unique ${foreignKeyAttibutes
        .map((k) => k.attname)
        .join(
          ",",
        )}' smart tag to emulate this. (Original spec: ${JSON.stringify(
        rawSpec,
      )})`,
    );
  }

  const tagsAndDescription = parseSmartComment(extraDescription);

  const id = `FAKE_${pgClass.getNamespace()!.nspname}_${
    pgClass.relname
  }_foreignKey_${info.state.fakeId++}`;

  // Now we fake the constraint
  const pgConstraint: PgConstraint = {
    _id: id,
    conname: id,
    connamespace: pgClass.relnamespace,
    contype: "f",
    condeferrable: false,
    condeferred: false,
    convalidated: true,
    conrelid: pgClass._id,
    contypid: "0",
    conindid: "0",
    confrelid: foreignPgClass._id,
    confupdtype: "a",
    confdeltype: "a",
    confmatchtype: "s",
    conislocal: true,
    coninhcount: 0,
    connoinherit: null,
    conkey: keyAttibutes.map((c) => c.attnum),
    confkey: foreignKeyAttibutes.map((c) => c.attnum),
    conpfeqop: null,
    conppeqop: null,
    conffeqop: null,
    conexclop: null,
    conbin: null,
    getClass: () => pgClass,
    getAttributes: () => keyAttibutes,
    getDescription: () => extraDescription,
    getTagsAndDescription: () => tagsAndDescription,
    getTags: () => tagsAndDescription.tags,
    getForeignClass: () => foreignPgClass,
    getForeignAttributes: () => foreignKeyAttibutes,
    getNamespace: () => pgClass.getNamespace(),
    getType: () => undefined,
  };

  await addConstraint(info, introspection, databaseName, pgConstraint);
}

async function addConstraint(
  info: GatherPluginContext<State, Cache>,
  introspection: Introspection,
  databaseName: string,
  pgConstraint: PgConstraint,
) {
  introspection.constraints.push(pgConstraint);
  addConstraintToClass(introspection, pgConstraint, pgConstraint.conrelid);
  addConstraintToClass(
    introspection,
    pgConstraint,
    pgConstraint.confrelid,
    true,
  );
  await info.process("pgFakeConstraints_constraint", {
    introspection,
    databaseName,
    entity: pgConstraint,
  });
}

function addConstraintToClass(
  introspection: Introspection,
  pgConstraint: PgConstraint,
  oid: string | null | undefined,
  foreign = false,
) {
  if (oid != null) {
    const pgClass = introspection.classes.find(
      (rel) => rel._id === pgConstraint.conrelid,
    );
    if (!pgClass) {
      throw new Error(
        `Broken foreign constraint, class '${oid}' doesn't exist?`,
      );
    }
    const constraints = foreign
      ? pgClass.getForeignConstraints()
      : pgClass.getConstraints();
    if (!constraints.includes(pgConstraint)) {
      constraints.push(pgConstraint);
    }
  }
}
