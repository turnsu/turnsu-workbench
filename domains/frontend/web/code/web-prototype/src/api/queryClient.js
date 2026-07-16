import { QueryClient } from "@tanstack/react-query";

export function createWorkbenchQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry(failureCount, error) {
          return Boolean(error?.retryable) && failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

export const workbenchQueryClient = createWorkbenchQueryClient();
