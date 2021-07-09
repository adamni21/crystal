import type { CrystalResultsList, CrystalValuesList } from "graphile-crystal";
import { list, object } from "graphile-crystal";
import { ExecutablePlan } from "graphile-crystal";

import type { PgDataSource } from "../datasource";
import { PgClassSelectSinglePlan } from "./pgClassSelectSingle";

export class PgCursorPlan<
  TDataSource extends PgDataSource<any, any>,
> extends ExecutablePlan<any> {
  private cursorValuesPlanId: number;
  private classSinglePlanId: number;
  constructor(itemPlan: PgClassSelectSinglePlan<any>) {
    super();
    const classPlan = itemPlan.getClassPlan();
    this.classSinglePlanId = itemPlan.id;
    const orders = classPlan.getOrderBy();
    const plan = list(
      orders.map((o) => itemPlan.expression(o.fragment, o.codec)),
    );
    this.cursorValuesPlanId = this.addDependency(plan);
  }

  public getClassSinglePlan(): PgClassSelectSinglePlan<TDataSource> {
    const plan = this.aether.plans[this.classSinglePlanId];
    if (!(plan instanceof PgClassSelectSinglePlan)) {
      throw new Error(
        `Expected ${this.classSinglePlanId} (${plan}) to be a PgClassSelectSinglePlan`,
      );
    }
    return plan;
  }

  execute(
    values: CrystalValuesList<ReadonlyArray<any>>,
  ): CrystalResultsList<string> {
    return values.map((value) =>
      Buffer.from(
        JSON.stringify(["TODO", ...value[this.cursorValuesPlanId]]),
        "utf8",
      ).toString("base64"),
    );
  }
}
