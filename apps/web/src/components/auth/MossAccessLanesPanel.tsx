import { MOSS_ACCESS_LANES, type MossAccessLane } from "@synara/shared/mossRealmCatalog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";

import {
  isMossAccessLaneSignedIn,
  MOSS_ACCESS_LANE_COPY,
  mossAccessLaneSummary,
  mossAccessLaneSwitchTarget,
  resolveActiveMossAccessLane,
} from "./mossAccessLanes.logic";
import { mossEnterpriseKeyErrorMessage } from "./mossEnterpriseKey.logic";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossEnterpriseKeyActivateMutationOptions,
  serverMossEnterpriseKeyStateQueryOptions,
  serverMossSelectRealmMutationOptions,
} from "./mossServerReactQuery";

const SIGN_IN_ROUTE: Readonly<
  Record<MossAccessLane, "/login" | "/login/email" | "/login/api-key">
> = {
  cn: "/login",
  global: "/login/email",
  enterprise: "/login/api-key",
};

/**
 * Every sign-in lane with its reach and status. Exactly one lane powers the
 * managed Moss models at a time; switching keeps the other lanes signed in.
 */
export function MossAccessLanesPanel() {
  const queryClient = useQueryClient();
  const phone = useQuery(serverMossAccountSessionQueryOptions());
  const cloud = useQuery(serverMossCloudAccountStateQueryOptions());
  const enterprise = useQuery(serverMossEnterpriseKeyStateQueryOptions());
  const selectRealm = useMutation(serverMossSelectRealmMutationOptions({ queryClient }));
  const activateKey = useMutation(serverMossEnterpriseKeyActivateMutationOptions({ queryClient }));
  const states = { phone: phone.data, cloud: cloud.data, enterprise: enterprise.data };
  const active = resolveActiveMossAccessLane(states);
  const switching = selectRealm.isPending || activateKey.isPending;
  const switchError = selectRealm.error
    ? "无法切换登录方式，请重试。"
    : activateKey.error
      ? mossEnterpriseKeyErrorMessage(activateKey.error)
      : null;

  const switchTo = (lane: MossAccessLane) => {
    const target = mossAccessLaneSwitchTarget(lane);
    if (target.kind === "key") activateKey.mutate();
    else selectRealm.mutate({ realm: target.realm });
  };

  return (
    <section
      aria-labelledby="moss-access-lanes-heading"
      className="rounded-card border border-border/70"
    >
      <header className="px-4 pt-4 pb-2">
        <h2 id="moss-access-lanes-heading" className="text-ui-lg font-medium">
          登录方式
        </h2>
        <p className="mt-1 text-ui-lg leading-6 text-muted-foreground">
          可以同时登录多种方式；同一时间只有一种方式为 Moss 提供模型。
        </p>
      </header>
      <ul className="divide-y divide-border/70">
        {MOSS_ACCESS_LANES.map((lane) => {
          const signedIn = isMossAccessLaneSignedIn(lane, states);
          const isActive = active === lane;
          return (
            <li key={lane} className="flex min-w-0 items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-ui-lg font-medium">
                  {MOSS_ACCESS_LANE_COPY[lane].method}
                  {isActive ? (
                    <span className="rounded-control bg-muted px-1.5 text-ui-sm font-normal text-muted-foreground">
                      使用中
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-ui-sm text-muted-foreground">
                  {mossAccessLaneSummary(lane)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {signedIn && !isActive ? (
                  <Button
                    disabled={switching}
                    onClick={() => switchTo(lane)}
                    size="sm"
                    variant="outline"
                  >
                    切换到此方式
                  </Button>
                ) : null}
                {lane === "enterprise" && signedIn ? (
                  <Button render={<Link to="/login/api-key" />} size="sm" variant="ghost">
                    管理
                  </Button>
                ) : null}
                {lane === "global" && signedIn ? (
                  <Button
                    render={<Link search={{ accountView: "google" }} to="/account" />}
                    size="sm"
                    variant="ghost"
                  >
                    管理
                  </Button>
                ) : null}
                {!signedIn ? (
                  <Button render={<Link to={SIGN_IN_ROUTE[lane]} />} size="sm" variant="ghost">
                    登录
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {switchError ? (
        <div className="px-4 pb-4">
          <Alert role="alert" variant="error">
            <AlertDescription>{switchError}</AlertDescription>
          </Alert>
        </div>
      ) : null}
    </section>
  );
}
