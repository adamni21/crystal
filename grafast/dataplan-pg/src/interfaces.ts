import type { ExecutableStep, GrafastSubscriber, ModifierStep } from "grafast";
import type { SQL, SQLRawValue } from "pg-sql2";

import type { PgAdaptorOptions } from "./adaptors/pg.js";
import type { PgTypeColumns } from "./codecs.js";
import type {
  PgSource,
  PgSourceOptions,
  PgSourceParameter,
  PgSourceUnique,
} from "./datasource.js";
import type { WithPgClient } from "./executor.js";
import type { PgDeleteStep } from "./steps/pgDelete.js";
import type { PgInsertStep } from "./steps/pgInsert.js";
import type { PgSelectSingleStep } from "./steps/pgSelectSingle.js";
import type { PgUpdateStep } from "./steps/pgUpdate.js";

/**
 * A class-like source of information - could be from `SELECT`-ing a row, or
 * `INSERT...RETURNING` or similar. *ALWAYS* represents a single row (or null).
 */
export type PgClassSingleStep<
  TSource extends PgSource<any, any, any, any, any>,
> =
  | PgSelectSingleStep<TSource>
  | PgInsertStep<TSource>
  | PgUpdateStep<TSource>
  | PgDeleteStep<TSource>;

/**
 * Given a value of type TInput, returns an `SQL` value to insert into an SQL
 * statement.
 */
export type PgEncode<TInput> = (value: TInput) => SQLRawValue;

/**
 * Given a text value from PostgreSQL, returns the value cast to TCanonical.
 */
export type PgDecode<TForJavaScript, TFromPostgres = string> = (
  value: TFromPostgres,
) => TForJavaScript;

export interface PgRefDefinitionExtensions {}
export interface PgRefDefinition {
  graphqlType?: string;
  singular?: boolean;
  extensions?: PgRefDefinitionExtensions;
  singleRecordFieldName?: string;
  listFieldName?: string;
  connectionFieldName?: string;
}
export interface PgRefDefinitions {
  [refName: string]: PgRefDefinition;
}

/**
 * Custom metadata for a codec
 */
export interface PgTypeCodecExtensions {
  oid?: string;
  pg?: {
    databaseName: string;
    schemaName: string;
    name: string;
  };
  description?: string;
  listItemNonNull?: boolean;
}

export interface PgTypeCodecPolymorphismSingleTypeColumnSpec<
  TColumnName extends string,
> {
  column: TColumnName;
  isNotNull?: boolean;
  rename?: string;
}

export interface PgTypeCodecPolymorphismSingleTypeSpec<
  TColumnName extends string,
> {
  name: string;
  // TODO: make this optional?
  columns: Array<PgTypeCodecPolymorphismSingleTypeColumnSpec<TColumnName>>;
}
export interface PgTypeCodecPolymorphismSingle<TColumnName extends string> {
  mode: "single";
  typeColumns: readonly TColumnName[];
  // TODO: make this optional?
  commonColumns: readonly TColumnName[];
  types: {
    [typeKey: string]: PgTypeCodecPolymorphismSingleTypeSpec<TColumnName>;
  };
}

export interface PgTypeCodecPolymorphismRelationalTypeSpec {
  name: string;
  /** The name of the database table this type relates to (useful before the relations are established) */
  references: string;
  /** The name of the relation to follow to get the related record */
  relationName: string;
  // Currently assumes it's joined via PK, but we might expand that in future
}
export interface PgTypeCodecPolymorphismRelational<TColumnName extends string> {
  mode: "relational";
  typeColumns: readonly TColumnName[];
  types: {
    [typeKey: string]: PgTypeCodecPolymorphismRelationalTypeSpec;
  };
}

export interface PgTypeCodecPolymorphismUnion {
  mode: "union";
}

export type PgTypeCodecPolymorphism<TColumnName extends string> =
  | PgTypeCodecPolymorphismSingle<TColumnName>
  | PgTypeCodecPolymorphismRelational<TColumnName>
  | PgTypeCodecPolymorphismUnion;

/**
 * A codec for a Postgres type, tells us how to convert to-and-from Postgres
 * (including changes to the SQL statement itself). Also includes metadata
 * about the type, for example any of the attributes it has.
 */
export interface PgTypeCodec<
  TName extends string,
  TColumns extends PgTypeColumns | undefined,
  TFromPostgres,
  TFromJavaScript = TFromPostgres,
  TArrayItemCodec extends
    | PgTypeCodec<string, any, any, any, undefined, any, any>
    | undefined = undefined,
  TDomainItemCodec extends
    | PgTypeCodec<string, any, any, any, any, any, any>
    | undefined = undefined,
  TRangeItemCodec extends
    | PgTypeCodec<string, undefined, any, any, undefined, any, undefined>
    | undefined = undefined,
> {
  /**
   * Unique name to identify this codec.
   */
  name: TName;

  /**
   * Given a value of type TFromJavaScript, returns an `SQL` value to insert into an SQL
   * statement.
   *
   * **IMPORTANT**: nulls must already be handled!
   */
  toPg: PgEncode<TFromJavaScript>;

  /**
   * Given a text value from PostgreSQL, returns the value cast to TCanonical.
   *
   * **IMPORTANT**: nulls must already be handled!
   */
  fromPg: PgDecode<TFromJavaScript, TFromPostgres>;

  // TODO: rename?
  /**
   * We'll append `::text` by default to each selection; however if this type
   * needs something special (e.g. `money` should be converted to `numeric`
   * before being converted to `text`) then you can provide this custom
   * callback to provide your own casting - this could even include function
   * calls if you want.
   */
  castFromPg?: (fragment: SQL) => SQL;

  /**
   * If you provide `castFromPg` you probably ought to also specify
   * `listCastFromPg` so that a list of this type can be converted properly.
   */
  listCastFromPg?: (fragment: SQL) => SQL;

  /**
   * When we have an expression of this type, we can safely cast it within
   * Postgres using the cast `(${expression})::${sqlType}` to make the type
   * explicit.
   */
  sqlType: SQL;

  /**
   * If true, this is an anonymous type (e.g. the return type of a
   * `returns record` or `returns table` PostgreSQL function) and thus should
   * not be referenced via `sqlType` directly.
   */
  isAnonymous?: boolean;

  // TODO: extract this to a different interface
  /**
   * If this is a composite type, the columns it supports.
   */
  columns: TColumns;

  /**
   * A callback to return `'true'` (text string) if the composite type
   * represented by this codec is non-null, and `null` or `'false'` otherwise.
   *
   * If this codec represents a composite type (e.g. a row or other type with
   * multiple columns) and this type can be returned from a function then
   * there's a risk that the function may return null/an all-nulls composite
   * type. This can occur with `returns some_composite_type` or
   * `returns setof some_composite_type`, though the former is more common as
   * you explicitly need to return nulls in the latter.
   *
   * We can't simply do `not (foo is null)` because you might be using
   * column-level select grants which would prevent this happening. As such we
   * give you a chance to provide your own non-null check. In most table cases
   * you can use `(${alias}.id is not null)::text` (assuming 'id' is the name
   * of your primary key); for composite types you can normally do
   * `(not (${alias} is null))::text`.
   */
  notNullExpression?: (alias: SQL) => SQL;

  /**
   * If set, this represents a PostgreSQL array type. Please note: array types
   * should NOT be nested.
   */
  arrayOfCodec?: TArrayItemCodec;

  /**
   * The underlying codec that this type is a domain over.
   */
  domainOfCodec?: TDomainItemCodec;
  /**
   * If this is a domain, does it add a non-null constraint?
   */
  notNull?: boolean;

  /**
   * The underlying codec that this type is a range over.
   */
  rangeOfCodec?: TRangeItemCodec;

  polymorphism?: PgTypeCodecPolymorphism<any>;

  /**
   * Arbitrary metadata
   */
  extensions?: Partial<PgTypeCodecExtensions>;
}

export type PgTypeCodecAny = PgTypeCodec<
  string,
  PgTypeColumns | undefined,
  any,
  any,
  | PgTypeCodec<
      string,
      PgTypeColumns | undefined,
      any,
      any,
      undefined,
      any,
      any
    >
  | undefined,
  | PgTypeCodec<string, PgTypeColumns | undefined, any, any, any, any, any>
  | undefined,
  PgTypeCodec<string, undefined, any, any, any, any, any> | undefined
>;
export type PgTypeCodecWithColumns = PgTypeCodec<
  string,
  PgTypeColumns,
  any,
  any,
  undefined,
  | PgTypeCodec<string, PgTypeColumns | undefined, any, any, any, any, any>
  | undefined,
  undefined
>;

export type PgEnumValue<TValue extends string = string> = {
  value: TValue;
  description?: string;
};

/**
 * A PgTypeCodec specifically for enums
 */
export interface PgEnumTypeCodec<TName extends string, TValue extends string>
  extends PgTypeCodec<TName, undefined, string, TValue> {
  values: PgEnumValue<TValue>[];
}

/**
 * A PgTypedExecutableStep has a 'pgCodec' property which means we don't need
 * to also state the pgCodec to use, this can be an added convenience.
 */
export interface PgTypedExecutableStep<TCodec extends PgTypeCodecAny>
  extends ExecutableStep<any> {
  pgCodec: TCodec;
}

type PgOrderCommonSpec = {
  direction: "ASC" | "DESC";
  /** `NULLS FIRST` or `NULLS LAST` or nothing */
  nulls?: "FIRST" | "LAST" | null;
};

export type PgOrderFragmentSpec = {
  /** The expression we're ordering by. */
  fragment: SQL;
  /** The codec of the expression that we're ordering by, this is useful when constructing a cursor for it. */
  codec: PgTypeCodec<string, any, any, any>;

  attribute?: never;
  callback?: never;
} & PgOrderCommonSpec;

export type PgOrderAttributeSpec = {
  /** The attribute you're using for ordering */
  attribute: string;
  /** An optional expression to wrap this column with, and the type that expression returns */
  callback?: (
    attributeExpression: SQL,
    attributeCodec: PgTypeCodec<string, any, any, any>,
  ) => [SQL, PgTypeCodec<string, any, any, any>];

  fragment?: never;
  codec?: never;
} & PgOrderCommonSpec;

/**
 * The information required to specify an entry in an 'ORDER BY' clause.
 */
export type PgOrderSpec = PgOrderFragmentSpec | PgOrderAttributeSpec;

/**
 * The information required to specify an entry in a `GROUP BY` clause.
 */
export interface PgGroupSpec {
  fragment: SQL;
  // codec: PgTypeCodec<string, any, any, any>;
  // TODO: consider if 'cube', 'rollup', 'grouping sets' need special handling or can just be part of the fragment
}

export type TuplePlanMap<
  TColumns extends { [column: string]: any },
  TTuple extends ReadonlyArray<keyof TColumns>,
> = {
  [Index in keyof TTuple]: {
    // Optional columns
    [key in keyof TColumns as Exclude<
      key,
      keyof TTuple[number]
    >]?: ExecutableStep<ReturnType<TColumns[key]["pg2gql"]>>;
  } & {
    // Required unique combination of columns
    [key in TTuple[number]]: ExecutableStep<
      ReturnType<TColumns[key]["pg2gql"]>
    >;
  };
};

/**
 * Represents a spec like `{user_id: ExecutableStep}` or
 * `{organization_id: ExecutableStep, item_id: ExecutableStep}`. The keys in
 * the spec can be any of the columns in TColumns, however there must be at
 * least one of the unique sets of columns represented (as specified in
 * TUniqueColumns) - you can then add arbitrary additional columns if you need
 * to.
 */
export type PlanByUniques<
  TColumns extends PgTypeColumns,
  TUniqueColumns extends ReadonlyArray<PgSourceUnique<TColumns>>,
> = TColumns extends PgTypeColumns
  ? TuplePlanMap<TColumns, TUniqueColumns[number]["columns"] & string[]>[number]
  : undefined;

export type PgConditionLikeStep = (ModifierStep<any> | ExecutableStep) & {
  alias: SQL;
  placeholder(
    $step: ExecutableStep,
    codec: PgTypeCodec<string, any, any, any, any>,
  ): SQL;
  where(condition: SQL): void;
  having(condition: SQL): void;
};

export type KeysOfType<TObject, TValueType> = {
  [key in keyof TObject]: TObject[key] extends TValueType ? key : never;
}[keyof TObject];

declare global {
  namespace GraphileConfig {
    interface PgDatabaseConfiguration<
      TAdaptor extends keyof GraphileConfig.PgDatabaseAdaptorOptions = keyof GraphileConfig.PgDatabaseAdaptorOptions,
    > {
      name: string;
      schemas?: string[];

      adaptor: TAdaptor;
      adaptorSettings?: GraphileConfig.PgDatabaseAdaptorOptions[TAdaptor];

      /** The key on 'context' where the withPgClient function will be sourced */
      withPgClientKey: KeysOfType<Grafast.Context & object, WithPgClient>;

      /** Return settings to set in the session */
      pgSettings?: (
        requestContext: Grafast.RequestContext,
      ) => { [key: string]: string } | null;

      /** Settings to set in the session that performs introspection (during gather phase) */
      pgSettingsForIntrospection?: { [key: string]: string } | null;

      /** The key on 'context' where the pgSettings for this DB will be sourced */
      pgSettingsKey?: KeysOfType<
        Grafast.Context & object,
        { [key: string]: string } | null | undefined
      >;

      /** The GrafastSubscriber to use for subscriptions */
      pgSubscriber?: GrafastSubscriber<Record<string, string>> | null;

      /** Where on the context should the PgSubscriber be stored? */
      pgSubscriberKey?: KeysOfType<
        Grafast.Context & object,
        GrafastSubscriber<any> | null | undefined
      >;
    }

    interface Preset {
      pgConfigs?: ReadonlyArray<PgDatabaseConfiguration>;
    }

    interface PgDatabaseAdaptorOptions {
      "@dataplan/pg/adaptors/pg": PgAdaptorOptions;
      /* Add your own via declaration merging */
    }
  }
}

export interface MakePgConfigOptions
  extends Partial<
    Pick<
      GraphileConfig.PgDatabaseConfiguration,
      | "name"
      | "pgSettings"
      | "pgSettingsForIntrospection"
      | "withPgClientKey"
      | "pgSettingsKey"
      | "pgSubscriber"
      | "pgSubscriberKey"
    >
  > {
  connectionString?: string;
  schemas?: string | string[];
  superuserConnectionString?: string;
  pubsub?: boolean;
}

declare global {
  namespace Grafast {
    interface PgCodecRelationExtensions {}
  }
}

/**
 * Describes a relation to another source
 */
export interface PgCodecRelation<
  TLocalCodec extends PgTypeCodec<
    string,
    PgTypeColumns,
    any,
    any,
    undefined,
    any,
    undefined
  >,
  TRemoteSource extends PgSourceOptions<any, any, any, any>,
> {
  /* Where the relationship starts */
  localCodec: TLocalCodec;

  /**
   * The remote source this relation relates to.
   */
  remoteSource: TRemoteSource;

  /**
   * The columns locally used in this relationship.
   */
  localColumns: TLocalCodec extends PgTypeCodec<
    any,
    infer UColumns,
    any,
    any,
    any,
    any,
    any
  >
    ? readonly (keyof UColumns)[]
    : never;

  /**
   * The remote columns that are joined against.
   */
  remoteColumns: TRemoteSource extends PgSourceOptions<
    infer UCodec,
    any,
    any,
    any
  >
    ? UCodec extends PgTypeCodec<any, infer UColumns, any, any, any, any, any>
      ? readonly (keyof UColumns)[]
      : never
    : never;

  /**
   * If true then there's at most one record this relationship will find.
   */
  isUnique: boolean;

  /**
   * If true then this is a reverse lookup (where our local columns are
   * referenced by the remote tables remote columns, rather than the other way
   * around), so multiple rows may be found (unless isUnique is true).
   */
  isReferencee?: boolean;

  /**
   * Space for you to add your own metadata.
   */
  extensions?: Grafast.PgCodecRelationExtensions;

  description?: string;
}

export interface PgRegistryConfig<
  TCodecs extends {
    [name in string]: PgTypeCodec<
      name,
      PgTypeColumns | undefined,
      any,
      any,
      any,
      any,
      any
    >;
  },
  TSourceOptions extends {
    [name in string]: PgSourceOptions<
      PgTypeCodecAny,
      ReadonlyArray<PgSourceUnique<PgTypeColumns>>,
      readonly PgSourceParameterAny[] | undefined,
      name
    >;
  },
  TRelations extends {
    [codecName in keyof TCodecs]?: {
      [relationName in string]: PgCodecRelation<
        PgTypeCodec<string, PgTypeColumns, any, any, undefined, any, undefined>,
        PgSourceOptions<PgTypeCodecWithColumns, any, any, any>
      >;
    };
  },
> {
  pgCodecs: TCodecs;
  // TODO: Rename to pgSourceOptions?
  pgSources: TSourceOptions;
  pgRelations: TRelations;
}

// https://github.com/microsoft/TypeScript/issues/47980#issuecomment-1049304607
export type Expand<T> = T extends unknown
  ? { [TKey in keyof T]: T[TKey] }
  : never;

export type SourceFromOptions<
  TCodecs extends {
    [name in string]: PgTypeCodec<
      name,
      PgTypeColumns | undefined,
      any,
      any,
      any,
      any,
      any
    >;
  },
  TSourceOptions extends {
    [name in string]: PgSourceOptions<
      PgTypeCodecAny, // TCodecs[keyof TCodecs],
      ReadonlyArray<PgSourceUnique<PgTypeColumns>>,
      readonly PgSourceParameterAny[] | undefined,
      name
    >;
  },
  TRelations extends {
    [codecName in keyof TCodecs]?: {
      [relationName in string]: PgCodecRelation<
        // TCodecs[keyof TCodecs] &
        PgTypeCodec<string, PgTypeColumns, any, any, undefined, any, undefined>,
        // TSourceOptions[keyof TSourceOptions] &
        PgSourceOptions<
          // TCodecs[keyof TCodecs] &
          PgTypeCodecWithColumns,
          any,
          any,
          any
        >
      >;
    };
  },
  TSourceName extends keyof TSourceOptions,
> = TSourceOptions[TSourceName] extends PgSourceOptions<
  infer UCodec,
  infer UUniques,
  infer UParameters,
  infer UName
>
  ? PgSource<
      PgRegistry<TCodecs, TSourceOptions, TRelations>,
      UCodec,
      UUniques,
      UParameters,
      UName
    >
  : never;

export interface PgRegistry<
  TCodecs extends {
    [name in string]: PgTypeCodec<
      name,
      PgTypeColumns | undefined,
      any,
      any,
      any,
      any,
      any
    >;
  },
  TSourceOptions extends {
    [name in string]: PgSourceOptions<
      PgTypeCodecAny, // TCodecs[keyof TCodecs],
      ReadonlyArray<PgSourceUnique<PgTypeColumns>>,
      readonly PgSourceParameterAny[] | undefined,
      name
    >;
  },
  TRelations extends {
    [codecName in keyof TCodecs]?: {
      [relationName in string]: PgCodecRelation<
        // TCodecs[keyof TCodecs] &
        PgTypeCodec<string, PgTypeColumns, any, any, undefined, any, undefined>,
        // TSourceOptions[keyof TSourceOptions] &
        PgSourceOptions<
          // TCodecs[keyof TCodecs] &
          PgTypeCodecWithColumns,
          any,
          any,
          any
        >
      >;
    };
  },
> {
  pgCodecs: TCodecs;
  pgSources: {
    [name in keyof TSourceOptions]: SourceFromOptions<
      TCodecs,
      TSourceOptions,
      TRelations,
      name
    >;
  };
  pgRelations: {
    [codecName in keyof TRelations]: {
      [relationName in keyof TRelations[codecName]]: Expand<
        TRelations[codecName][relationName] & {
          remoteSource: SourceFromOptions<
            TCodecs,
            TSourceOptions,
            TRelations,
            TRelations[codecName][relationName] extends PgCodecRelation<
              any,
              PgSourceOptions<any, any, any, infer USourceName>
            >
              ? USourceName
              : never
          >;
        }
      >;
    };
  };
}

export type PgSourceParameterAny = PgSourceParameter<
  string | null,
  PgTypeCodecAny
>;

export type PgSourceAny = PgSource<
  PgRegistry<any, any, any>,
  PgTypeCodecAny & any,
  ReadonlyArray<PgSourceUnique<PgTypeColumns>> & any,
  readonly PgSourceParameterAny[] | undefined,
  string & any
>;

export type PgRegistryAny = PgRegistry<
  {
    [name in string]: PgTypeCodec<
      name,
      PgTypeColumns | undefined,
      any,
      any,
      any,
      any,
      any
    >;
  },
  {
    [name in string]: PgSourceOptions<any, any, any, any>;
  },
  {
    [codecName in string]: {
      [relationName in string]: PgCodecRelation<
        PgTypeCodec<any, any, any, any, any, any, any>,
        PgSourceOptions<any, any, any, any>
      >;
    };
  }
>;

/*
  /**
   * Relations to follow for shortcut references, can be polymorphic, can be many-to-many.
   * /
  public refs: PgCodecRefs;
      refs,
*/

export type GetPgRegistryCodecs<TRegistry extends PgRegistry<any, any, any>> =
  TRegistry extends PgRegistry<infer UCodecs, any, any> ? UCodecs : never;

export type GetPgRegistrySources<TRegistry extends PgRegistry<any, any, any>> =
  TRegistry extends PgRegistry<any, infer USources, any> ? USources : never;

export type GetPgRegistryCodecRelations<
  TRegistry extends PgRegistry<any, any, any>,
  TCodec extends GetPgRegistryCodecs<TRegistry>[keyof GetPgRegistryCodecs<TRegistry>],
> = TRegistry extends PgRegistry<any, any, infer URelations>
  ? TCodec extends PgTypeCodec<infer UCodecName, any, any, any, any, any, any>
    ? URelations[UCodecName]
    : never
  : never;

export type GetPgCodecColumns<TCodec extends PgTypeCodecAny> =
  TCodec extends PgTypeCodec<string, infer UColumns, any, any, any, any, any>
    ? UColumns extends PgTypeColumns
      ? UColumns
      : never
    : never;

export type GetPgSourceRegistry<TSource extends PgSourceAny> =
  TSource extends PgSource<infer URegistry, any, any, any, any>
    ? URegistry
    : never;

export type GetPgSourceCodec<TSource extends PgSourceAny> =
  TSource extends PgSource<any, infer UCodec, any, any, any> ? UCodec : never;

export type GetPgSourceColumns<TSource extends PgSourceAny> = GetPgCodecColumns<
  GetPgSourceCodec<TSource>
>;

export type GetPgSourceRelations<TSource extends PgSourceAny> =
  TSource extends PgSource<infer URegistry, infer UCodec, any, any, any>
    ? GetPgRegistryCodecRelations<URegistry, UCodec>
    : never;

export type GetPgSourceUniques<TSource extends PgSourceAny> =
  TSource extends PgSource<any, any, infer UUniques, any, any>
    ? UUniques
    : never;
