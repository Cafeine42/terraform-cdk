import { SynthesizedStack } from "./synth-stack";
import { Terraform, TerraformPlan } from "./models/terraform";
import { getConstructIdsForOutputs, NestedTerraformOutputs } from "./output";
import { logger } from "./logging";
import { extractJsonLogIfPresent } from "./server/terraform-logs";
import { TerraformJson } from "./terraform-json";
import { TerraformCloud } from "./models/terraform-cloud";
import { TerraformCli } from "./models/terraform-cli";

export type StackUpdate =
  | {
      type: "planning";
      stackName: string;
    }
  | {
      type: "planned";
      stackName: string;
      plan: TerraformPlan;
    }
  | {
      type: "deploying";
      stackName: string;
    }
  | {
      type: "deploy update";
      stackName: string;
      deployOutput: string;
    }
  | {
      type: "deployed";
      stackName: string;
      outputsByConstructId: NestedTerraformOutputs;
      outputs: Record<string, any>;
    }
  | {
      type: "destroying";
      stackName: string;
    }
  | {
      type: "destroy update";
      stackName: string;
      destroyOutput: string;
    }
  | {
      type: "destroyed";
      stackName: string;
    }
  | {
      type: "outputs fetched";
      stackName: string;
      outputsByConstructId: NestedTerraformOutputs;
      outputs: Record<string, any>;
    }
  | {
      type: "errored";
      stackName: string;
      error: string;
    }
  | {
      type: "dismissed";
      stackName: string;
    };

export type StackApprovalUpdate = {
  type: "waiting for stack approval";
  stackName: string;
  plan: TerraformPlan;
  approve: () => void;
  reject: () => void;
};

async function getTerraformClient(
  abortSignal: AbortSignal,
  stack: SynthesizedStack,
  isSpeculative: boolean,
  sendLog: (stateName: string) => (message: string, isError?: boolean) => void
): Promise<Terraform> {
  const parsedStack = JSON.parse(stack.content) as TerraformJson;

  if (parsedStack.terraform?.backend?.remote) {
    const tfClient = new TerraformCloud(
      abortSignal,
      stack,
      parsedStack.terraform.backend.remote,
      isSpeculative,
      sendLog
    );
    if (await tfClient.isRemoteWorkspace()) {
      return tfClient;
    }
  }
  return new TerraformCli(abortSignal, stack, sendLog);
}

type CdktfStackOptions = {
  stack: SynthesizedStack;
  onUpdate: (update: StackUpdate | StackApprovalUpdate) => void;
  onLog?: (log: { message: string; isError: boolean }) => void;
  autoApprove?: boolean;
  abortSignal: AbortSignal;
};
export class CdktfStack {
  public stackName: string;
  public currentPlan?: TerraformPlan;
  public stack: SynthesizedStack;
  public outputs?: Record<string, any>;
  public outputsByConstructId?: NestedTerraformOutputs;
  public stopped = false;
  public currentWorkPromise: Promise<void> | undefined;
  public currentState:
    | StackUpdate["type"]
    | StackApprovalUpdate["type"]
    | "idle"
    | "done"
    | "error" = "idle";

  constructor(public context: CdktfStackOptions) {
    this.stackName = context.stack.name;
    this.stack = context.stack;
  }

  public get isPending(): boolean {
    return this.currentState === "idle" && !this.stopped;
  }
  public get isDone(): boolean {
    return (
      this.currentState === "done" ||
      this.currentState === "error" ||
      this.stopped
    );
  }
  public get isRunning(): boolean {
    return !this.isPending && !this.isDone;
  }

  private notifyState(
    update:
      | StackUpdate
      | StackApprovalUpdate
      | { type: "idle" }
      | { type: "done" }
      | { type: "error" }
  ) {
    logger.debug(`[${this.stackName}]: ${update.type}`);
    this.currentState = update.type;
    switch (update.type) {
      case "idle":
      case "done":
      case "error":
        break;

      case "outputs fetched":
      case "deployed":
        logger.debug(`Outputs: ${JSON.stringify(update.outputs)}`);
        logger.debug(
          `OutputsByConstructId: ${JSON.stringify(update.outputsByConstructId)}`
        );
        this.outputs = update.outputs;
        this.outputsByConstructId = update.outputsByConstructId;
        this.context.onUpdate(update);
        break;

      default:
        this.context.onUpdate(update);
        break;
    }
  }

  private logCallback(
    stateName: string
  ): (message: string, isError?: boolean) => void {
    const onLog = this.context.onLog;
    return (msg: string, isError = false) => {
      const message = extractJsonLogIfPresent(msg);
      logger.debug(`[${this.context.stack.name}](${stateName}): ${msg}`);
      if (onLog) {
        onLog({ message, isError });
      }
    };
  }

  private waitForApproval(plan: TerraformPlan) {
    return new Promise<boolean>((resolve) => {
      this.notifyState({
        type: "waiting for stack approval",
        stackName: this.stack.name,
        plan: plan,
        approve: () => {
          resolve(true);
        },
        reject: () => {
          resolve(false);
        },
      });
    });
  }

  private async initalizeTerraform({
    isSpeculative,
  }: {
    isSpeculative: boolean;
  }) {
    const terraform = await getTerraformClient(
      this.context.abortSignal,
      this.context.stack,
      isSpeculative,
      this.logCallback.bind(this)
    );

    await terraform.init();

    return terraform;
  }

  private async handleState(cb: () => Promise<void>) {
    if (this.stopped) {
      return;
    }

    try {
      this.currentWorkPromise = cb();
      await this.currentWorkPromise;
      this.notifyState({ type: "done" });
    } catch (e) {
      this.currentWorkPromise = undefined;
      this.notifyState({
        type: "errored",
        stackName: this.stack.name,
        error: String(e),
      });
    }
    this.currentWorkPromise = undefined;
  }

  public async diff() {
    await this.handleState(async () => {
      this.notifyState({ type: "planning", stackName: this.stack.name });
      const terraform = await this.initalizeTerraform({ isSpeculative: false });

      const plan = await terraform.plan(false);
      this.currentPlan = plan;
      this.notifyState({ type: "planned", stackName: this.stack.name, plan });
    });
  }

  public async deploy() {
    await this.handleState(async () => {
      this.notifyState({ type: "planning", stackName: this.stack.name });
      const terraform = await this.initalizeTerraform({ isSpeculative: false });

      const plan = await terraform.plan(false);
      this.notifyState({ type: "planned", stackName: this.stack.name, plan });

      const approved = this.context.autoApprove
        ? true
        : await this.waitForApproval(plan);

      if (!approved) {
        this.notifyState({ type: "dismissed", stackName: this.stack.name });
        return;
      }

      this.notifyState({ type: "deploying", stackName: this.stack.name });
      if (plan.needsApply) {
        await terraform.deploy(plan.planFile);
      }

      const outputs = await terraform.output();
      const outputsByConstructId = getConstructIdsForOutputs(
        JSON.parse(this.stack.content),
        outputs
      );

      this.notifyState({
        type: "deployed",
        stackName: this.stack.name,
        outputs,
        outputsByConstructId,
      });
    });
  }

  public async destroy() {
    await this.handleState(async () => {
      this.notifyState({ type: "planning", stackName: this.stack.name });
      const terraform = await this.initalizeTerraform({ isSpeculative: false });

      const plan = await terraform.plan(true);
      this.notifyState({ type: "planned", stackName: this.stack.name, plan });

      const approved = this.context.autoApprove
        ? true
        : await this.waitForApproval(plan);
      if (!approved) {
        this.notifyState({ type: "dismissed", stackName: this.stack.name });
        return;
      }

      this.notifyState({ type: "destroying", stackName: this.stack.name });
      await terraform.destroy();

      this.notifyState({
        type: "destroyed",
        stackName: this.stack.name,
      });
    });
  }

  public async fetchOutputs() {
    await this.handleState(async () => {
      const terraform = await this.initalizeTerraform({ isSpeculative: false });

      const outputs = await terraform.output();
      const outputsByConstructId = getConstructIdsForOutputs(
        JSON.parse(this.stack.content),
        outputs
      );
      this.notifyState({
        type: "outputs fetched",
        stackName: this.stack.name,
        outputs,
        outputsByConstructId,
      });
    });

    return this.outputs;
  }

  public async stop() {
    this.stopped = true;
  }
}
