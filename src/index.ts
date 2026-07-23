import * as core from "@actions/core";

// Phase 0 stub — wires up action.yml to a real entry point so the action is
// runnable end to end, without any pipeline logic behind it yet.
async function run(): Promise<void> {
  const step = core.getInput("step", { required: true });
  core.info(`Repovate — step "${step}" is not implemented yet (Phase 0 scaffold).`);
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
