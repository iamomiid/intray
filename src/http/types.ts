import type { Principal } from "../core/principal";
import type { Env } from "../env";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    principal: Principal;
  };
}
