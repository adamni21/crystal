import { GraphQLResolveInfo } from "graphql";
import {
  GraphQLArguments,
  CrystalResult,
  PathIdentity,
  $$path,
  $$batch,
  $$data,
  GraphQLContext,
  $$plan,
  CrystalContext,
  BaseGraphQLContext,
  CrystalWrappedData,
} from "./interfaces";
import { getPathIdentityFromResolveInfo } from "./utils";
import { Plan } from "./plan";
import { isCrystalResult } from "./crystalResult";
import { Aether } from "./aether";
import { TrackedObject } from "./trackedObject";
import { FieldDigest } from "./parseDoc";

interface Deferred<T> extends Promise<T> {
  resolve: (input?: T | PromiseLike<T> | undefined) => void;
  reject: (error: Error) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve: (input?: T | PromiseLike<T> | undefined) => void;
  let reject: (error: Error) => void;
  const promise = new Promise<T>((_resolve, _reject): void => {
    resolve = _resolve;
    reject = _reject;
  });
  // tslint:disable-next-line prefer-object-spread
  return Object.assign(promise, {
    // @ts-ignore This isn't used before being defined.
    resolve,
    // @ts-ignore This isn't used before being defined.
    reject,
  });
}

class Loader<TResultData = unknown, TInputData = unknown> {
  executed = false;
  timeout: NodeJS.Timeout | null = null;
  batch: CrystalWrappedData<TInputData>[] = [];
  promises: Deferred<TResultData>[] = [];
  constructor(private context: CrystalContext, private info: Info<TResultData, TInputData>) {}

  async load(parent: CrystalWrappedData<TInputData>): Promise<TResultData> {
    if (this.executed) {
      // TODO: re-evaluate this. Shouldn't be necessary.
      throw new Error("Cannot load data from an already executed loader");
    }
    const promise = deferred<TResultData>();
    this.batch.push(parent);
    this.promises.push(promise);
    if (this.timeout === null) {
      this.timeout = setTimeout(() => this.execute(), 0);
    }
    return promise;
  }

  async execute(): Promise<void> {
    // Don't use this again.
    this.info.loader = undefined;
    this.executed = true;

    let results: TResultData[];
    try {
      results = await this.info.plan.eval(this.context, this.batch);
    } catch (e) {
      this.promises.map((deferred) => deferred.reject(e));
      return;
    }
    console.log(
      `Loader result @ ${this.info.pathIdentity}: ${JSON.stringify(results)}`,
    );
    if (!results) {
      this.promises.map((deferred) =>
        deferred.reject(
          new Error("Internal Graphile Crystal error: results should be set."),
        ),
      );
      return;
    }
    this.promises.map((deferred, idx) => deferred.resolve(results[idx]));
  }
}

/**
 * What a Batch knows about a particular PathIdentity
 */
interface Info<TResultData = unknown, TInputData = unknown> {
  pathIdentity: PathIdentity;
  plan: Plan<TResultData>;
  memo: Map<any, any>;
  loader?: Loader<TResultData, TInputData>;
}

/**
 * When a resolver needs a plan to be executed, that execution takes place
 * within a Batch. The first resolver (field) to create the Batch is called the
 * "batch root". We'll try and expand as far from the batch root as we can,
 * looking ahead in the GraphQL query and pro-actively calling the plans for
 * subfields, arguments, etc. A batch has "dependencies", the values used from
 * variables, context, rootValue, etc. Next time we come to build a Batch in a
 * batch root we will look at the previous Batches, and if the dependencies
 * match we can consider re-using the previous Batch.
 *
 * IMPORTANT: the same "batch root" field may result in many calls to create a
 * batch, but like in DataLoader, future calls should be grouped - we can do
 * so using the PathIdentity of the batch root.
 */
export class Batch {
  private crystalInfoByPathIdentity: Map<PathIdentity, Info>;
  private crystalContext: CrystalContext;

  constructor(
    public readonly aether: Aether,
    parent: unknown,
    args: GraphQLArguments,
    context: GraphQLContext,
    info: GraphQLResolveInfo,
  ) {
    this.crystalContext = {
      executeQueryWithDataSource(dataSource, op) {
        return dataSource.execute(context, op);
      },
    };
    this.crystalInfoByPathIdentity = new Map();
    this.prepare(parent, args, context, info);
  }

  /**
   * Populates crystalInfoByPathIdentity **synchronously**.
   */
  prepare(
    parent: unknown,
    args: GraphQLArguments,
    context: GraphQLContext,
    info: GraphQLResolveInfo,
  ): void {
    /*
     * NOTE: although we have access to 'parent' here, we're only using it for
     * meta-data (path, batch, etc); we must not use the *actual* data in it
     * here, that's for `getResultFor` below.
     */

    const parentCrystalResult: CrystalResult | null = isCrystalResult(parent)
      ? parent
      : null;
    const pathIdentity = getPathIdentityFromResolveInfo(
      info,
      parentCrystalResult ? parentCrystalResult[$$path] : undefined,
    );
    const digest = this.aether.doc.digestForPath(
      pathIdentity,
      info.variableValues,
    );
    const trackedContext = new TrackedObject(context);
    const parentPlan = parentCrystalResult ? parentCrystalResult[$$plan] : null;
    // Recursively walk the document digest from this point
    this.processDigest(parentPlan, digest, pathIdentity, trackedContext);
  }

  processDigest(
    parentPlan: Plan<any>,
    digest: FieldDigest,
    pathIdentity: PathIdentity,
    trackedContext: TrackedObject<BaseGraphQLContext>,
  ): void {
    console.log(`Process digest for ${digest.pathIdentity}`);

    if (digest?.plan) {
      // TODO: digest.args might not be quite the right thing.
      const trackedArgs = new TrackedObject(digest.args);

      const plan = digest?.plan(parentPlan, trackedArgs, trackedContext);

      // TODO: apply the args here
      /*
       * Since a batch runs for a single (optionally aliased) field in the
       * operation, we know that the args for all entries within the batch will
       * be the same. Note, however, that the selection set may differ.
       */
      /*
      for (const arg of digest.args) {
        if (arg.name in args) {
          const graphile: GraphileEngine.GraphQLFieldGraphileExtension =
            arg.extensions?.graphile;
          if (graphile) {
            graphile.argPlan?.(
              this,
              args[arg.name],
              parent?.[$$record],
              args,
              context,
            );
          }
        }
      }
      */

      plan.finalize();
      this.crystalInfoByPathIdentity.set(pathIdentity, {
        plan,
        pathIdentity,
        memo: new Map(),
      });

      if (digest.selections) {
        // TODO: WHAT DOES THIS MEAN FOR UNIONS/INTERFACES?
        // digest.selections has null prototype, so this is safe.
        for (const typeName in digest.selections) {
          const fieldSelections = digest.selections[typeName];
          for (const fieldName in fieldSelections) {
            const digest = fieldSelections[fieldName];
            this.processDigest(
              plan,
              digest,
              pathIdentity + `>${typeName}.${fieldName}`,
              trackedContext,
            );
          }
        }
      }
    } else {
      return;
    }
  }

  appliesTo(pathIdentity: PathIdentity): boolean {
    return !!this.crystalInfoByPathIdentity.get(pathIdentity);
  }

  async getResultFor(
    parent: unknown,
    info: GraphQLResolveInfo,
  ): Promise<CrystalResult> {
    // TODO: should be able to return this synchronously (no `async`)
    const parentCrystalResult: CrystalResult | null = isCrystalResult(parent)
      ? parent
      : null;
    const pathIdentity = getPathIdentityFromResolveInfo(
      info,
      parentCrystalResult ? parentCrystalResult[$$path] : undefined,
    );
    console.log(`Getting info for ${pathIdentity}`);
    const crystalInfo = this.crystalInfoByPathIdentity.get(pathIdentity);
    if (!crystalInfo || !crystalInfo.plan) {
      console.log(
        `There's no plan for ${info.parentType.name}.${info.fieldName}`,
      );
      return {
        [$$batch]: this,
        [$$data]: parentCrystalResult ? parentCrystalResult[$$data] : parent,
        [$$path]: pathIdentity,
      };
    }
    const parentAsCrystalWrapped: CrystalResult | CrystalWrappedData = parentCrystalResult || {[$$data]: parent, [$$batch]: null, [$$path]: null};
    const data = await this.load(crystalInfo, parentAsCrystalWrapped);
    const result = {
      [$$batch]: this,
      [$$data]: data,
      [$$path]: pathIdentity,
    };
    console.log(
      `Executed plan @ ${pathIdentity}; results: ${JSON.stringify(
        data,
        null,
        2,
      )}`,
    );
    return result;
  }

  load<TResultData = unknown, TInputData = unknown>(crystalInfo: Info<TResultData, TInputData>, parent: CrystalWrappedData<TInputData>): Promise<TResultData> {
    if (!crystalInfo.loader) {
      crystalInfo.loader = new Loader(this.crystalContext, crystalInfo);
    }
    return crystalInfo.loader.load(parent);
  }
}
