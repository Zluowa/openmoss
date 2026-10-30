import { createElement } from "react";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";
import { MossLocalizationProvider } from "./localization";
import { StoreProvider } from "./store";
import { reportHandledWebError } from "./observability";

type RouterHistory = NonNullable<Parameters<typeof createRouter>[0]["history"]>;

export function getRouter(history: RouterHistory) {
  const queryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        reportHandledWebError(error, "query", query.queryKey[0]);
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _onMutateResult, mutation) => {
        reportHandledWebError(error, "mutation", mutation.options.mutationKey?.[0]);
      },
    }),
  });

  return createRouter({
    routeTree,
    history,
    // Routes are auto-code-split and have no loaders, so intent preloading only
    // fetches the route chunk on link hover/touch — first navigation skips the
    // chunk download/parse wait.
    defaultPreload: "intent",
    context: {
      queryClient,
    },
    Wrap: ({ children }) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(StoreProvider, null, createElement(MossLocalizationProvider, null, children)),
      ),
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
